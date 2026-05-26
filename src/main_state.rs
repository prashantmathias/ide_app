use std::path::PathBuf;
use crate::debugger::{DebugCallFrame, DebugVariable};
use crate::editor::EditorBuffer;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppMode {
    Normal,
    Insert,
    Command,
    Explorer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusPanel {
    Editor,
    Explorer,
    AiInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BottomTab {
    Output,
    Console,
}

pub struct ExplorerItem {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub sender: String, // "U" or "A"
    pub text: String,
}

pub struct AppState {
    pub mode: AppMode,
    pub editor: EditorBuffer,
    pub explorer_items: Vec<ExplorerItem>,
    pub explorer_selected: usize,
    pub command_text: String,
    pub console_output: Vec<String>,
    pub system_logs: Vec<String>,
    pub is_debugging: bool,
    pub is_paused: bool,
    pub paused_line: Option<usize>,
    pub call_frames: Vec<DebugCallFrame>,
    pub debug_variables: Vec<DebugVariable>,
    pub breakpoints: Vec<usize>, // 1-indexed
    pub active_bottom_tab: BottomTab,
    pub show_sidebar: bool,
    pub focus_panel: FocusPanel,
    pub time_string: String,
    pub explorer_rect: Option<(u16, u16, u16, u16)>,
    pub editor_rect: Option<(u16, u16, u16, u16)>,
    pub editor_inner_rect: Option<(u16, u16, u16, u16)>,
    pub bottom_rect: Option<(u16, u16, u16, u16)>,
    pub header_rect: Option<(u16, u16, u16, u16)>,
    pub ai_rect: Option<(u16, u16, u16, u16)>,
    
    // AI Agent side panel fields
    pub show_ai_panel: bool,
    pub ai_status: String,
    pub ai_input: String,
    pub ai_chat_history: Vec<ChatMessage>,
    pub ai_chat_scroll: usize,
    pub show_help: bool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            mode: AppMode::Normal,
            editor: EditorBuffer::new(),
            explorer_items: Vec::new(),
            explorer_selected: 0,
            command_text: String::new(),
            console_output: vec!["$ Deno TUI IDE initialized.".to_string()],
            system_logs: vec!["[System] App started".to_string()],
            is_debugging: false,
            is_paused: false,
            paused_line: None,
            call_frames: Vec::new(),
            debug_variables: Vec::new(),
            breakpoints: Vec::new(),
            active_bottom_tab: BottomTab::Output,
            show_sidebar: true,
            focus_panel: FocusPanel::Editor,
            time_string: "00:00:00".to_string(),
            explorer_rect: None,
            editor_rect: None,
            editor_inner_rect: None,
            bottom_rect: None,
            header_rect: None,
            ai_rect: None,
            
            show_ai_panel: true,
            ai_status: "LISTENING".to_string(),
            ai_input: String::new(),
            ai_chat_history: vec![ChatMessage {
                sender: "A".to_string(),
                text: "Hello! I am your CodeCraft assistant. How can I help you optimize your workspace today?".to_string(),
            }],
            ai_chat_scroll: 0,
            show_help: false,
        }
    }

    pub fn log(&mut self, msg: impl Into<String>) {
        self.system_logs.push(msg.into());
    }

    pub fn output(&mut self, msg: impl Into<String>) {
        self.console_output.push(msg.into());
    }

    pub fn read_workspace_dir(&mut self) {
        let mut items = Vec::new();
        if let Ok(entries) = std::fs::read_dir(".") {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "target" || name == "node_modules" {
                    continue;
                }
                let path = entry.path();
                let is_dir = path.is_dir();
                items.push(ExplorerItem { name, path, is_dir });
            }
        }
        // Directories first, then files alphabetically
        items.sort_by(|a, b| {
            b.is_dir.cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        self.explorer_items = items;
        
        // Clamp explorer_selected
        if self.explorer_selected >= self.explorer_items.len() && !self.explorer_items.is_empty() {
            self.explorer_selected = self.explorer_items.len() - 1;
        }
    }
}
