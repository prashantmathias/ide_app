package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var (
	colorBG       = lipgloss.Color("#0f1117")
	colorPanel    = lipgloss.Color("#141821")
	colorActive   = lipgloss.Color("#a2c9ff")
	colorInactive = lipgloss.Color("#4f5d75")
	colorText     = lipgloss.Color("#f0f6fc")
	colorMuted    = lipgloss.Color("#8b949e")
	colorAccent   = lipgloss.Color("#d19ae9")
	colorGreen    = lipgloss.Color("#8ac98f")
	colorYellow   = lipgloss.Color("#ffc675")
	colorRed      = lipgloss.Color("#ff7b72")
	colorCyan     = lipgloss.Color("#70def0")
)

func (m *Model) View() string {
	if m.width <= 0 || m.height <= 0 {
		return "CodeCraft is starting..."
	}
	if m.state.ShowHelp {
		return m.renderHelp()
	}
	if m.state.ShowAISettings {
		return m.renderSettings()
	}

	cmdH := 0
	if m.state.Mode == ModeCommand {
		cmdH = 1
	}
	headerH := 1
	statusH := 1
	bottomH := clamp(m.height/3, 7, 14)
	bodyH := max(3, m.height-headerH-statusH-cmdH-bottomH)

	y := 0
	m.headerRect = Rect{0, y, m.width, headerH}
	header := m.renderHeader(m.width)
	y += headerH

	body := m.renderBody(m.width, bodyH, y)
	y += bodyH

	m.bottomRect = Rect{0, y, m.width, bottomH}
	bottom := m.renderBottom(m.width, bottomH)
	y += bottomH

	status := m.renderStatus(m.width)
	y += statusH

	parts := []string{header, body, bottom, status}
	if cmdH == 1 {
		parts = append(parts, m.renderCommand(m.width))
	}
	return lipgloss.NewStyle().Background(colorBG).Render(strings.Join(parts, "\n"))
}

func (m *Model) renderHeader(width int) string {
	title := lipgloss.NewStyle().Foreground(colorActive).Bold(true).Render(" CodeCraft Go ")
	help := lipgloss.NewStyle().Foreground(colorMuted).Render(" Esc Normal | i Insert | : Command | v Explorer | F9 Run | F5 Debug | F2 Settings | F1 Help ")
	return fitLine(title+help, width)
}

func (m *Model) renderBody(width, height, y int) string {
	sideW := 0
	aiW := 0
	debugW := 0
	if m.state.ShowSidebar && width >= 70 {
		sideW = 26
	}
	if m.state.ShowAIPanel && width >= 95 {
		aiW = 36
	}
	if m.state.IsDebugging && width >= 110 {
		debugW = 34
	}
	editorW := max(24, width-sideW-aiW-debugW)
	if sideW+editorW+debugW+aiW > width {
		editorW = max(24, width-sideW-debugW-aiW)
	}

	x := 0
	panels := []string{}
	if sideW > 0 {
		m.explorerRect = Rect{x, y, sideW, height}
		panels = append(panels, m.renderExplorer(sideW, height))
		x += sideW
	} else {
		m.explorerRect = Rect{}
	}

	m.editorRect = Rect{x, y, editorW, height}
	m.editorInnerRect = Rect{x + 1, y + 1, max(1, editorW-2), max(1, height-2)}
	panels = append(panels, m.renderEditor(editorW, height))
	x += editorW

	if debugW > 0 {
		m.debugRect = Rect{x, y, debugW, height}
		panels = append(panels, m.renderDebugger(debugW, height))
		x += debugW
	} else {
		m.debugRect = Rect{}
	}

	if aiW > 0 {
		m.aiRect = Rect{x, y, aiW, height}
		panels = append(panels, m.renderAI(aiW, height))
	} else {
		m.aiRect = Rect{}
	}

	return lipgloss.JoinHorizontal(lipgloss.Top, panels...)
}

func (m *Model) renderExplorer(width, height int) string {
	lines := make([]string, 0, height)
	for i, item := range m.state.ExplorerItems {
		prefix := "  "
		if i == m.state.ExplorerSelected && m.state.FocusPanel == FocusExplorer {
			prefix = "> "
		}
		icon := "[F]"
		if item.IsDir {
			icon = "[D]"
		}
		style := lipgloss.NewStyle().Foreground(colorText)
		if i == m.state.ExplorerSelected {
			style = style.Foreground(colorCyan).Bold(true)
		}
		lines = append(lines, style.Render(truncateRunes(prefix+icon+" "+item.Name, width-4)))
	}
	if m.state.ExplorerInputMode != "" {
		lines = append(lines, "", lipgloss.NewStyle().Foreground(colorYellow).Render("New "+m.state.ExplorerInputMode+":"))
		lines = append(lines, "> "+m.state.ExplorerInput)
	}
	return panel("File Explorer", strings.Join(padLines(lines, max(0, height-2)), "\n"), width, height, m.state.FocusPanel == FocusExplorer)
}

