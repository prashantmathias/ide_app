use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

#[derive(Serialize)]
struct FileInfo {
    name: String,
    is_dir: bool,
    path: String,
}

struct TerminalProcess {
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
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

fn command_available(command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Windows often exposes a WSL `bash` stub that passes `--version` but cannot run in a PTY.
#[cfg(windows)]
fn windows_usable_bash() -> bool {
    command_available("bash", &["-c", "exit 0"])
}

fn default_shell_command() -> CommandBuilder {
    #[cfg(windows)]
    {
        if command_available("pwsh", &["-NoLogo", "-Command", "exit 0"]) {
            let mut cmd = CommandBuilder::new("pwsh");
            cmd.arg("-NoLogo");
            return cmd;
        }

        if windows_usable_bash() {
            let mut cmd = CommandBuilder::new("bash");
            cmd.arg("-i");
            return cmd;
        }

        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        cmd.arg("-NoExit");
        cmd
    }

    #[cfg(not(windows))]
    {
        if command_available("bash", &["--version"]) {
            let mut cmd = CommandBuilder::new("bash");
            cmd.arg("-i");
            return cmd;
        }

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-i");
        cmd
    }
}

#[tauri::command]
fn start_terminal_shell(app: tauri::AppHandle, rows: u16, cols: u16) -> Result<(), String> {
    use tauri::Emitter;

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
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = default_shell_command();
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = Arc::new(Mutex::new(child));
    let master = Arc::new(Mutex::new(pair.master));

    emit_reader(app.clone(), reader, false);

    *state = Some(TerminalProcess {
        child: Arc::clone(&child),
        master,
        writer: Arc::new(Mutex::new(writer)),
    });
    drop(state);

    let _ = app.emit("terminal-ready", ());
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
                let code = status.exit_code().to_string();
                let _ = app.emit(
                    "terminal-output",
                    format!("\r\n[shell exited with {code}]\r\n"),
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
        return Err("No shell is running.".to_string());
    };

    let mut writer = process.writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_terminal(rows: u16, cols: u16) -> Result<(), String> {
    let state = terminal_process().lock().map_err(|e| e.to_string())?;
    let Some(process) = state.as_ref() else {
        return Ok(());
    };

    let master = process.master.lock().map_err(|e| e.to_string())?;
    master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(path: &str) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn install_npm_package(package_name: &str) -> Result<String, String> {
    let npm_cmd = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let output = std::process::Command::new(npm_cmd)
        .arg("install")
        .arg(package_name)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
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
            start_terminal_shell,
            send_terminal_input,
            resize_terminal,
            stop_terminal_command,
            delete_file,
            install_npm_package
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
