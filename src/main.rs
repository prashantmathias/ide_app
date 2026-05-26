mod debugger;
mod editor;
mod main_state;
mod ui;

use crate::debugger::{DenoDebugger, DenoEvent, DebuggerCmd};
use crate::main_state::{AppMode, AppState, BottomTab, FocusPanel};
use crate::ui::draw_ui;

use std::io;
use std::time::{Duration, SystemTime};
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use tokio::sync::mpsc;

enum TuiEvent {
    Key(crossterm::event::KeyEvent),
    Deno(DenoEvent),
    Tick,
}

#[tokio::main]
async fn main() -> Result<(), io::Error> {
    // 1. Setup Terminal alternate screen and raw mode
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    
    // Set panic hook to ensure terminal reset on crash
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let mut out = io::stdout();
        let _ = execute!(out, LeaveAlternateScreen);
        default_panic(info);
    }));

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // 2. Initialize App State
    let mut state = AppState::new();
    state.read_workspace_dir();

    // Load default file (main.ts if exists, or first file)
    let default_file = if std::path::Path::new("main.ts").exists() {
        Some("main.ts".to_string())
    } else {
        state.explorer_items.iter()
            .find(|item| !item.is_dir)
            .map(|item| item.name.clone())
    };

    if let Some(ref file) = default_file {
        if let Err(e) = state.editor.load(file) {
            state.log(format!("Error loading startup file: {}", e));
        } else {
            state.log(format!("Loaded startup file: {}", file));
        }
    }

    // 3. Channels for Event Processing
    let (tx_tui, mut rx_tui) = mpsc::unbounded_channel::<TuiEvent>();
    
    // Key event thread
    let tx_key = tx_tui.clone();
    std::thread::spawn(move || {
        loop {
            if event::poll(Duration::from_millis(100)).unwrap() {
                if let Event::Key(key) = event::read().unwrap() {
                    // Only process key Press events (avoid double trigger on Windows release/repeat)
                    if key.kind == KeyEventKind::Press {
                        let _ = tx_key.send(TuiEvent::Key(key));
                    }
                }
            }
        }
    });

    // Time ticker task
    let tx_tick = tx_tui.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        loop {
            interval.tick().await;
            let _ = tx_tick.send(TuiEvent::Tick);
        }
    });

    // Debugger command channel
    let mut tx_debugger_cmd: Option<mpsc::UnboundedSender<DebuggerCmd>> = None;

    state.log("IDE Ready. Press F9 to Run, F5 to Debug, v to browse files.");

    // 4. Main Event Loop
    loop {
        // Format local clock (UTC + 1 offset for user environment)
        if let Ok(duration) = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
            let secs = duration.as_secs();
            let hours = (secs / 3600 + 1) % 24;
            let mins = (secs / 60) % 60;
            let seconds = secs % 60;
            state.time_string = format!("{:02}:{:02}:{:02}", hours, mins, seconds);
        }

        // Draw Frame
        terminal.draw(|f| draw_ui(f, &mut state))?;

        // Read event
        tokio::select! {
            Some(event) = rx_tui.recv() => {
                match event {
                    TuiEvent::Tick => {
                        // Tick event triggers redraw and updates clock
                    }
                    TuiEvent::Deno(deno_event) => {
                        match deno_event {
                            DenoEvent::Stdout(line) => {
                                state.output(line);
                            }
                            DenoEvent::Stderr(line) => {
                                // Strip debugging headers or print normally
                                if !line.contains("Debugger listening on ws://") {
                                    state.output(format!("ERR: {}", line));
                                }
                            }
                            DenoEvent::DebuggerListening(url) => {
                                state.log(format!("[Debugger] V8 Listening on {}", url));
                            }
                            DenoEvent::DebuggerConnected => {
                                state.log("[Debugger] Attached successfully!");
                                state.is_debugging = true;
                            }
                            DenoEvent::DebuggerPaused { call_frames, variables } => {
                                state.is_paused = true;
                                state.call_frames = call_frames.clone();
                                state.debug_variables = variables;
                                if let Some(top_frame) = call_frames.first() {
                                    state.paused_line = Some(top_frame.line_number);
                                    state.log(format!("[Debugger] Paused at line {}", top_frame.line_number));
                                    
                                    // Move cursor to paused line and load file if different
                                    // (In this basic version, we assume it's the active file)
                                    state.editor.cursor_y = top_frame.line_number - 1;
                                    state.editor.cursor_x = top_frame.column_number;
                                }
                            }
                            DenoEvent::DebuggerResumed => {
                                state.is_paused = false;
                                state.paused_line = None;
                                state.call_frames.clear();
                                state.debug_variables.clear();
                                state.log("[Debugger] Resumed execution");
                            }
                            DenoEvent::Finished(code) => {
                                state.is_debugging = false;
                                state.is_paused = false;
                                state.paused_line = None;
                                state.call_frames.clear();
                                state.debug_variables.clear();
                                tx_debugger_cmd = None;
                                state.log(format!("[Runner] Process exited with status {:?}", code));
                                state.output(format!("\n[Process exited with code {:?}]", code));
                            }
                            DenoEvent::Error(err) => {
                                state.log(format!("Error: {}", err));
                                state.output(format!("Error: {}", err));
                            }
                        }
                    }
                    TuiEvent::Key(key) => {
                        // Global keybindings
                        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('q') {
                            break;
                        }

                        match state.mode {
                            AppMode::Normal => {
                                match key.code {
                                    KeyCode::Char('i') => {
                                        state.mode = AppMode::Insert;
                                        state.focus_panel = FocusPanel::Editor;
                                        state.log("Mode: INSERT");
                                    }
                                    KeyCode::Char(':') => {
                                        state.mode = AppMode::Command;
                                        state.command_text.clear();
                                    }
                                    KeyCode::Char('v') => {
                                        state.mode = AppMode::Explorer;
                                        state.focus_panel = FocusPanel::Explorer;
                                        state.log("Mode: EXPLORER");
                                    }
                                    KeyCode::Char('b') => {
                                        // Toggle breakpoint
                                        let line = state.editor.cursor_y + 1;
                                        if state.breakpoints.contains(&line) {
                                            state.breakpoints.retain(|&x| x != line);
                                            state.log(format!("Breakpoint removed at line {}", line));
                                            if let Some(ref tx) = tx_debugger_cmd {
                                                let _ = tx.send(DebuggerCmd::RemoveBreakpoint { line });
                                            }
                                        } else {
                                            state.breakpoints.push(line);
                                            state.log(format!("Breakpoint set at line {}", line));
                                            if let Some(ref tx) = tx_debugger_cmd {
                                                let filename = state.editor.path.as_ref()
                                                    .map(|p| p.to_string_lossy().to_string())
                                                    .unwrap_or_else(|| "main.ts".to_string());
                                                let _ = tx.send(DebuggerCmd::SetBreakpoint { line, filename });
                                            }
                                        }
                                    }
                                    KeyCode::F(9) => {
                                        // Run Deno
                                        run_deno_script(&mut state, false, &tx_tui, &mut tx_debugger_cmd);
                                    }
                                    KeyCode::F(5) => {
                                        // Debug Deno / Resume
                                        if state.is_debugging {
                                            if state.is_paused {
                                                if let Some(ref tx) = tx_debugger_cmd {
                                                    let _ = tx.send(DebuggerCmd::Resume);
                                                }
                                            }
                                        } else {
                                            run_deno_script(&mut state, true, &tx_tui, &mut tx_debugger_cmd);
                                        }
                                    }
                                    KeyCode::F(10) => {
                                        // Step over
                                        if state.is_debugging && state.is_paused {
                                            if let Some(ref tx) = tx_debugger_cmd {
                                                let _ = tx.send(DebuggerCmd::StepOver);
                                            }
                                        }
                                    }
                                    KeyCode::F(11) => {
                                        // Step into
                                        if state.is_debugging && state.is_paused {
                                            if let Some(ref tx) = tx_debugger_cmd {
                                                let _ = tx.send(DebuggerCmd::StepInto);
                                            }
                                        }
                                    }
                                    // Tabs selection
                                    KeyCode::Char('1') => {
                                        state.active_bottom_tab = BottomTab::Output;
                                    }
                                    KeyCode::Char('2') => {
                                        state.active_bottom_tab = BottomTab::Console;
                                    }
                                    // Navigation
                                    KeyCode::Up | KeyCode::Char('k') => state.editor.move_cursor_up(),
                                    KeyCode::Down | KeyCode::Char('j') => state.editor.move_cursor_down(),
                                    KeyCode::Left | KeyCode::Char('h') => state.editor.move_cursor_left(),
                                    KeyCode::Right | KeyCode::Char('l') => state.editor.move_cursor_right(),
                                    KeyCode::Delete | KeyCode::Char('x') => state.editor.delete(),
                                    KeyCode::Backspace => state.editor.move_cursor_left(),
                                    _ => {}
                                }
                            }
                            AppMode::Insert => {
                                match key.code {
                                    KeyCode::Esc => {
                                        state.mode = AppMode::Normal;
                                        state.log("Mode: NORMAL");
                                    }
                                    KeyCode::Char(c) => {
                                        state.editor.insert_char(c);
                                    }
                                    KeyCode::Tab => {
                                        state.editor.insert_tab();
                                    }
                                    KeyCode::Enter => {
                                        state.editor.insert_newline();
                                    }
                                    KeyCode::Backspace => {
                                        state.editor.backspace();
                                    }
                                    KeyCode::Delete => {
                                        state.editor.delete();
                                    }
                                    KeyCode::Up => state.editor.move_cursor_up(),
                                    KeyCode::Down => state.editor.move_cursor_down(),
                                    KeyCode::Left => state.editor.move_cursor_left(),
                                    KeyCode::Right => state.editor.move_cursor_right(),
                                    _ => {}
                                }
                            }
                            AppMode::Explorer => {
                                match key.code {
                                    KeyCode::Esc => {
                                        state.mode = AppMode::Normal;
                                        state.focus_panel = FocusPanel::Editor;
                                        state.log("Mode: NORMAL");
                                    }
                                    KeyCode::Up | KeyCode::Char('k') => {
                                        if state.explorer_selected > 0 {
                                            state.explorer_selected -= 1;
                                        }
                                    }
                                    KeyCode::Down | KeyCode::Char('j') => {
                                        if state.explorer_selected < state.explorer_items.len() - 1 {
                                            state.explorer_selected += 1;
                                        }
                                    }
                                    KeyCode::Enter => {
                                        // Open selected file
                                        if !state.explorer_items.is_empty() {
                                            let item = &state.explorer_items[state.explorer_selected];
                                            if !item.is_dir {
                                                let filepath = item.path.to_string_lossy().to_string();
                                                match state.editor.load(&filepath) {
                                                    Ok(_) => {
                                                        state.log(format!("Loaded file: {}", filepath));
                                                        state.focus_panel = FocusPanel::Editor;
                                                        state.mode = AppMode::Normal;
                                                    }
                                                    Err(e) => {
                                                        state.log(format!("Failed to load file: {}", e));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    KeyCode::Char('r') => {
                                        // Run selected file
                                        if !state.explorer_items.is_empty() {
                                            let item = &state.explorer_items[state.explorer_selected];
                                            if !item.is_dir {
                                                let filepath = item.path.to_string_lossy().to_string();
                                                state.editor.load(&filepath).unwrap_or(());
                                                run_deno_script(&mut state, false, &tx_tui, &mut tx_debugger_cmd);
                                            }
                                        }
                                    }
                                    KeyCode::Char('d') => {
                                        // Debug selected file
                                        if !state.explorer_items.is_empty() {
                                            let item = &state.explorer_items[state.explorer_selected];
                                            if !item.is_dir {
                                                let filepath = item.path.to_string_lossy().to_string();
                                                state.editor.load(&filepath).unwrap_or(());
                                                run_deno_script(&mut state, true, &tx_tui, &mut tx_debugger_cmd);
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            AppMode::Command => {
                                match key.code {
                                    KeyCode::Esc => {
                                        state.mode = AppMode::Normal;
                                        state.command_text.clear();
                                    }
                                    KeyCode::Char(c) => {
                                        state.command_text.push(c);
                                    }
                                    KeyCode::Backspace => {
                                        state.command_text.pop();
                                        if state.command_text.is_empty() {
                                            state.mode = AppMode::Normal;
                                        }
                                    }
                                    KeyCode::Enter => {
                                        let cmd = state.command_text.trim().to_string();
                                        state.command_text.clear();
                                        state.mode = AppMode::Normal;
                                        execute_vim_command(&cmd, &mut state, &tx_tui, &mut tx_debugger_cmd).await;
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Reset Terminal
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    Ok(())
}

fn run_deno_script(
    state: &mut AppState,
    inspect: bool,
    tx_tui: &mpsc::UnboundedSender<TuiEvent>,
    tx_debugger_cmd: &mut Option<mpsc::UnboundedSender<DebuggerCmd>>,
) {
    if state.editor.path.is_none() {
        state.log("No file open to run.");
        return;
    }
    
    let path = state.editor.path.as_ref().unwrap().to_string_lossy().to_string();
    state.console_output.clear();
    state.console_output.push(format!("$ deno run -A {} {}", if inspect { "--inspect-brk" } else { "" }, path));
    state.active_bottom_tab = BottomTab::Output;

    let (tx_cmd, rx_cmd) = mpsc::unbounded_channel::<DebuggerCmd>();
    *tx_debugger_cmd = Some(tx_cmd);

    let (tx_deno_event, mut rx_deno_event) = mpsc::unbounded_channel::<DenoEvent>();
    let tx_tui_clone = tx_tui.clone();
    
    // Spawn bridge task to forward Deno debugger events to the main TUI loop
    tokio::spawn(async move {
        while let Some(event) = rx_deno_event.recv().await {
            let _ = tx_tui_clone.send(TuiEvent::Deno(event));
        }
    });

    state.is_debugging = inspect;
    state.is_paused = false;
    state.paused_line = None;
    state.call_frames.clear();
    state.debug_variables.clear();

    let initial_breakpoints = state.breakpoints.clone();
    DenoDebugger::start(
        path,
        inspect,
        tx_deno_event,
        rx_cmd,
        initial_breakpoints,
    );
}

// Vim command line runner
async fn execute_vim_command(
    cmd: &str,
    state: &mut AppState,
    tx_tui: &mpsc::UnboundedSender<TuiEvent>,
    tx_debugger_cmd: &mut Option<mpsc::UnboundedSender<DebuggerCmd>>,
) {
    if cmd == "w" || cmd == "write" {
        match state.editor.save() {
            Ok(_) => {
                state.log("File saved successfully.");
                state.read_workspace_dir(); // Refresh explorer
            }
            Err(e) => {
                state.log(format!("Failed to save: {}", e));
            }
        }
    } else if cmd == "q" || cmd == "quit" {
        let _ = disable_raw_mode();
        let mut out = io::stdout();
        let _ = execute!(out, LeaveAlternateScreen);
        std::process::exit(0);
    } else if cmd == "r" || cmd == "run" {
        run_deno_script(state, false, tx_tui, tx_debugger_cmd);
    } else if cmd == "d" || cmd == "debug" {
        run_deno_script(state, true, tx_tui, tx_debugger_cmd);
    } else if cmd.starts_with("bp ") {
        if let Ok(line) = cmd[3..].trim().parse::<usize>() {
            if state.breakpoints.contains(&line) {
                state.breakpoints.retain(|&x| x != line);
                state.log(format!("Breakpoint removed at line {}", line));
                if let Some(ref tx) = tx_debugger_cmd {
                    let _ = tx.send(DebuggerCmd::RemoveBreakpoint { line });
                }
            } else {
                state.breakpoints.push(line);
                state.log(format!("Breakpoint set at line {}", line));
                if let Some(ref tx) = tx_debugger_cmd {
                    let filename = state.editor.path.as_ref()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "main.ts".to_string());
                    let _ = tx.send(DebuggerCmd::SetBreakpoint { line, filename });
                }
            }
        } else {
            state.log("Usage: :bp <line_number>");
        }
    } else if cmd == "help" {
        state.log("Commands: :w (save), :q (quit), :r (run), :d (debug), :bp <line_number> (toggle breakpoint)");
    } else {
        state.log(format!("Command not recognized: :{}", cmd));
    }
}
