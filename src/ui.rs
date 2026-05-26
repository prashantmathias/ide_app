use crate::main_state::{AppMode, AppState, BottomTab, FocusPanel};
use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, Borders, BorderType, List, ListItem, Paragraph},
    Frame,
};

// Obsidian Dark Theme Colors
const COLOR_BG: Color = Color::Rgb(15, 17, 23);
const COLOR_BORDER_ACTIVE: Color = Color::Rgb(162, 201, 255); // Soft Light Blue
const COLOR_BORDER_INACTIVE: Color = Color::Rgb(79, 93, 117); // Steel Blue/Grey
const COLOR_TEXT_PRIMARY: Color = Color::Rgb(240, 246, 252);  // Off-white
const COLOR_TEXT_MUTED: Color = Color::Rgb(139, 148, 158);    // Grey
const COLOR_ACCENT: Color = Color::Rgb(209, 154, 233);        // Lavender
const COLOR_GREEN: Color = Color::Rgb(138, 201, 143);         // Mint Green
const COLOR_YELLOW: Color = Color::Rgb(255, 198, 117);        // Amber/Gold
const COLOR_RED: Color = Color::Rgb(255, 123, 114);           // Coral Red
const COLOR_CYAN: Color = Color::Rgb(112, 222, 240);          // Cyan