func (m *Model) renderEditor(width, height int) string {
	contentW := max(1, width-2)
	contentH := max(1, height-2)
	gutterW := 9
	codeW := max(1, contentW-gutterW)
	m.state.Editor.AdjustScroll(contentH, codeW)

	lines := make([]string, 0, contentH)
	start := m.state.Editor.ScrollY
	end := min(len(m.state.Editor.Lines), start+contentH)
	for i := start; i < end; i++ {
		lineNo := i + 1
		bp := "  "
		if m.state.Breakpoints[lineNo] {
			bp = lipgloss.NewStyle().Foreground(colorRed).Render("* ")
		}
		ptr := "  "
		if m.state.PausedLine == lineNo {
			ptr = lipgloss.NewStyle().Foreground(colorYellow).Bold(true).Render("> ")
		}
		gutter := fmt.Sprintf("%s%s%3d | ", bp, ptr, lineNo)
		code := sliceRunes(m.state.Editor.Lines[i], m.state.Editor.ScrollX, codeW)
		code = highlightLine(code)
		row := gutter + code
		if i == m.state.Editor.CursorY && m.state.FocusPanel == FocusEditor {
			row = lipgloss.NewStyle().Background(lipgloss.Color("#161c26")).Render(fitLine(row, contentW))
		}
		if m.state.PausedLine == lineNo {
			row = lipgloss.NewStyle().Background(lipgloss.Color("#3b2d0a")).Render(fitLine(row, contentW))
		}
		lines = append(lines, row)
	}
	for len(lines) < contentH {
		lines = append(lines, "")
	}
	title := "Editor: " + m.state.ActiveFileName()
	if m.state.Editor.Modified {
		title += " *"
	}
	return panel(title, strings.Join(lines, "\n"), width, height, m.state.FocusPanel == FocusEditor)
}

func (m *Model) renderDebugger(width, height int) string {
	bodyH := max(1, height-2)
	varH := max(2, bodyH*3/5)
	stackH := bodyH - varH
	var lines []string
	lines = append(lines, lipgloss.NewStyle().Foreground(colorYellow).Bold(true).Render("VARIABLES"))
	if len(m.state.DebugVariables) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(colorMuted).Render("No variables in scope"))
	} else {
		for _, v := range m.state.DebugVariables {
			lines = append(lines, lipgloss.NewStyle().Foreground(colorCyan).Render(v.Name)+" "+
				lipgloss.NewStyle().Foreground(colorMuted).Render("("+v.ValType+")")+" = "+
				lipgloss.NewStyle().Foreground(colorGreen).Render(v.Value))
		}
	}
	lines = padLines(lines, varH)
	lines = append(lines, lipgloss.NewStyle().Foreground(colorYellow).Bold(true).Render("CALL STACK"))
	if len(m.state.CallFrames) == 0 {
		lines = append(lines, lipgloss.NewStyle().Foreground(colorMuted).Render("Not paused"))
	} else {
		for i, f := range m.state.CallFrames {
			prefix := "  "
			if i == 0 {
				prefix = "> "
			}
			lines = append(lines, fmt.Sprintf("%s%s line %d:%d", prefix, f.FunctionName, f.LineNumber, f.ColumnNumber))
		}
	}
	lines = padLines(lines, varH+stackH)
	return panel("Debugger V8", strings.Join(lines, "\n"), width, height, true)
}

