mod debugger;
mod editor;
mod main_state;
mod ui;

use crate::debugger::{DenoDebugger, DenoEvent, DebuggerCmd};
use crate::main_state::{AppMode, AppState, BottomTab, FocusPanel, ChatMessage};
use crate::ui::draw_ui;

use std::io;
use std::time::{Duration, SystemTime};
use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers, KeyEventKind, EnableMouseCapture, DisableMouseCapture, MouseEvent, MouseEventKind, MouseButton},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use tokio::sync::mpsc;

enum TuiEvent {
    Key(crossterm::event::KeyEvent),
    Mouse(MouseEvent),
    Deno(DenoEvent),
    Tick,
    Ai(AiEvent),
}

enum AiEvent {
    Response(Result<String, String>),
    Log(String),
}

#[tokio::main]
async fn main() -> Result<(), io::Error> {
    // 1. Setup Terminal alternate screen and raw mode
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    
    // Set panic hook to ensure terminal reset on crash
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let mut out = io::stdout();
        let _ = execute!(out, LeaveAlternateScreen, DisableMouseCapture);
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
    
    // Event listener thread
    let tx_evt = tx_tui.clone();
    std::thread::spawn(move || {
        loop {
            if event::poll(Duration::from_millis(100)).unwrap() {
                match event::read().unwrap() {
                    Event::Key(key)
                        // Only process key Press events (avoid double trigger on Windows release/repeat)
                        if key.kind == KeyEventKind::Press => {
                            let _ = tx_evt.send(TuiEvent::Key(key));
                        }
                    Event::Mouse(mouse) => {
                        let _ = tx_evt.send(TuiEvent::Mouse(mouse));
                    }
                    _ => {}
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
                    TuiEvent::Mouse(mouse) => {
                        handle_mouse_event(&mut state, mouse, &tx_tui, &mut tx_debugger_cmd);
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
                    TuiEvent::Ai(ai_event) => {
                        match ai_event {
                            AiEvent::Response(res) => {
                                match res {
                                    Ok(reply) => {
                                        state.log("[AI] OpenAI responded successfully.");
                                        state.ai_chat_history.push(ChatMessage {
                                            sender: "A".to_string(),
                                            text: reply,
                                        });
                                    }
                                    Err(err) => {
                                        state.log(format!("[AI] OpenAI request failed: {}", err));
                                        state.ai_chat_history.push(ChatMessage {
                                            sender: "A".to_string(),
                                            text: format!("Error: {}", err),
                                        });
                                    }
                                }
                                state.ai_status = "LISTENING".to_string();
                                state.ai_chat_scroll = usize::MAX;
                            }
                            AiEvent::Log(msg) => {
                                state.log(&msg);
                                state.ai_chat_history.push(ChatMessage {
                                    sender: "A".to_string(),
                                    text: msg,
                                });
                                state.ai_chat_scroll = usize::MAX;
                            }
                        }
                    }
                    TuiEvent::Key(key) => {
                        // Global keybindings
                        if key.code == KeyCode::F(1) {
                            state.show_help = !state.show_help;
                            continue;
                        }
                        // Dismiss help overlay on any other key
                        if state.show_help {
                            state.show_help = false;
                            continue;
                        }
                        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('q') {
                            break;
                        }
                        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('a') {
                            state.show_ai_panel = !state.show_ai_panel;
                            if state.show_ai_panel {
                                state.focus_panel = FocusPanel::AiInput;
                                state.mode = AppMode::Normal;
                            } else if state.focus_panel == FocusPanel::AiInput {
                                state.focus_panel = FocusPanel::Editor;
                                state.mode = AppMode::Normal;
                            }
                            state.log(format!("AI Panel visibility: {}", state.show_ai_panel));
                            continue;
                        }

                        match state.mode {
                            AppMode::Normal => {
                                match key.code {
                                    KeyCode::Char('i') => {
                                        state.mode = AppMode::Insert;
                                        if state.focus_panel != FocusPanel::AiInput {
                                            state.focus_panel = FocusPanel::Editor;
                                        }
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
                                    KeyCode::Tab => {
                                        let next_panel = match state.focus_panel {
                                            FocusPanel::Editor => {
                                                if state.show_ai_panel {
                                                    FocusPanel::AiInput
                                                } else if state.show_sidebar {
                                                    FocusPanel::Explorer
                                                } else {
                                                    FocusPanel::Editor
                                                }
                                            }
                                            FocusPanel::AiInput => {
                                                if state.show_sidebar {
                                                    FocusPanel::Explorer
                                                } else {
                                                    FocusPanel::Editor
                                                }
                                            }
                                            FocusPanel::Explorer => FocusPanel::Editor,
                                        };
                                        state.focus_panel = next_panel;
                                        if next_panel == FocusPanel::Explorer {
                                            state.mode = AppMode::Explorer;
                                        } else {
                                            state.mode = AppMode::Normal;
                                        }
                                        state.log(format!("Focused panel: {:?}", state.focus_panel));
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
                                    KeyCode::F(10)
                                        // Step over
                                        if state.is_debugging && state.is_paused => {
                                            if let Some(ref tx) = tx_debugger_cmd {
                                                let _ = tx.send(DebuggerCmd::StepOver);
                                            }
                                        }
                                    KeyCode::F(11)
                                        // Step into
                                        if state.is_debugging && state.is_paused => {
                                            if let Some(ref tx) = tx_debugger_cmd {
                                                let _ = tx.send(DebuggerCmd::StepInto);
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
                                    KeyCode::Up | KeyCode::Char('k') => {
                                        if state.focus_panel == FocusPanel::AiInput {
                                            state.ai_chat_scroll = state.ai_chat_scroll.saturating_sub(1);
                                        } else {
                                            state.editor.move_cursor_up();
                                        }
                                    }
                                    KeyCode::Down | KeyCode::Char('j') => {
                                        if state.focus_panel == FocusPanel::AiInput {
                                            state.ai_chat_scroll = state.ai_chat_scroll.saturating_add(1);
                                        } else {
                                            state.editor.move_cursor_down();
                                        }
                                    }
                                    KeyCode::Left | KeyCode::Char('h') => {
                                        if state.focus_panel != FocusPanel::AiInput {
                                            state.editor.move_cursor_left();
                                        }
                                    }
                                    KeyCode::Right | KeyCode::Char('l') => {
                                        if state.focus_panel != FocusPanel::AiInput {
                                            state.editor.move_cursor_right();
                                        }
                                    }
                                    KeyCode::Delete | KeyCode::Char('x') => {
                                        if state.focus_panel != FocusPanel::AiInput {
                                            state.editor.delete();
                                        }
                                    }
                                    KeyCode::Backspace => {
                                        if state.focus_panel != FocusPanel::AiInput {
                                            state.editor.move_cursor_left();
                                        }
                                    }
                                    KeyCode::Enter => {
                                        if state.focus_panel == FocusPanel::AiInput {
                                            send_ai_query(&mut state, tx_tui.clone());
                                        }
                                    }
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
                                        if state.focus_panel == FocusPanel::AiInput {
                                            state.ai_input.push(c);
                                        } else {
                                            state.editor.insert_char(c);
                                        }
                                    }
                                    KeyCode::Tab => {
                                        if state.focus_panel != FocusPanel::AiInput {
                                            state.editor.insert_tab();
                                        }
                                    }
                                    KeyCode::Enter => {
                                        if state.focus_panel == FocusPanel::AiInput {
                                            send_ai_query(&mut state, tx_tui.clone());
                                        } else {
                                            state.editor.insert_newline();
                                        }
                                    }
                                    KeyCode::Backspace => {
                                        if state.focus_panel == FocusPanel::AiInput {
                                            state.ai_input.pop();
                                        } else {
                                            state.editor.backspace();
                                        }
                                    }
                                    KeyCode::Delete => {
                                        if state.focus_panel != FocusPanel::AiInput {
                                            state.editor.delete();
                                        }
                                    }
                                    KeyCode::Up => {
                                        if state.focus_panel == FocusPanel::AiInput {
                                            state.ai_chat_scroll = state.ai_chat_scroll.saturating_sub(1);
                                        } else {
                                            state.editor.move_cursor_up();
                                        }
                                    }
                                    KeyCode::Down => {
                                        if state.focus_panel == FocusPanel::AiInput {
                                            state.ai_chat_scroll = state.ai_chat_scroll.saturating_add(1);
                                        } else {
                                            state.editor.move_cursor_down();
                                        }
                                    }
                                    KeyCode::Left => {
                                        if state.focus_panel != FocusPanel::AiInput {
                                            state.editor.move_cursor_left();
                                        }
                                    }
                                    KeyCode::Right => {
                                        if state.focus_panel != FocusPanel::AiInput {
                                            state.editor.move_cursor_right();
                                        }
                                    }
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
                                    KeyCode::Up | KeyCode::Char('k')
                                        if state.explorer_selected > 0 => {
                                            state.explorer_selected -= 1;
                                        }
                                    KeyCode::Down | KeyCode::Char('j')
                                        if state.explorer_selected < state.explorer_items.len() - 1 => {
                                            state.explorer_selected += 1;
                                        }
                                    KeyCode::Enter
                                        // Open selected file
                                        if !state.explorer_items.is_empty() => {
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
                                    KeyCode::Char('r')
                                        // Run selected file
                                        if !state.explorer_items.is_empty() => {
                                            let item = &state.explorer_items[state.explorer_selected];
                                            if !item.is_dir {
                                                let filepath = item.path.to_string_lossy().to_string();
                                                state.editor.load(&filepath).unwrap_or(());
                                                run_deno_script(&mut state, false, &tx_tui, &mut tx_debugger_cmd);
                                            }
                                        }
                                    KeyCode::Char('d')
                                        // Debug selected file
                                        if !state.explorer_items.is_empty() => {
                                            let item = &state.explorer_items[state.explorer_selected];
                                            if !item.is_dir {
                                                let filepath = item.path.to_string_lossy().to_string();
                                                state.editor.load(&filepath).unwrap_or(());
                                                run_deno_script(&mut state, true, &tx_tui, &mut tx_debugger_cmd);
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
    execute!(terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
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
    } else if let Some(stripped) = cmd.strip_prefix("bp ") {
        if let Ok(line) = stripped.trim().parse::<usize>() {
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

fn handle_mouse_event(
    state: &mut AppState,
    mouse: MouseEvent,
    tx_tui: &mpsc::UnboundedSender<TuiEvent>,
    tx_debugger_cmd: &mut Option<mpsc::UnboundedSender<DebuggerCmd>>,
) {
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            let col = mouse.column;
            let row = mouse.row;

            // 1. Header click
            if let Some((x, y, w, _h)) = state.header_rect {
                if row == y && col >= x && col < x + w {
                    let rel_x = col - x;
                    if (24..=35).contains(&rel_x) {
                        state.mode = AppMode::Normal;
                        state.focus_panel = FocusPanel::Editor;
                        state.log("Mode: NORMAL");
                    } else if (38..=47).contains(&rel_x) {
                        state.mode = AppMode::Insert;
                        state.focus_panel = FocusPanel::Editor;
                        state.log("Mode: INSERT");
                    } else if (50..=61).contains(&rel_x) {
                        state.mode = AppMode::Command;
                        state.command_text.clear();
                    } else if (64..=75).contains(&rel_x) {
                        state.mode = AppMode::Explorer;
                        state.focus_panel = FocusPanel::Explorer;
                        state.log("Mode: EXPLORER");
                    } else if (78..=85).contains(&rel_x) {
                        run_deno_script(state, false, tx_tui, tx_debugger_cmd);
                    } else if (88..=97).contains(&rel_x) {
                        if state.is_debugging {
                            if state.is_paused {
                                if let Some(ref tx) = tx_debugger_cmd {
                                    let _ = tx.send(DebuggerCmd::Resume);
                                }
                            }
                        } else {
                            run_deno_script(state, true, tx_tui, tx_debugger_cmd);
                        }
                    }
                    return;
                }
            }

            // 2. Explorer click
            if let Some((x, y, w, h)) = state.explorer_rect {
                if col >= x && col < x + w && row >= y && row < y + h {
                    state.focus_panel = FocusPanel::Explorer;
                    state.mode = AppMode::Explorer;
                    
                    if row > y && row < y + h - 1 {
                        let clicked_idx = (row - y - 1) as usize;
                        if clicked_idx < state.explorer_items.len() {
                            state.explorer_selected = clicked_idx;
                            let item = &state.explorer_items[clicked_idx];
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
                    return;
                }
            }

            // 3. Editor click
            if let Some((ex, ey, ew, eh)) = state.editor_rect {
                if col >= ex && col < ex + ew && row >= ey && row < ey + eh {
                    state.focus_panel = FocusPanel::Editor;
                    if state.mode == AppMode::Explorer {
                        state.mode = AppMode::Normal;
                    }

                    if let Some((ix, iy, _iw, ih)) = state.editor_inner_rect {
                        let gutter_width = 7;
                        
                        if row >= iy && row < iy + ih {
                            let clicked_line_offset = (row - iy) as usize;
                            let target_line_idx = state.editor.scroll_y + clicked_line_offset;
                            
                            if target_line_idx < state.editor.lines.len() {
                                if col >= ix && col < ix + gutter_width {
                                    let line = target_line_idx + 1;
                                    if state.breakpoints.contains(&line) {
                                        state.breakpoints.retain(|&bp| bp != line);
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
                                    state.editor.cursor_y = target_line_idx;
                                    
                                    let clicked_col_offset = (col - ix - gutter_width) as usize;
                                    let target_col_idx = state.editor.scroll_x + clicked_col_offset;
                                    
                                    let line_len = state.editor.lines[target_line_idx].len();
                                    state.editor.cursor_x = target_col_idx.min(line_len);
                                }
                            }
                        }
                    }
                    return;
                }
            }

            // 4. Bottom Tab click
            if let Some((x, y, w, _h)) = state.bottom_rect {
                if col >= x && col < x + w && row == y {
                    let rel_x = col - x;
                    if rel_x < 15 {
                        state.active_bottom_tab = BottomTab::Output;
                    } else {
                        state.active_bottom_tab = BottomTab::Console;
                    }
                }
            }

            // 5. AI Panel click
            if let Some((ax, ay, aw, ah)) = state.ai_rect {
                if col >= ax && col < ax + aw && row >= ay && row < ay + ah {
                    state.focus_panel = FocusPanel::AiInput;
                    state.mode = AppMode::Normal;
                    state.log("Focused panel: AI Agent");
                    return;
                }
            }
        }
        MouseEventKind::ScrollUp => {
            let col = mouse.column;
            let row = mouse.row;
            // AI panel scroll
            if let Some((ax, ay, aw, ah)) = state.ai_rect {
                if col >= ax && col < ax + aw && row >= ay && row < ay + ah {
                    state.ai_chat_scroll = state.ai_chat_scroll.saturating_sub(1);
                    return;
                }
            }
            if let Some((ex, ey, ew, eh)) = state.editor_rect {
                if col >= ex && col < ex + ew && row >= ey && row < ey + eh
                    && state.editor.scroll_y > 0 {
                        state.editor.scroll_y = state.editor.scroll_y.saturating_sub(1);
                    }
            }
        }
        MouseEventKind::ScrollDown => {
            let col = mouse.column;
            let row = mouse.row;
            // AI panel scroll
            if let Some((ax, ay, aw, ah)) = state.ai_rect {
                if col >= ax && col < ax + aw && row >= ay && row < ay + ah {
                    state.ai_chat_scroll = state.ai_chat_scroll.saturating_add(1);
                    return;
                }
            }
            if let Some((ex, ey, ew, eh)) = state.editor_rect {
                if col >= ex && col < ex + ew && row >= ey && row < ey + eh
                    && state.editor.scroll_y + 1 < state.editor.lines.len() {
                        state.editor.scroll_y += 1;
                    }
            }
        }
        _ => {}
    }
}

fn send_ai_query(state: &mut AppState, tx_tui: mpsc::UnboundedSender<TuiEvent>) {
    let query = state.ai_input.trim().to_string();
    if query.is_empty() {
        return;
    }
    
    state.log(format!("[AI] Sending query: {}", query));
    
    // Add user message to history
    state.ai_chat_history.push(ChatMessage {
        sender: "U".to_string(),
        text: query,
    });
    
    // Clear input
    state.ai_input.clear();
    
    // Set status to THINKING
    state.ai_status = "THINKING".to_string();
    
    // Auto scroll to bottom
    state.ai_chat_scroll = usize::MAX;
    
    // Collect context
    let history = state.ai_chat_history.clone();
    let tx_tui_clone = tx_tui.clone();
    
    // Spawn task
    tokio::spawn(async move {
        let result = call_openai_api(history, tx_tui_clone).await;
        let _ = tx_tui.send(TuiEvent::Ai(AiEvent::Response(result)));
    });
}

async fn call_openai_api(
    history: Vec<ChatMessage>,
    tx_tui: mpsc::UnboundedSender<TuiEvent>,
) -> Result<String, String> {
    let api_key = match get_openai_key() {
        Some(key) => key,
        None => {
            return Err("OpenAI API key not found. Please set OPENAI_API_KEY environment variable or define it in a .env file.".to_string());
        }
    };
    
    let mut messages = vec![
        serde_json::json!({
            "role": "system",
            "content": "You are a helpful AI assistant in the CodeCraft TUI IDE. Answer developer queries concisely. You have access to tools to interact with the workspace directory (list files, read, write, edit, and delete files, and install NPM packages). Use them autonomously when requested."
        })
    ];
    
    let start_idx = history.len().saturating_sub(10);
    for msg in &history[start_idx..] {
        let role = if msg.sender == "U" { "user" } else { "assistant" };
        messages.push(serde_json::json!({
            "role": role,
            "content": msg.text
        }));
    }
    
    let tools = serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "List all files and directories in the current workspace",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the contents of a file in the workspace",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file relative to the workspace root"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create a new file or completely overwrite an existing file with content",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file relative to the workspace root"
                        },
                        "content": {
                            "type": "string",
                            "description": "Full text content to write into the file"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Search and replace a specific block of text inside an existing file",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file relative to the workspace root"
                        },
                        "search": {
                            "type": "string",
                            "description": "The exact block of text in the file that you want to replace"
                        },
                        "replace": {
                            "type": "string",
                            "description": "The new text that will replace the search block"
                        }
                    },
                    "required": ["path", "search", "replace"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "delete_file",
                "description": "Delete a file from the workspace",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file relative to the workspace root"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "install_package",
                "description": "Install an NPM package in the workspace",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "package": {
                            "type": "string",
                            "description": "Name of the NPM package to install"
                        }
                    },
                    "required": ["package"]
                }
            }
        }
    ]);

    let client = reqwest::Client::new();
    let mut loop_count = 0;
    
    loop {
        if loop_count >= 5 {
            return Err("Agent loop limit reached (max 5 tool calls)".to_string());
        }
        loop_count += 1;

        let request_body = serde_json::json!({
            "model": "gpt-4o",
            "messages": messages,
            "tools": tools
        });

        let response = client.post("https://api.openai.com/v1/chat/completions")
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;
            
        if !response.status().is_success() {
            let status = response.status();
            let err_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("API Error (status {}): {}", status, err_text));
        }
        
        let res_json: serde_json::Value = response.json()
            .await
            .map_err(|e| format!("Failed to parse JSON: {}", e))?;
            
        let message_val = &res_json["choices"][0]["message"];
        
        // Check for tool calls
        if let Some(tool_calls) = message_val["tool_calls"].as_array() {
            if tool_calls.is_empty() {
                let content = message_val["content"].as_str().unwrap_or("").to_string();
                return Ok(content);
            }
            
            // Append assistant message with tool calls to messages
            messages.push(message_val.clone());
            
            for tool_call in tool_calls {
                let tool_call_id = tool_call["id"].as_str().unwrap_or("").to_string();
                let name = tool_call["function"]["name"].as_str().unwrap_or("").to_string();
                let args_str = tool_call["function"]["arguments"].as_str().unwrap_or("{}");
                let args: serde_json::Value = serde_json::from_str(args_str).unwrap_or(serde_json::Value::Null);

                // Broadcast tool call log
                let log_msg = format!("[AI Agent Tool Call] {} - args: {}", name, args_str);
                let _ = tx_tui.send(TuiEvent::Ai(AiEvent::Log(log_msg)));

                // Execute tool
                let result = match name.as_str() {
                    "list_directory" => match run_list_directory() {
                        Ok(res) => res,
                        Err(e) => format!("Error listing directory: {}", e),
                    },
                    "read_file" => {
                        let path = args["path"].as_str().unwrap_or("");
                        match run_read_file(path) {
                            Ok(res) => res,
                            Err(e) => format!("Error reading file: {}", e),
                        }
                    }
                    "write_file" => {
                        let path = args["path"].as_str().unwrap_or("");
                        let content = args["content"].as_str().unwrap_or("");
                        match run_write_file(path, content) {
                            Ok(res) => res,
                            Err(e) => format!("Error writing file: {}", e),
                        }
                    }
                    "edit_file" => {
                        let path = args["path"].as_str().unwrap_or("");
                        let search = args["search"].as_str().unwrap_or("");
                        let replace = args["replace"].as_str().unwrap_or("");
                        match run_edit_file(path, search, replace) {
                            Ok(res) => res,
                            Err(e) => format!("Error editing file: {}", e),
                        }
                    }
                    "delete_file" => {
                        let path = args["path"].as_str().unwrap_or("");
                        match run_delete_file(path) {
                            Ok(res) => res,
                            Err(e) => format!("Error deleting file: {}", e),
                        }
                    }
                    "install_package" => {
                        let package = args["package"].as_str().unwrap_or("");
                        match run_install_package(package) {
                            Ok(res) => res,
                            Err(e) => format!("Error installing package: {}", e),
                        }
                    }
                    _ => format!("Unknown tool name: {}", name),
                };

                // Broadcast tool result log
                let result_log = format!("[AI Agent Tool Result] {} - success/output length: {}", name, result.len());
                let _ = tx_tui.send(TuiEvent::Ai(AiEvent::Log(result_log)));

                // Append tool response
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "content": result
                }));
            }
        } else {
            let content = message_val["content"].as_str().unwrap_or("").to_string();
            return Ok(content);
        }
    }
}

fn get_openai_key() -> Option<String> {
    if let Ok(key) = std::env::var("OPENAI_API_KEY") {
        if !key.is_empty() {
            return Some(key);
        }
    }
    if let Ok(content) = std::fs::read_to_string(".env") {
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with("OPENAI_API_KEY=") {
                let parts: Vec<&str> = line.splitn(2, '=').collect();
                if parts.len() == 2 {
                    let val = parts[1].trim().trim_matches('"').trim_matches('\'').to_string();
                    if !val.is_empty() {
                        return Some(val);
                    }
                }
            }
        }
    }
    None
}

// --- AI AGENT WORKSPACE TOOLS ---

fn run_list_directory() -> Result<String, String> {
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(".") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            let path = entry.path();
            let is_dir = path.is_dir();
            let kind = if is_dir { "Directory" } else { "File" };
            items.push(format!("- {} ({})", name, kind));
        }
    }
    items.sort();
    if items.is_empty() {
        Ok("Workspace is empty.".to_string())
    } else {
        Ok(items.join("\n"))
    }
}

fn run_read_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("Failed to read file '{}': {}", path, e))
}

fn run_write_file(path: &str, content: &str) -> Result<String, String> {
    std::fs::write(path, content)
        .map(|_| format!("Successfully wrote file '{}'.", path))
        .map_err(|e| format!("Failed to write file '{}': {}", path, e))
}

fn run_edit_file(path: &str, search: &str, replace: &str) -> Result<String, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    if !content.contains(search) {
        return Err(format!(
            "Search block not found in file '{}'. Ensure your search string matches exactly.",
            path
        ));
    }
    let new_content = content.replace(search, replace);
    std::fs::write(path, new_content)
        .map(|_| format!("Successfully edited file '{}'.", path))
        .map_err(|e| format!("Failed to write edited file '{}': {}", path, e))
}

fn run_delete_file(path: &str) -> Result<String, String> {
    std::fs::remove_file(path)
        .map(|_| format!("Successfully deleted file '{}'.", path))
        .map_err(|e| format!("Failed to delete file '{}': {}", path, e))
}

fn run_install_package(package: &str) -> Result<String, String> {
    let output = std::process::Command::new("npm")
        .args(["install", package])
        .output();
    match output {
        Ok(out) => {
            if out.status.success() {
                Ok(format!("Successfully installed package '{}'.", package))
            } else {
                Err(format!(
                    "npm install failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                ))
            }
        }
        Err(e) => Err(format!("Failed to execute npm command: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filesystem_tools() {
        let test_file = "test_run_tool.txt";
        let content = "Hello from AI tool test!\nLine 2: Target\nLine 3: End";
        
        // Test write_file
        let res = run_write_file(test_file, content);
        assert!(res.is_ok());

        // Test read_file
        let read_res = run_read_file(test_file);
        assert!(read_res.is_ok());
        assert_eq!(read_res.unwrap(), content);

        // Test edit_file
        let edit_res = run_edit_file(test_file, "Line 2: Target", "Line 2: Replacement");
        assert!(edit_res.is_ok());
        let read_after_edit = run_read_file(test_file).unwrap();
        assert!(read_after_edit.contains("Line 2: Replacement"));
        assert!(!read_after_edit.contains("Line 2: Target"));

        // Test list_directory
        let list_res = run_list_directory();
        assert!(list_res.is_ok());
        assert!(list_res.unwrap().contains(test_file));

        // Test delete_file
        let del_res = run_delete_file(test_file);
        assert!(del_res.is_ok());
        assert!(!run_list_directory().unwrap().contains(test_file));
    }
}
