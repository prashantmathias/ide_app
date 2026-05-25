use std::fs;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct FileInfo {
    name: String,
    is_dir: bool,
    path: String,
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
            files.push(FileInfo { name, is_dir, path: path_str });
        }
    }
    files.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
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

    let mut cmd = std::process::Command::new("deno");
    cmd.arg("run").arg("-A");
    if inspect {
        cmd.arg("--inspect-brk");
    }
    cmd.arg(path);
    cmd.stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::piped());

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_dir, read_file, save_file, get_deno_types, run_deno])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
