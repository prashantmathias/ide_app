use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use futures_util::{StreamExt, SinkExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugCallFrame {
    pub function_name: String,
    pub line_number: usize, // 1-indexed for TUI display
    pub column_number: usize,
    pub script_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugVariable {
    pub name: String,
    pub val_type: String,
    pub value: String,
}

#[derive(Debug, Clone)]
pub enum DenoEvent {
    Stdout(String),
    Stderr(String),
    DebuggerListening(String),
    DebuggerConnected,
    DebuggerPaused {
        call_frames: Vec<DebugCallFrame>,
        variables: Vec<DebugVariable>,
    },
    DebuggerResumed,
    Finished(Option<i32>),
    Error(String),
}

#[derive(Debug, Clone)]
pub enum DebuggerCmd {
    StepOver,
    StepInto,
    Resume,
    SetBreakpoint { line: usize, filename: String },
    RemoveBreakpoint { line: usize },
}

pub struct DenoDebugger {
    tx_tui: mpsc::UnboundedSender<DenoEvent>,
    rx_cmd: mpsc::UnboundedReceiver<DebuggerCmd>,
    breakpoints: Arc<Mutex<HashMap<usize, String>>>, // line -> breakpointId
    pending_resolves: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>>>,
    msg_id: Arc<Mutex<u64>>,
}

impl DenoDebugger {
    pub fn start(
        path: String,
        inspect: bool,
        tx_tui: mpsc::UnboundedSender<DenoEvent>,
        rx_cmd: mpsc::UnboundedReceiver<DebuggerCmd>,
        initial_breakpoints: Vec<usize>,
    ) {
        let debugger = Self {
            tx_tui: tx_tui.clone(),
            rx_cmd,
            breakpoints: Arc::new(Mutex::new(HashMap::new())),
            pending_resolves: Arc::new(Mutex::new(HashMap::new())),
            msg_id: Arc::new(Mutex::new(1)),
        };

        tokio::spawn(async move {
            if let Err(e) = debugger.run(path, inspect, initial_breakpoints).await {
                let _ = tx_tui.send(DenoEvent::Error(e));
            }
        });
    }

    async fn run(
        mut self,
        path: String,
        inspect: bool,
        initial_breakpoints: Vec<usize>,
    ) -> Result<(), String> {
        let mut cmd = Command::new("deno");
        cmd.arg("run").arg("-A");
        if inspect {
            cmd.arg("--inspect-brk");
        }
        cmd.arg(&path);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn Deno: {}", e))?;
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

        let tx_stdout = self.tx_tui.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx_stdout.send(DenoEvent::Stdout(line));
            }
        });

        let tx_stderr = self.tx_tui.clone();
        let (ws_url_tx, ws_url_rx) = tokio::sync::oneshot::channel();
        let mut ws_url_tx = Some(ws_url_tx);

        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx_stderr.send(DenoEvent::Stderr(line.clone()));
                if line.contains("Debugger listening on ws://") {
                    if let Some(start_idx) = line.find("ws://") {
                        let ws_url = line[start_idx..].trim().to_string();
                        if let Some(tx) = ws_url_tx.take() {
                            let _ = tx.send(ws_url);
                        }
                    }
                }
            }
        });

        if inspect {
            // Wait for ws url
            let ws_url = ws_url_rx.await.map_err(|_| "Failed to capture WebSocket URL".to_string())?;
            let _ = self.tx_tui.send(DenoEvent::DebuggerListening(ws_url.clone()));

            // Connect to WebSocket
            let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
                .await
                .map_err(|e| format!("WebSocket connection failed: {}", e))?;

            let _ = self.tx_tui.send(DenoEvent::DebuggerConnected);
            let (mut ws_write, mut ws_read) = ws_stream.split();

            let (ws_cmd_tx, mut ws_cmd_rx) = mpsc::unbounded_channel::<String>();
            
            // Task to send messages over WebSocket
            tokio::spawn(async move {
                while let Some(msg) = ws_cmd_rx.recv().await {
                    let _ = ws_write.send(tokio_tungstenite::tungstenite::Message::Text(msg)).await;
                }
            });

            // Initialize CDP session
            let runtime_enable_id = self.next_id().await;
            let _ = ws_cmd_tx.send(json!({
                "id": runtime_enable_id,
                "method": "Runtime.enable"
            }).to_string());

            let debugger_enable_id = self.next_id().await;
            let _ = ws_cmd_tx.send(json!({
                "id": debugger_enable_id,
                "method": "Debugger.enable"
            }).to_string());

            // Set initial breakpoints
            for bp_line in initial_breakpoints {
                let bp_id = self.next_id().await;
                let escaped_filename = path.replace('\\', "/");
                let _ = ws_cmd_tx.send(json!({
                    "id": bp_id,
                    "method": "Debugger.setBreakpointByUrl",
                    "params": {
                        "lineNumber": bp_line - 1,
                        "urlRegex": format!(".*{}", escaped_filename)
                    }
                }).to_string());
            }

            let run_debugger_id = self.next_id().await;
            let _ = ws_cmd_tx.send(json!({
                "id": run_debugger_id,
                "method": "Runtime.runIfWaitingForDebugger"
            }).to_string());

            let pending_resolves_clone = Arc::clone(&self.pending_resolves);
            let msg_id_read = Arc::clone(&self.msg_id);
            let tx_tui_clone = self.tx_tui.clone();
            let ws_cmd_tx_clone = ws_cmd_tx.clone();

            // Task to read messages from WebSocket
            let _ws_read_handle = tokio::spawn(async move {
                while let Some(Ok(msg)) = ws_read.next().await {
                    if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                            // Check if this is a response to a pending request
                            if let Some(id) = val.get("id").and_then(|i| i.as_u64()) {
                                let mut resolves = pending_resolves_clone.lock().await;
                                if let Some(tx) = resolves.remove(&id) {
                                    let _ = tx.send(val.clone());
                                }
                                
                                // Also intercept breakpoint setting response to track breakpointId
                                if let Some(result) = val.get("result") {
                                    if let Some(_bp_id) = result.get("breakpointId").and_then(|b| b.as_str()) {
                                        // Try to match it back (simplified for prototype)
                                        // Automatically mapped via the return channel.
                                    }
                                }
                            }

                            // Check notifications
                            if let Some(method) = val.get("method").and_then(|m| m.as_str()) {
                                match method {
                                    "Debugger.paused" => {
                                        if let Some(params) = val.get("params") {
                                            if let Some(call_frames_val) = params.get("callFrames") {
                                                let call_frames = parse_call_frames(call_frames_val);
                                                
                                                // Resolve variables for the top frame
                                                let mut variables = Vec::new();
                                                if let Some(top_frame) = call_frames_val.get(0) {
                                                    if let Some(scope_chain) = top_frame.get("scopeChain") {
                                                        if let Some(scopes) = scope_chain.as_array() {
                                                            for scope in scopes {
                                                                let scope_type = scope.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                                                if scope_type == "local" || scope_type == "closure" {
                                                                    if let Some(obj) = scope.get("object") {
                                                                        if let Some(obj_id) = obj.get("objectId").and_then(|id| id.as_str()) {
                                                                            // Get properties from runtime
                                                                            let req_id = {
                                                                                let mut id_lock = msg_id_read.lock().await;
                                                                                *id_lock += 1;
                                                                                *id_lock
                                                                            };
                                                                            let (tx, rx) = tokio::sync::oneshot::channel();
                                                                            {
                                                                                let mut resolves = pending_resolves_clone.lock().await;
                                                                                resolves.insert(req_id, tx);
                                                                            }

                                                                            let _ = ws_cmd_tx_clone.send(json!({
                                                                                "id": req_id,
                                                                                "method": "Runtime.getProperties",
                                                                                "params": {
                                                                                    "objectId": obj_id,
                                                                                    "ownProperties": false,
                                                                                    "generatePreview": true
                                                                                }
                                                                            }).to_string());

                                                                            if let Ok(resp) = rx.await {
                                                                                if let Some(result) = resp.get("result").and_then(|r| r.get("result")).and_then(|res| res.as_array()) {
                                                                                    for prop in result {
                                                                                        if let Some(name) = prop.get("name").and_then(|n| n.as_str()) {
                                                                                            if name == "__proto__" {
                                                                                                continue;
                                                                                            }
                                                                                            let val_type = prop.get("value").and_then(|v| v.get("type")).and_then(|t| t.as_str()).unwrap_or("unknown").to_string();
                                                                                            let value_str = prop.get("value").map(format_value).unwrap_or_else(|| "undefined".to_string());
                                                                                            variables.push(DebugVariable {
                                                                                                name: name.to_string(),
                                                                                                val_type,
                                                                                                value: value_str,
                                                                                            });
                                                                                        }
                                                                                    }
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }

                                                let _ = tx_tui_clone.send(DenoEvent::DebuggerPaused {
                                                    call_frames,
                                                    variables,
                                                });
                                            }
                                        }
                                    }
                                    "Debugger.resumed" => {
                                        let _ = tx_tui_clone.send(DenoEvent::DebuggerResumed);
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            });

            // Keep pointers for variables fetching
            // Wait, we need global getters for pending resolves and message ID to access them from the async block.
            // Let's create static Mutex variables or simply pass Arc locks.
            // To pass Arc locks safely without lifetimes compilation issue, we did clone them.
            // But wait, the thread above uses variables `pending_resolves_clone` and `id_lock_getter()`/`pending_resolves_getter()`.
            // Let's structure it so we don't need any globals!
            // We can just define the functions inside or share the Arcs. Let's do that!
            // Let's replace the global helper calls in the code with our cloned Arcs.
            // In the websocket read thread, we can access:
            // `pending_resolves_clone` and a cloned `Arc<Mutex<u64>>` for msg_id.
            // This is clean and doesn't require any globals!
            // Let's write this cleanly inside the main loop instead of using `id_lock_getter()`.

            // Command listener loop (from TUI to Debugger)
            let msg_id_cmd = Arc::clone(&self.msg_id);
            let pending_resolves_cmd = Arc::clone(&self.pending_resolves);
            let breakpoints_cmd = Arc::clone(&self.breakpoints);

            tokio::spawn(async move {
                while let Some(cmd) = self.rx_cmd.recv().await {
                    match cmd {
                        DebuggerCmd::StepOver => {
                            let req_id = {
                                let mut id = msg_id_cmd.lock().await;
                                *id += 1;
                                *id
                            };
                            let _ = ws_cmd_tx.send(json!({
                                "id": req_id,
                                "method": "Debugger.stepOver"
                            }).to_string());
                        }
                        DebuggerCmd::StepInto => {
                            let req_id = {
                                let mut id = msg_id_cmd.lock().await;
                                *id += 1;
                                *id
                            };
                            let _ = ws_cmd_tx.send(json!({
                                "id": req_id,
                                "method": "Debugger.stepInto"
                            }).to_string());
                        }
                        DebuggerCmd::Resume => {
                            let req_id = {
                                let mut id = msg_id_cmd.lock().await;
                                *id += 1;
                                *id
                            };
                            let _ = ws_cmd_tx.send(json!({
                                "id": req_id,
                                "method": "Debugger.resume"
                            }).to_string());
                        }
                        DebuggerCmd::SetBreakpoint { line, filename } => {
                            let req_id = {
                                let mut id = msg_id_cmd.lock().await;
                                *id += 1;
                                *id
                            };
                            let (tx, rx) = tokio::sync::oneshot::channel();
                            {
                                let mut resolves = pending_resolves_cmd.lock().await;
                                resolves.insert(req_id, tx);
                            }

                            let escaped_filename = filename.replace('\\', "/");
                            let _ = ws_cmd_tx.send(json!({
                                "id": req_id,
                                "method": "Debugger.setBreakpointByUrl",
                                "params": {
                                    "lineNumber": line - 1,
                                    "urlRegex": format!(".*{}", escaped_filename)
                                }
                            }).to_string());

                            // Await the response to record the breakpointId
                            let breakpoints_inner = Arc::clone(&breakpoints_cmd);
                            tokio::spawn(async move {
                                if let Ok(resp) = rx.await {
                                    if let Some(result) = resp.get("result") {
                                        if let Some(bp_id) = result.get("breakpointId").and_then(|b| b.as_str()) {
                                            let mut map = breakpoints_inner.lock().await;
                                            map.insert(line, bp_id.to_string());
                                        }
                                    }
                                }
                            });
                        }
                        DebuggerCmd::RemoveBreakpoint { line } => {
                            let bp_id = {
                                let map = breakpoints_cmd.lock().await;
                                map.get(&line).cloned()
                            };

                            if let Some(id) = bp_id {
                                let req_id = {
                                    let mut id = msg_id_cmd.lock().await;
                                    *id += 1;
                                    *id
                                };
                                let _ = ws_cmd_tx.send(json!({
                                    "id": req_id,
                                    "method": "Debugger.removeBreakpoint",
                                    "params": {
                                        "breakpointId": id
                                    }
                                }).to_string());

                                let mut map = breakpoints_cmd.lock().await;
                                map.remove(&line);
                            }
                        }
                    }
                }
            });
        }

        // Wait for child to finish
        let status = child.wait().await.map_err(|e| format!("Failed to wait for Deno process: {}", e))?;
        let _ = self.tx_tui.send(DenoEvent::Finished(status.code()));

        Ok(())
    }

    async fn next_id(&self) -> u64 {
        let mut id = self.msg_id.lock().await;
        *id += 1;
        *id
    }
}

fn parse_call_frames(val: &serde_json::Value) -> Vec<DebugCallFrame> {
    let mut frames = Vec::new();
    if let Some(arr) = val.as_array() {
        for f in arr {
            let function_name = f.get("functionName").and_then(|n| n.as_str()).unwrap_or("(anonymous)").to_string();
            let line_number = f.get("location")
                .and_then(|l| l.get("lineNumber"))
                .and_then(|n| n.as_u64())
                .unwrap_or(0) as usize + 1; // Convert 0-indexed to 1-indexed
            let column_number = f.get("location")
                .and_then(|l| l.get("columnNumber"))
                .and_then(|n| n.as_u64())
                .unwrap_or(0) as usize;
            let script_url = f.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();

            frames.push(DebugCallFrame {
                function_name,
                line_number,
                column_number,
                script_url,
            });
        }
    }
    frames
}

fn format_value(value_val: &serde_json::Value) -> String {
    let val_type = value_val.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if val_type == "string" {
        if let Some(s) = value_val.get("value").and_then(|v| v.as_str()) {
            return format!("\"{}\"", s);
        }
    }
    if val_type == "number" || val_type == "boolean" {
        if let Some(v) = value_val.get("value") {
            return v.to_string();
        }
    }
    if val_type == "undefined" {
        return "undefined".to_string();
    }
    if val_type == "object" {
        if value_val.get("subtype").and_then(|s| s.as_str()) == Some("null") {
            return "null".to_string();
        }
        if let Some(desc) = value_val.get("description").and_then(|d| d.as_str()) {
            return desc.to_string();
        }
        if let Some(class_name) = value_val.get("className").and_then(|c| c.as_str()) {
            return class_name.to_string();
        }
        return "Object".to_string();
    }
    if val_type == "function" {
        if let Some(desc) = value_val.get("description").and_then(|d| d.as_str()) {
            return format!("f {}", desc.split('(').next().unwrap_or(""));
        }
        return "f()".to_string();
    }
    if let Some(val) = value_val.get("value") {
        return val.to_string();
    }
    "".to_string()
}