func (m *Model) renderAI(width, height int) string {
	contentH := max(1, height-2)
	inputH := 3
	statusH := 1
	chatH := max(1, contentH-inputH-statusH)
	contentW := max(1, width-4)
	var chat []string
	for _, msg := range m.state.AIChatHistory {
		prefix := "A> "
		style := lipgloss.NewStyle().Foreground(colorMuted)
		if msg.Sender == "U" {
			prefix = "U> "
			style = lipgloss.NewStyle().Foreground(colorText)
		}
		wrapped := wrapPlain(prefix+msg.Text, contentW)
		for _, line := range wrapped {
			chat = append(chat, style.Render(line))
		}
		chat = append(chat, "")
	}
	maxScroll := max(0, len(chat)-chatH)
	m.state.AIChatScroll = clamp(m.state.AIChatScroll, 0, maxScroll)
	chat = chat[m.state.AIChatScroll:]
	chat = padLines(chat, chatH)

	statusStyle := lipgloss.NewStyle().Foreground(colorGreen).Bold(true)
	if m.state.AIStatus == "THINKING" {
		statusStyle = statusStyle.Foreground(colorYellow)
	}
	lines := append([]string{}, chat...)
	lines = append(lines, statusStyle.Render("AGENT: "+m.state.AIStatus))
	lines = append(lines, lipgloss.NewStyle().Foreground(colorYellow).Render("> ")+m.state.AIInput)
	lines = append(lines, lipgloss.NewStyle().Foreground(colorMuted).Render("Enter sends | Ctrl+A hides"))
	return panel("AI Agent", strings.Join(padLines(lines, contentH), "\n"), width, height, m.state.FocusPanel == FocusAI)
}

func (m *Model) renderBottom(width, height int) string {
	title := "1 Output  2 Console  3 Terminal"
	var lines []string
	switch m.state.ActiveBottomTab {
	case TabOutput:
		title = "[1 Output]  2 Console  3 Terminal"
		lines = tail(m.state.ConsoleOutput, max(0, height-2))
	case TabConsole:
		title = "1 Output  [2 Console]  3 Terminal"
		lines = tail(m.state.SystemLogs, max(0, height-2))
	case TabTerminal:
		title = "1 Output  2 Console  [3 Terminal]"
		outH := max(0, height-3)
		lines = append(lines, tail(m.state.TerminalOutput, outH)...)
		lines = append(lines, "$ "+m.state.TerminalInput)
	}
	styled := make([]string, 0, len(lines))
	for _, line := range lines {
		style := lipgloss.NewStyle().Foreground(colorText)
		if strings.Contains(strings.ToLower(line), "error") || strings.Contains(strings.ToLower(line), "failed") {
			style = style.Foreground(colorRed)
		} else if strings.Contains(strings.ToLower(line), "debug") || strings.Contains(strings.ToLower(line), "breakpoint") {
			style = style.Foreground(colorYellow)
		} else if m.state.ActiveBottomTab == TabConsole {
			style = style.Foreground(colorMuted)
		}
		styled = append(styled, style.Render(line))
	}
	return panel(title, strings.Join(padLines(styled, max(0, height-2)), "\n"), width, height, m.state.FocusPanel == FocusTerminal)
}

func (m *Model) renderStatus(width int) string {
	mode := "NORMAL"
	modeColor := colorCyan
	switch m.state.Mode {
	case ModeInsert:
		mode, modeColor = "INSERT", colorGreen
	case ModeCommand:
		mode, modeColor = "COMMAND", colorAccent
	case ModeExplorer:
		mode, modeColor = "EXPLORER", colorYellow
	}
	deno := "IDLE"
	denoColor := colorMuted
	if m.state.IsDebugging {
		deno, denoColor = "DEBUGGING", colorGreen
		if m.state.IsPaused {
			deno, denoColor = "PAUSED", colorYellow
		}
	}
	file := m.state.ActiveFileName()
	if m.state.Editor.Modified {
		file += "*"
	}
	left := lipgloss.NewStyle().Background(modeColor).Foreground(lipgloss.Color("#000000")).Bold(true).Render(" " + mode + " ")
	right := fmt.Sprintf(" %s | %s | Ln %d, Col %d | %s", file, lipgloss.NewStyle().Foreground(denoColor).Render(deno), m.state.Editor.CursorY+1, m.state.Editor.CursorX+1, m.state.TimeString)
	return fitLine(left+right, width)
}

func (m *Model) renderCommand(width int) string {
	return fitLine(lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(":")+m.state.CommandText, width)
}

