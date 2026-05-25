use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

#[derive(Serialize)]
struct FileInfo {
    name: String,
    is_dir: bool,
    path: String,
}

struct TerminalProcess {
    child: Arc<Mutex<Child>>,
}

static TERMINAL_PROCESS: OnceLock<Mutex<Option<TerminalProcess>>> = OnceLock::new();

fn terminal_process() -> &'static Mutex<Option<TerminalProcess>> {
    TERMINAL_PROCESS.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
fn read_dir(path: &str) -> Result<Vec<FileInfo>, String> {
    let mut files = Vec::new();
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    for entry in entries {
        if let Ok(entry) = entry {
            let path_buf = entry.path();
            let name = entry.file_name().into_string().unwrap_or_default();
            let is_dir = path_buf.is_dir();
            let path_str = path_buf.to_string_lossy().to_string();
            files.push(FileInfo {
                name,
                is_dir,
                path: path_str,
            });
        }
    }
    files.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(files)
}

#[tauri::command]
fn read_file(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_file(path: &str, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_deno_types() -> Result<String, String> {
    let output = std::process::Command::new("deno")
        .arg("types")
        .output()
        .map_err(|e| e.to_string())?;
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

#[tauri::command]
fn run_deno(app: tauri::AppHandle, path: &str, inspect: bool) -> Result<(), String> {
    use std::io::BufRead;
    use tauri::Emitter;

    let mut cmd = Command::new("deno");
    cmd.arg("run").arg("-A");
    if inspect {
        cmd.arg("--inspect-brk");
    }
    cmd.arg(path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(l) = line {
                let _ = app_clone.emit("deno-output", l);
            }
        }
    });

    let app_clone2 = app.clone();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                if inspect && l.starts_with("Debugger listening on ws://") {
                    let url = l.replace("Debugger listening on ", "");
                    let _ = app_clone2.emit("debugger-ws-url", url);
                }
                let _ = app_clone2.emit("deno-output", format!("ERROR: {}", l));
            }
        }
    });

    Ok(())
}

fn parse_deno_command(command: &str) -> Result<Vec<String>, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Enter a deno command.".to_string());
    }

    if trimmed
        .chars()
        .any(|c| matches!(c, ';' | '&' | '|' | '<' | '>' | '`'))
    {
        return Err("Shell operators are disabled. Run one deno command at a time.".to_string());
    }

    let mut args = Vec::new();
    let mut current = String::new();
    let mut chars = trimmed.chars().peekable();
    let mut quote: Option<char> = None;

    while let Some(ch) = chars.next() {
        match (ch, quote) {
            ('\'' | '"', None) => quote = Some(ch),
            (c, Some(q)) if c == q => quote = None,
            ('\\', Some('"')) => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            (c, None) if c.is_whitespace() => {
                if !current.is_empty() {
                    args.push(current);
                    current = String::new();
                }
            }
            (c, _) => current.push(c),
        }
    }

    if quote.is_some() {
        return Err("Unclosed quote in command.".to_string());
    }

    if !current.is_empty() {
        args.push(current);
    }

    if args.first().map(|arg| arg.as_str()) != Some("deno") {
        return Err("Only deno commands are allowed. Try: deno run main.ts".to_string());
    }

    Ok(args)
}

fn emit_reader<R>(app: tauri::AppHandle, mut reader: R, is_stderr: bool)
where
    R: Read + Send + 'static,
{
    use tauri::Emitter;

    std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let payload = if is_stderr {
                        format!("\x1b[31m{}\x1b[0m", text)
                    } else {
                        text
                    };
                    let _ = app.emit("terminal-output", payload);
                }
                Err(_) => break,
            }
        }
    });
}

#[tauri::command]
fn run_terminal_command(app: tauri::AppHandle, command: &str) -> Result<(), String> {
    use tauri::Emitter;

    let args = parse_deno_command(command)?;
    let mut state = terminal_process().lock().map_err(|e| e.to_string())?;

    if let Some(process) = state.as_ref() {
        if process
            .child
            .lock()
            .map_err(|e| e.to_string())?
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Err(
                "A Deno command is already running. Stop it before starting another.".to_string(),
            );
        }
    }

    let mut child = Command::new(&args[0])
        .args(&args[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start deno: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        emit_reader(app.clone(), stdout, false);
    }

    if let Some(stderr) = child.stderr.take() {
        emit_reader(app.clone(), stderr, true);
    }

    let child = Arc::new(Mutex::new(child));
    *state = Some(TerminalProcess {
        child: Arc::clone(&child),
    });
    drop(state);

    std::thread::spawn(move || loop {
        let status_result = {
            let mut child = match child.lock() {
                Ok(child) => child,
                Err(_) => break,
            };
            child.try_wait()
        };

        match status_result {
            Ok(Some(status)) => {
                let code = status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "terminated".to_string());
                let _ = app.emit(
                    "terminal-output",
                    format!("\r\n[deno exited with {code}]\r\n"),
                );
                let _ = app.emit("terminal-exit", code);

                if let Ok(mut state) = terminal_process().lock() {
                    if let Some(process) = state.as_ref() {
                        if Arc::ptr_eq(&process.child, &child) {
                            *state = None;
                        }
                    }
                }
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                let _ = app.emit("terminal-output", format!("\r\n\x1b[31m{error}\x1b[0m\r\n"));
                let _ = app.emit("terminal-exit", "error");
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn send_terminal_input(data: &str) -> Result<(), String> {
    let mut state = terminal_process().lock().map_err(|e| e.to_string())?;
    let Some(process) = state.as_mut() else {
        return Err("No Deno process is running.".to_string());
    };

    let mut child = process.child.lock().map_err(|e| e.to_string())?;
    let Some(stdin) = child.stdin.as_mut() else {
        return Err("The running Deno process is not accepting input.".to_string());
    };

    stdin
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_terminal_command() -> Result<(), String> {
    let mut state = terminal_process().lock().map_err(|e| e.to_string())?;
    let Some(process) = state.take() else {
        return Ok(());
    };

    let mut child = process.child.lock().map_err(|e| e.to_string())?;
    child.kill().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_dir,
            read_file,
            save_file,
            get_deno_types,
            run_deno,
            run_terminal_command,
            send_terminal_input,
            stop_terminal_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