pub fn draw_ui(f: &mut Frame, state: &mut AppState) {
    // Overall screen layout:
    // 1. Header (1 line)
    // 2. Main Area (variable height)
    // 3. Bottom Panel (10 lines)
    // 4. Status Bar (1 line)
    // 5. Command line (1 line, if active)
    
    let command_line_height = if state.mode == AppMode::Command { 1 } else { 0 };
    
    let main_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),                              // Header
            Constraint::Min(5),                                 // Main Area & Bottom Panel
            Constraint::Length(1),                              // Status Bar
            Constraint::Length(command_line_height),            // Command Input
        ])
        .split(f.area());

    // 1. Render Header
    let header_text = Line::from(vec![
        Span::styled(" ┌─ Deno-TUI IDE ─┐ ", Style::default().fg(COLOR_BORDER_ACTIVE).bold()),
        Span::styled("  [ Esc: Normal | i: Insert | : : Command | v: Explorer | F9: Run | F5: Debug ]  ", Style::default().fg(COLOR_TEXT_MUTED)),
    ]);
    let header = Paragraph::new(header_text).style(Style::default().bg(COLOR_BG));
    f.render_widget(header, main_chunks[0]);

    // Split Main Area and Bottom Panel
    let body_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage(70),                         // Editor/Explorer/Debugger
            Constraint::Percentage(30),                         // Bottom Tabs
        ])
        .split(main_chunks[1]);

    // Split Editor, Explorer, and Debugger
    let mut main_horizontal_constraints = Vec::new();
    
    if state.show_sidebar {
        main_horizontal_constraints.push(Constraint::Length(25)); // Explorer sidebar
    }
    
    main_horizontal_constraints.push(Constraint::Min(20));       // Editor
    
    if state.is_debugging {
        main_horizontal_constraints.push(Constraint::Length(35)); // Debugger panel
    }
    
    let content_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(main_horizontal_constraints)
        .split(body_chunks[0]);

    let mut chunk_idx = 0;

    // 2a. Render File Explorer (Sidebar)
    if state.show_sidebar {
        let explorer_rect = content_chunks[chunk_idx];
        chunk_idx += 1;
        
        let border_style = if state.focus_panel == FocusPanel::Explorer {
            Style::default().fg(COLOR_BORDER_ACTIVE)
        } else {
            Style::default().fg(COLOR_BORDER_INACTIVE)
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(border_style)
            .title(Span::styled(" File Explorer ", Style::default().fg(COLOR_BORDER_ACTIVE).bold()));

        let items: Vec<ListItem> = state.explorer_items
            .iter()
            .enumerate()
            .map(|(idx, item)| {
                let icon = if item.is_dir { "📁 " } else { "📄 " };
                let prefix = if state.focus_panel == FocusPanel::Explorer && idx == state.explorer_selected {
                    "▶ "
                } else {
                    "  "
                };
                
                let text = format!("{}{}{}", prefix, icon, item.name);
                let style = if state.focus_panel == FocusPanel::Explorer && idx == state.explorer_selected {
                    Style::default().fg(COLOR_CYAN).bold().bg(Color::Rgb(30, 41, 59))
                } else {
                    Style::default().fg(COLOR_TEXT_PRIMARY)
                };
                
                ListItem::new(text).style(style)
            })
            .collect();

        let list = List::new(items).block(block).style(Style::default().bg(COLOR_BG));
        f.render_widget(list, explorer_rect);
    }

    // 2b. Render Editor
    let editor_rect = content_chunks[chunk_idx];
    chunk_idx += 1;
    
    let border_style = if state.focus_panel == FocusPanel::Editor {
        Style::default().fg(COLOR_BORDER_ACTIVE)
    } else {
        Style::default().fg(COLOR_BORDER_INACTIVE)
    };

    let title_suffix = if state.editor.modified { " * [Modified]" } else { "" };
    let file_name = state.editor.path
        .as_ref()
        .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".to_string());

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Double)
        .border_style(border_style)
        .title(Span::styled(
            format!(" Editor: {}{} ", file_name, title_suffix),
            Style::default().fg(COLOR_BORDER_ACTIVE).bold(),
        ));

    // Calculate dimensions of editor inner text area
    let inner_editor_rect = block.inner(editor_rect);
    let editor_height = inner_editor_rect.height as usize;
    let editor_width = inner_editor_rect.width as usize;

    // Adjust editor scroll based on cursor position
    // Line number gutter consumes 6 columns: " 123 │ "
    let gutter_width = 7;
    let code_display_width = if editor_width > gutter_width { editor_width - gutter_width } else { 1 };
    state.editor.adjust_scroll(editor_height, code_display_width);

    // Prepare text content for paragraph
    let mut lines = Vec::new();
    let start_line = state.editor.scroll_y;
    let end_line = (start_line + editor_height).min(state.editor.lines.len());

    for idx in start_line..end_line {
        let line_content = &state.editor.lines[idx];
        let line_num = idx + 1;
        
        let is_paused_line = state.paused_line == Some(line_num);
        let has_breakpoint = state.breakpoints.contains(&line_num);
        
        // Gutter styling
        let bp_span = if has_breakpoint {
            Span::styled("● ", Style::default().fg(COLOR_RED))
        } else {
            Span::styled("  ", Style::default().fg(COLOR_TEXT_MUTED))
        };
        
        let pointer_span = if is_paused_line {
            Span::styled("→ ", Style::default().fg(COLOR_YELLOW).bold())
        } else {
            Span::styled("  ", Style::default().fg(COLOR_TEXT_MUTED))
        };
        
        let num_str = format!("{:>3} │ ", line_num);
        let num_span = if is_paused_line {
            Span::styled(num_str, Style::default().fg(COLOR_YELLOW).bold())
        } else {
            Span::styled(num_str, Style::default().fg(COLOR_TEXT_MUTED))
        };

        // Code syntax highlighting
        let mut code_spans = highlight_line(line_content);
        
        // Slice code spans based on horizontal scrolling
        // For simplicity in basic TUI, we just construct line normally or handle character offset
        let mut line_spans = vec![bp_span, pointer_span, num_span];
        line_spans.append(&mut code_spans);

        let line_style = if is_paused_line {
            Style::default().bg(Color::Rgb(59, 45, 10)) // Dark amber highlight
        } else if state.focus_panel == FocusPanel::Editor && idx == state.editor.cursor_y {
            Style::default().bg(Color::Rgb(22, 28, 38)) // Muted current line highlight
        } else {
            Style::default()
        };

        lines.push(Line::from(line_spans).style(line_style));
    }

    // Fill remaining empty space in editor view with empty lines
    while lines.len() < editor_height {
        lines.push(Line::from(""));
    }

    let paragraph = Paragraph::new(lines).block(block).style(Style::default().bg(COLOR_BG));
    f.render_widget(paragraph, editor_rect);

    // 2c. Render Debugger Panel
    if state.is_debugging {
        let debug_rect = content_chunks[chunk_idx];
        
        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(COLOR_YELLOW))
            .title(Span::styled(" Debugger V8 ", Style::default().fg(COLOR_YELLOW).bold()));

        let inner_debug_rect = block.inner(debug_rect);
        
        // Split debugger panel vertically into Variables and Call Stack
        let debug_sub_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Percentage(60),                     // Variables
                Constraint::Percentage(40),                     // Call Stack
            ])
            .split(inner_debug_rect);

        // Variables Box
        let vars_block = Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(COLOR_BORDER_INACTIVE))
            .title(Span::styled(" VARIABLES ", Style::default().fg(COLOR_YELLOW)));
            
        let mut var_lines = Vec::new();
        if state.debug_variables.is_empty() {
            var_lines.push(Line::from(Span::styled("  No variables in scope", Style::default().fg(COLOR_TEXT_MUTED).italic())));
        } else {
            for var in &state.debug_variables {
                var_lines.push(Line::from(vec![
                    Span::styled(format!("  {} ", var.name), Style::default().fg(COLOR_CYAN).bold()),
                    Span::styled(format!("({})", var.val_type), Style::default().fg(COLOR_TEXT_MUTED)),
                    Span::styled(" = ", Style::default().fg(COLOR_TEXT_PRIMARY)),
                    Span::styled(var.value.clone(), Style::default().fg(COLOR_GREEN)),
                ]));
            }
        }
        let vars_paragraph = Paragraph::new(var_lines).block(vars_block).style(Style::default().bg(COLOR_BG));
        f.render_widget(vars_paragraph, debug_sub_chunks[0]);

        // Call Stack Box
        let stack_block = Block::default()
            .title(Span::styled(" CALL STACK ", Style::default().fg(COLOR_YELLOW)));
            
        let mut stack_lines = Vec::new();
        if state.call_frames.is_empty() {
            stack_lines.push(Line::from(Span::styled("  Not paused", Style::default().fg(COLOR_TEXT_MUTED).italic())));
        } else {
            for (i, frame) in state.call_frames.iter().enumerate() {
                let prefix = if i == 0 { " ▶ " } else { "   " };
                let style = if i == 0 {
                    Style::default().fg(COLOR_YELLOW).bold()
                } else {
                    Style::default().fg(COLOR_TEXT_PRIMARY)
                };
                
                stack_lines.push(Line::from(vec![
                    Span::styled(prefix, Style::default().fg(COLOR_YELLOW)),
                    Span::styled(frame.function_name.clone(), style),
                    Span::styled(format!(" line {}:{}", frame.line_number, frame.column_number), Style::default().fg(COLOR_TEXT_MUTED)),
                ]));
            }
        }
        let stack_paragraph = Paragraph::new(stack_lines).block(stack_block).style(Style::default().bg(COLOR_BG));
        f.render_widget(stack_paragraph, debug_sub_chunks[1]);

        f.render_widget(block, debug_rect);
    }

    // 3. Render Bottom Panels (Output/Console Tabs)
    let bottom_border_style = Style::default().fg(COLOR_BORDER_INACTIVE);
    let tab_title = match state.active_bottom_tab {
        BottomTab::Output => " [1: OUTPUT (Active)]  2: CONSOLE ",
        BottomTab::Console => " 1: OUTPUT  [2: CONSOLE (Active)] ",
    };
    
    let bottom_block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(bottom_border_style)
        .title(Span::styled(tab_title, Style::default().fg(COLOR_BORDER_ACTIVE).bold()));

    let inner_bottom_rect = bottom_block.inner(body_chunks[1]);
    let bottom_height = inner_bottom_rect.height as usize;

    let bottom_lines: Vec<Line> = match state.active_bottom_tab {
        BottomTab::Output => {
            // Render Deno runner outputs
            let start = if state.console_output.len() > bottom_height {
                state.console_output.len() - bottom_height
            } else {
                0
            };
            state.console_output[start..]
                .iter()
                .map(|line| {
                    let style = if line.starts_with("ERROR") {
                        Style::default().fg(COLOR_RED)
                    } else if line.starts_with("Debugger") {
                        Style::default().fg(COLOR_YELLOW)
                    } else {
                        Style::default().fg(COLOR_TEXT_PRIMARY)
                    };
                    Line::from(Span::styled(line, style))
                })
                .collect()
        }
        BottomTab::Console => {
            // Render System status logs
            let start = if state.system_logs.len() > bottom_height {
                state.system_logs.len() - bottom_height
            } else {
                0
            };
            state.system_logs[start..]
                .iter()
                .map(|line| {
                    let style = if line.contains("Error") || line.contains("Failed") {
                        Style::default().fg(COLOR_RED)
                    } else if line.contains("V8") || line.contains("breakpoint") {
                        Style::default().fg(COLOR_YELLOW)
                    } else {
                        Style::default().fg(COLOR_TEXT_MUTED)
                    };
                    Line::from(Span::styled(line, style))
                })
                .collect()
        }
    };

    let bottom_paragraph = Paragraph::new(bottom_lines).block(bottom_block).style(Style::default().bg(COLOR_BG));
    f.render_widget(bottom_paragraph, body_chunks[1]);

    // 4. Render Footer Status Bar
    let mode_str = match state.mode {
        AppMode::Normal => " NORMAL ",
        AppMode::Insert => " INSERT ",
        AppMode::Command => " COMMAND ",
        AppMode::Explorer => " EXPLORER ",
    };
    
    let mode_color = match state.mode {
        AppMode::Normal => COLOR_CYAN,
        AppMode::Insert => COLOR_GREEN,
        AppMode::Command => COLOR_ACCENT,
        AppMode::Explorer => COLOR_YELLOW,
    };

    let deno_status_str = if state.is_debugging {
        if state.is_paused { "⏸ PAUSED" } else { "▶ DEBUGGING" }
    } else {
        "💤 IDLE"
    };
    
    let deno_status_color = if state.is_debugging {
        if state.is_paused { COLOR_YELLOW } else { COLOR_GREEN }
    } else {
        COLOR_TEXT_MUTED
    };

    let ln_col_str = format!("Ln {}, Col {}", state.editor.cursor_y + 1, state.editor.cursor_x + 1);

    let status_line = Line::from(vec![
        Span::styled(mode_str, Style::default().bg(mode_color).fg(Color::Black).bold()),
        Span::styled(format!("  {}", file_name), Style::default().fg(COLOR_TEXT_PRIMARY).bold()),
        Span::styled(if state.editor.modified { "*" } else { "" }, Style::default().fg(COLOR_RED).bold()),
        Span::raw("  │  "),
        Span::styled(deno_status_str, Style::default().fg(deno_status_color).bold()),
        Span::raw("  │  "),
        Span::styled(ln_col_str, Style::default().fg(COLOR_TEXT_PRIMARY)),
        Span::styled(format!("  {:>width$}", state.time_string, width = (f.area().width as usize).saturating_sub(55)), Style::default().fg(COLOR_TEXT_MUTED)),
    ]);
    
    let status_bar = Paragraph::new(status_line).style(Style::default().bg(Color::Rgb(30, 41, 59)));
    f.render_widget(status_bar, main_chunks[2]);

    // 5. Render Command Line Input
    if state.mode == AppMode::Command {
        let cmd_line = Line::from(vec![
            Span::styled(":", Style::default().fg(COLOR_ACCENT).bold()),
            Span::raw(&state.command_text),
        ]);
        let cmd_paragraph = Paragraph::new(cmd_line).style(Style::default().bg(COLOR_BG));
        f.render_widget(cmd_paragraph, main_chunks[3]);
    }

    // Set cursor position on screen
    if state.focus_panel == FocusPanel::Editor && (state.mode == AppMode::Insert || state.mode == AppMode::Normal) {
        // Gutter is at screen x = inner_editor_rect.x
        // Line code starts at x = inner_editor_rect.x + gutter_width
        // Scrolling needs to be factored: line character relative to scroll_x
        let cursor_screen_y = inner_editor_rect.y as usize + (state.editor.cursor_y - state.editor.scroll_y);
        let cursor_screen_x = inner_editor_rect.x as usize + gutter_width + (state.editor.cursor_x - state.editor.scroll_x);

        // Ensure within bounds
        if cursor_screen_y < (inner_editor_rect.y + inner_editor_rect.height) as usize
            && cursor_screen_x < (inner_editor_rect.x + inner_editor_rect.width) as usize
        {
            f.set_cursor_position((cursor_screen_x as u16, cursor_screen_y as u16));
        }
    } else if state.mode == AppMode::Command {
        // Put cursor at the end of command line
        let cursor_screen_y = main_chunks[3].y;
        let cursor_screen_x = main_chunks[3].x + 1 + state.command_text.len() as u16;
        f.set_cursor_position((cursor_screen_x, cursor_screen_y));
    }
}

