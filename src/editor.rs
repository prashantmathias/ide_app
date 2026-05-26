use std::fs;
use std::path::{Path, PathBuf};

pub struct EditorBuffer {
    pub path: Option<PathBuf>,
    pub lines: Vec<String>,
    pub cursor_x: usize,
    pub cursor_y: usize,
    pub scroll_x: usize,
    pub scroll_y: usize,
    pub modified: bool,
}

impl EditorBuffer {
    pub fn new() -> Self {
        Self {
            path: None,
            lines: vec![String::new()],
            cursor_x: 0,
            cursor_y: 0,
            scroll_x: 0,
            scroll_y: 0,
            modified: false,
        }
    }

    pub fn load<P: AsRef<Path>>(&mut self, path: P) -> Result<(), String> {
        let path_ref = path.as_ref();
        let content = if path_ref.exists() {
            fs::read_to_string(path_ref).map_err(|e| format!("Failed to read file: {}", e))?
        } else {
            String::new()
        };

        let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
        if lines.is_empty() {
            lines.push(String::new());
        }

        self.path = Some(path_ref.to_path_buf());
        self.lines = lines;
        self.cursor_x = 0;
        self.cursor_y = 0;
        self.scroll_x = 0;
        self.scroll_y = 0;
        self.modified = false;
        Ok(())
    }

    pub fn save(&mut self) -> Result<(), String> {
        if let Some(ref path) = self.path {
            let content = self.lines.join("\n");
            fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))?;
            self.modified = false;
            Ok(())
        } else {
            Err("No file path set to save".to_string())
        }
    }

    pub fn insert_char(&mut self, c: char) {
        if self.cursor_y >= self.lines.len() {
            self.lines.push(String::new());
        }
        let line = &mut self.lines[self.cursor_y];
        
        // Handle cursor x out of bounds safety
        if self.cursor_x > line.len() {
            self.cursor_x = line.len();
        }
        
        line.insert(self.cursor_x, c);
        self.cursor_x += 1;
        self.modified = true;
    }

    pub fn insert_tab(&mut self) {
        for _ in 0..4 {
            self.insert_char(' ');
        }
    }

    pub fn insert_newline(&mut self) {
        let line = &self.lines[self.cursor_y];
        let (left, right) = line.split_at(self.cursor_x.min(line.len()));
        let left_str = left.to_string();
        let right_str = right.to_string();
        
        self.lines[self.cursor_y] = left_str;
        self.lines.insert(self.cursor_y + 1, right_str);
        self.cursor_y += 1;
        self.cursor_x = 0;
        self.modified = true;
    }

    pub fn backspace(&mut self) {
        if self.cursor_x > 0 {
            let line = &mut self.lines[self.cursor_y];
            if self.cursor_x <= line.len() {
                line.remove(self.cursor_x - 1);
            }
            self.cursor_x -= 1;
            self.modified = true;
        } else if self.cursor_y > 0 {
            let current_line = self.lines.remove(self.cursor_y);
            self.cursor_y -= 1;
            let prev_len = self.lines[self.cursor_y].len();
            self.lines[self.cursor_y].push_str(&current_line);
            self.cursor_x = prev_len;
            self.modified = true;
        }
    }

    pub fn delete(&mut self) {
        let line = &mut self.lines[self.cursor_y];
        if self.cursor_x < line.len() {
            line.remove(self.cursor_x);
            self.modified = true;
        } else if self.cursor_y < self.lines.len() - 1 {
            let next_line = self.lines.remove(self.cursor_y + 1);
            self.lines[self.cursor_y].push_str(&next_line);
            self.modified = true;
        }
    }

    pub fn move_cursor_up(&mut self) {
        if self.cursor_y > 0 {
            self.cursor_y -= 1;
            self.clamp_cursor_x();
        }
    }

    pub fn move_cursor_down(&mut self) {
        if self.cursor_y < self.lines.len() - 1 {
            self.cursor_y += 1;
            self.clamp_cursor_x();
        }
    }

    pub fn move_cursor_left(&mut self) {
        if self.cursor_x > 0 {
            self.cursor_x -= 1;
        } else if self.cursor_y > 0 {
            self.cursor_y -= 1;
            self.cursor_x = self.lines[self.cursor_y].len();
        }
    }

    pub fn move_cursor_right(&mut self) {
        let line = &self.lines[self.cursor_y];
        if self.cursor_x < line.len() {
            self.cursor_x += 1;
        } else if self.cursor_y < self.lines.len() - 1 {
            self.cursor_y += 1;
            self.cursor_x = 0;
        }
    }

    fn clamp_cursor_x(&mut self) {
        let line_len = self.lines[self.cursor_y].len();
        if self.cursor_x > line_len {
            self.cursor_x = line_len;
        }
    }

    pub fn adjust_scroll(&mut self, height: usize, width: usize) {
        if self.cursor_y < self.scroll_y {
            self.scroll_y = self.cursor_y;
        }
        if height > 0 && self.cursor_y >= self.scroll_y + height {
            self.scroll_y = self.cursor_y - height + 1;
        }
        if self.cursor_x < self.scroll_x {
            self.scroll_x = self.cursor_x;
        }
        if width > 0 && self.cursor_x >= self.scroll_x + width {
            self.scroll_x = self.cursor_x - width + 1;
        }
    }
}