func (m *Model) renderHelp() string {
	lines := []string{
		"Keyboard Shortcuts",
		"",
		"General:  F1 help, F2 AI settings, Ctrl+A AI panel, Ctrl+Q quit",
		"Modes:    Esc normal, i insert, : command, v explorer, Tab focus",
		"Editor:   arrows/hjkl move, b breakpoint, x/delete delete",
		"Run:      F9 run, F5 debug/resume, F10 step over, F11 step into",
		"Tabs:     1 output, 2 console, 3 terminal",
		"Explorer: n new file, f new directory, enter open, r run, d debug",
		"Command:  :w save, :q quit, :r run, :d debug, :bp <line>",
		"AI:       enter sends when AI input is focused",
		"",
		"Press any key to close.",
	}
	box := panel("Help", strings.Join(lines, "\n"), min(74, m.width), min(18, m.height), true)
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

func (m *Model) renderSettings() string {
	values := []struct {
		Name   string
		Value  string
		Secret bool
	}{
		{"System Prompt", m.state.Settings.SystemPrompt, false},
		{"Base URL", m.state.Settings.BaseURL, false},
		{"API Key", m.state.Settings.APIKey, true},
		{"Model", m.state.Settings.Model, false},
	}
	var lines []string
	for i, field := range values {
		name := "  " + field.Name
		if i == m.state.AISettingsFocus {
			name = "> " + field.Name
		}
		value := field.Value
		if field.Secret && m.state.Mode != ModeInsert {
			value = strings.Repeat("*", len([]rune(value)))
		}
		for _, line := range wrapPlain(value, 58) {
			lines = append(lines, lipgloss.NewStyle().Foreground(colorYellow).Render(name)+": "+line)
			name = "  "
		}
		lines = append(lines, "")
	}
	if m.state.Mode == ModeInsert {
		lines = append(lines, "Editing. Esc returns to selection.")
	} else {
		lines = append(lines, "Up/Down select. i or Enter edit. F2 or Esc saves and closes.")
	}
	box := panel("AI Agent Settings", strings.Join(lines, "\n"), min(72, m.width), min(24, m.height), true)
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

func panel(title, content string, width, height int, active bool) string {
	border := colorInactive
	if active {
		border = colorActive
	}
	return lipgloss.NewStyle().
		Width(max(1, width-2)).
		Height(max(0, height-2)).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(border).
		Foreground(colorText).
		Background(colorBG).
		BorderTop(true).
		BorderBottom(true).
		BorderLeft(true).
		BorderRight(true).
		Render(lipgloss.NewStyle().Background(colorBG).Render(titleLine(title, width-2) + "\n" + content))
}

func titleLine(title string, width int) string {
	return lipgloss.NewStyle().Foreground(colorActive).Bold(true).Render(" " + truncateRunes(title, max(1, width-2)) + " ")
}

func fitLine(s string, width int) string {
	if width <= 0 {
		return ""
	}
	rawWidth := lipgloss.Width(s)
	if rawWidth > width {
		return truncateRunes(s, width)
	}
	if rawWidth < width {
		return s + strings.Repeat(" ", width-rawWidth)
	}
	return s
}

func highlightLine(line string) string {
	keyword := lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	builtin := lipgloss.NewStyle().Foreground(colorCyan)
	comment := lipgloss.NewStyle().Foreground(colorMuted)
	stringStyle := lipgloss.NewStyle().Foreground(colorGreen)
	numberStyle := lipgloss.NewStyle().Foreground(colorYellow)
	if strings.HasPrefix(strings.TrimSpace(line), "//") {
		return comment.Render(line)
	}
	words := strings.FieldsFunc(line, func(r rune) bool {
		return !(r == '_' || r == '$' || r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z')
	})
	out := line
	for _, word := range words {
		style := lipgloss.Style{}
		styled := true
		switch word {
		case "import", "from", "const", "let", "var", "function", "return", "new", "await", "async", "export", "class", "if", "else", "for", "while", "try", "catch", "throw":
			style = keyword
		case "console", "log", "Deno", "Application", "Router", "ctx", "response", "listen":
			style = builtin
		default:
			if len(word) > 0 && word[0] >= '0' && word[0] <= '9' {
				style = numberStyle
			} else {
				styled = false
			}
		}
		if styled {
			out = strings.ReplaceAll(out, word, style.Render(word))
		}
	}
	if idx := strings.Index(out, "//"); idx >= 0 {
		out = out[:idx] + comment.Render(out[idx:])
	}
	if strings.Contains(out, "\"") || strings.Contains(out, "'") || strings.Contains(out, "`") {
		out = colorQuotedStrings(out, stringStyle)
	}
	return out
}

func colorQuotedStrings(s string, style lipgloss.Style) string {
	var b strings.Builder
	inQuote := rune(0)
	var quoted strings.Builder
	for _, r := range s {
		if inQuote == 0 {
			if r == '"' || r == '\'' || r == '`' {
				inQuote = r
				quoted.Reset()
				quoted.WriteRune(r)
			} else {
				b.WriteRune(r)
			}
			continue
		}
		quoted.WriteRune(r)
		if r == inQuote {
			b.WriteString(style.Render(quoted.String()))
			inQuote = 0
		}
	}
	if inQuote != 0 {
		b.WriteString(style.Render(quoted.String()))
	}
	return b.String()
}

func relativePath(root, path string) string {
	if path == "" {
		return ""
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return rel
}