// Basic Syntax Highlighter helper
fn highlight_line(line: &str) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut chars = line.chars().peekable();

    // Style Definitions
    let color_keyword = COLOR_ACCENT;       // Lavender
    let color_string = COLOR_GREEN;         // Mint Green
    let color_number = COLOR_YELLOW;        // Amber/Gold
    let color_builtin = COLOR_CYAN;         // Cyan
    let color_comment = COLOR_TEXT_MUTED;   // Muted Grey
    let color_default = COLOR_TEXT_PRIMARY; // Off-white

    while let Some(&c) = chars.peek() {
        if c == '/' {
            chars.next();
            if chars.peek() == Some(&'/') {
                // Comment
                let mut comment = String::from("//");
                chars.next();
                while let Some(cc) = chars.next() {
                    comment.push(cc);
                }
                spans.push(Span::styled(comment, Style::default().fg(color_comment)));
                break;
            } else {
                spans.push(Span::styled("/", Style::default().fg(color_default)));
            }
        } else if c == '"' || c == '\'' || c == '`' {
            // String literal
            let quote = c;
            chars.next();
            let mut s = String::new();
            s.push(quote);
            while let Some(&cc) = chars.peek() {
                chars.next();
                s.push(cc);
                if cc == quote {
                    break;
                }
            }
            spans.push(Span::styled(s, Style::default().fg(color_string)));
        } else if c.is_ascii_digit() {
            // Number literal
            let mut num = String::new();
            while let Some(&cc) = chars.peek() {
                if cc.is_ascii_digit() || cc == '.' {
                    chars.next();
                    num.push(cc);
                } else {
                    break;
                }
            }
            spans.push(Span::styled(num, Style::default().fg(color_number)));
        } else if c.is_alphanumeric() || c == '_' {
            // Identifier/Keyword
            let mut word = String::new();
            while let Some(&cc) = chars.peek() {
                if cc.is_alphanumeric() || cc == '_' {
                    chars.next();
                    word.push(cc);
                } else {
                    break;
                }
            }

            let style = match word.as_str() {
                "import" | "from" | "const" | "let" | "var" | "function" | "return" | "new" |
                "await" | "async" | "export" | "class" | "if" | "else" | "for" | "while" |
                "try" | "catch" | "throw" | "default" | "as" => {
                    Style::default().fg(color_keyword).add_modifier(Modifier::BOLD)
                }
                "console" | "log" | "Deno" | "Application" | "Router" | "ctx" | "response" | "body" |
                "listen" | "port" | "use" | "routes" | "allowedMethods" => {
                    Style::default().fg(color_builtin)
                }
                _ => Style::default().fg(color_default),
            };
            spans.push(Span::styled(word, style));
        } else {
            // Symbol/Operator/Whitespace
            chars.next();
            spans.push(Span::styled(c.to_string(), Style::default().fg(color_default)));
        }
    }

    if spans.is_empty() && !line.is_empty() {
        spans.push(Span::styled(line.to_string(), Style::default().fg(color_default)));
    }
    spans
}
