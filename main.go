package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

type Model struct {
	state           *AppState
	width           int
	height          int
	eventCh         chan tea.Msg
	debugCh         chan debuggerCommandMsg
	headerRect      Rect
	explorerRect    Rect
	editorRect      Rect
	editorInnerRect Rect
	debugRect       Rect
	aiRect          Rect
	bottomRect      Rect
}

func main() {
	root, err := os.Getwd()
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	if len(os.Args) > 1 {
		root, err = filepath.Abs(os.Args[1])
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
	}
	if err := os.Chdir(root); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}

	model := NewModel(root)
	program := tea.NewProgram(model, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := program.Run(); err != nil {
		fmt.Println("CodeCraft crashed:", err)
		os.Exit(1)
	}
}

func NewModel(root string) *Model {
	st := NewAppState(root)
	loadStartupFile(st)
	st.Log("IDE Ready. Press F9 to Run, F5 to Debug, v to browse files.")
	return &Model{
		state:   st,
		width:   120,
		height:  36,
		eventCh: make(chan tea.Msg, 128),
	}
}

func loadStartupFile(st *AppState) {
	if path := filepath.Join(st.Root, "main.ts"); fileExists(path) {
		if err := st.Editor.Load(path); err != nil {
			st.Log("Error loading startup file: " + err.Error())
		} else {
			st.Log("Loaded startup file: main.ts")
		}
		return
	}
	for _, item := range st.ExplorerItems {
		if !item.IsDir {
			if err := st.Editor.Load(item.Path); err != nil {
				st.Log("Error loading startup file: " + err.Error())
			} else {
				st.Log("Loaded startup file: " + item.Name)
			}
			return
		}
	}
}

func (m *Model) Init() tea.Cmd {
	return tea.Batch(tickCmd(), waitExternal(m.eventCh))
}

func tickCmd() tea.Cmd {
	return tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func waitExternal(ch <-chan tea.Msg) tea.Cmd {
	return func() tea.Msg {
		return <-ch
	}
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case tickMsg:
		m.state.TimeString = time.Time(msg).Format("15:04:05")
		m.state.ReadWorkspaceDir()
		return m, tickCmd()
	case denoMsg:
		m.handleDenoMsg(msg)
		return m, waitExternal(m.eventCh)
	case terminalLineMsg:
		m.state.TerminalOutput = append(m.state.TerminalOutput, msg.Line)
		return m, waitExternal(m.eventCh)
	case aiLogMsg:
		m.state.Log(msg.Text)
		m.state.AIChatHistory = append(m.state.AIChatHistory, ChatMessage{Sender: "A", Text: msg.Text})
		m.state.AIChatScroll = max(0, len(m.state.AIChatHistory)*2)
		m.state.ReadWorkspaceDir()
		return m, waitExternal(m.eventCh)
	case aiDoneMsg:
		if msg.Err != nil {
			m.state.Log("[AI] request failed: " + msg.Err.Error())
			m.state.AIChatHistory = append(m.state.AIChatHistory, ChatMessage{Sender: "A", Text: "Error: " + msg.Err.Error()})
		} else {
			m.state.Log("[AI] responded successfully.")
			m.state.AIChatHistory = append(m.state.AIChatHistory, ChatMessage{Sender: "A", Text: msg.Reply})
		}
		m.state.AIStatus = "LISTENING"
		m.state.AIChatScroll = max(0, len(m.state.AIChatHistory)*2)
		m.state.ReadWorkspaceDir()
		return m, waitExternal(m.eventCh)
	case tea.MouseMsg:
		m.handleMouse(msg)
	case tea.KeyMsg:
		if cmd := m.handleKey(msg); cmd != nil {
			return m, cmd
		}
	}
	return m, nil
}

func (m *Model) handleKey(key tea.KeyMsg) tea.Cmd {
	k := key.String()
	if k == "ctrl+q" {
		m.state.SaveAISettings()
		return tea.Quit
	}
	if k == "f1" {
		m.state.ShowHelp = !m.state.ShowHelp
		return nil
	}
	if k == "f2" {
		if m.state.Mode == ModeInsert {
			m.state.Mode = ModeNormal
		}
		m.state.ShowAISettings = !m.state.ShowAISettings
		if !m.state.ShowAISettings {
			m.state.SaveAISettings()
		}
		return nil
	}
	if m.state.ShowHelp {
		m.state.ShowHelp = false
		return nil
	}
	if m.state.ShowAISettings {
		m.handleSettingsKey(key)
		return nil
	}
	if k == "ctrl+a" {
		m.state.ShowAIPanel = !m.state.ShowAIPanel
		if m.state.ShowAIPanel {
			m.state.FocusPanel = FocusAI
		} else if m.state.FocusPanel == FocusAI {
			m.state.FocusPanel = FocusEditor
		}
		m.state.Mode = ModeNormal
		m.state.Log(fmt.Sprintf("AI Panel visibility: %v", m.state.ShowAIPanel))
		return nil
	}

	switch m.state.Mode {
	case ModeNormal:
		return m.handleNormalKey(key)
	case ModeInsert:
		return m.handleInsertKey(key)
	case ModeExplorer:
		return m.handleExplorerKey(key)
	case ModeCommand:
		return m.handleCommandKey(key)
	default:
		return nil
	}
}

func (m *Model) handleSettingsKey(key tea.KeyMsg) {
	k := key.String()
	if m.state.Mode == ModeNormal {
		switch k {
		case "esc":
			m.state.ShowAISettings = false
			m.state.SaveAISettings()
		case "up", "k", "shift+tab":
			m.state.AISettingsFocus = max(0, m.state.AISettingsFocus-1)
		case "down", "j", "tab":
			m.state.AISettingsFocus = min(3, m.state.AISettingsFocus+1)
		case "i", "enter":
			m.state.Mode = ModeInsert
		}
		return
	}
	if m.state.Mode == ModeInsert {
		switch k {
		case "esc":
			m.state.Mode = ModeNormal
		case "backspace":
			m.popSettingsField()
		default:
			if key.Type == tea.KeyRunes {
				m.appendSettingsField(string(key.Runes))
			}
		}
	}
}

func (m *Model) handleNormalKey(key tea.KeyMsg) tea.Cmd {
	k := key.String()
	switch k {
	case "i":
		m.state.Mode = ModeInsert
		if m.state.FocusPanel != FocusAI && m.state.FocusPanel != FocusTerminal {
			m.state.FocusPanel = FocusEditor
		}
		m.state.Log("Mode: INSERT")
	case ":":
		m.state.Mode = ModeCommand
		m.state.CommandText = ""
	case "v":
		m.state.Mode = ModeExplorer
		m.state.FocusPanel = FocusExplorer
		m.state.Log("Mode: EXPLORER")
	case "tab":
		m.cycleFocus()
	case "b":
		m.toggleBreakpoint(m.state.Editor.CursorY + 1)
	case "f9":
		m.runActiveFile(false)
	case "f5":
		if m.state.IsDebugging && m.state.IsPaused {
			m.sendDebug(DebugResume, 0)
		} else if !m.state.IsDebugging {
			m.runActiveFile(true)
		}
	case "f10":
		if m.state.IsDebugging && m.state.IsPaused {
			m.sendDebug(DebugStepOver, 0)
		}
	case "f11":
		if m.state.IsDebugging && m.state.IsPaused {
			m.sendDebug(DebugStepInto, 0)
		}
	case "1":
		m.state.ActiveBottomTab = TabOutput
	case "2":
		m.state.ActiveBottomTab = TabConsole
	case "3":
		m.state.ActiveBottomTab = TabTerminal
		m.state.FocusPanel = FocusTerminal
	case "up", "k":
		m.moveUp()
	case "down", "j":
		m.moveDown()
	case "left", "h":
		if m.state.FocusPanel == FocusEditor {
			m.state.Editor.MoveLeft()
		}
	case "right", "l":
		if m.state.FocusPanel == FocusEditor {
			m.state.Editor.MoveRight()
		}
	case "delete", "x":
		if m.state.FocusPanel == FocusEditor {
			m.state.Editor.Delete()
		}
	case "backspace":
		if m.state.FocusPanel == FocusEditor {
			m.state.Editor.MoveLeft()
		}
	case "enter":
		if m.state.FocusPanel == FocusAI {
			m.sendAIQuery()
		} else if m.state.FocusPanel == FocusTerminal {
			m.executeTerminalCommand()
		}
	}
	return nil
}

func (m *Model) handleInsertKey(key tea.KeyMsg) tea.Cmd {
	k := key.String()
	switch k {
	case "esc":
		m.state.Mode = ModeNormal
		m.state.Log("Mode: NORMAL")
	case "enter":
		if m.state.FocusPanel == FocusAI {
			m.sendAIQuery()
		} else if m.state.FocusPanel == FocusTerminal {
			m.executeTerminalCommand()
		} else {
			m.state.Editor.InsertNewline()
		}
	case "tab":
		if m.state.FocusPanel == FocusEditor {
			m.state.Editor.InsertTab()
		}
	case "backspace":
		if m.state.FocusPanel == FocusAI {
			m.state.AIInput = popRune(m.state.AIInput)
		} else if m.state.FocusPanel == FocusTerminal {
			m.state.TerminalInput = popRune(m.state.TerminalInput)
		} else {
			m.state.Editor.Backspace()
		}
	case "delete":
		if m.state.FocusPanel == FocusEditor {
			m.state.Editor.Delete()
		}
	case "up":
		m.moveUp()
	case "down":
		m.moveDown()
	case "left":
		if m.state.FocusPanel == FocusEditor {
			m.state.Editor.MoveLeft()
		}
	case "right":
		if m.state.FocusPanel == FocusEditor {
			m.state.Editor.MoveRight()
		}
	default:
		if key.Type == tea.KeyRunes {
			text := string(key.Runes)
			if m.state.FocusPanel == FocusAI {
				m.state.AIInput += text
			} else if m.state.FocusPanel == FocusTerminal {
				m.state.TerminalInput += text
			} else {
				m.state.Editor.InsertText(text)
			}
		}
	}
	return nil
}

func (m *Model) handleExplorerKey(key tea.KeyMsg) tea.Cmd {
	k := key.String()
	if m.state.ExplorerInputMode != "" {
		switch k {
		case "esc":
			m.state.ExplorerInputMode = ""
			m.state.ExplorerInput = ""
		case "enter":
			m.createExplorerItem()
		case "backspace":
			m.state.ExplorerInput = popRune(m.state.ExplorerInput)
		default:
			if key.Type == tea.KeyRunes {
				m.state.ExplorerInput += string(key.Runes)
			}
		}
		return nil
	}
	switch k {
	case "n":
		m.state.ExplorerInputMode = "File"
		m.state.ExplorerInput = ""
	case "f":
		m.state.ExplorerInputMode = "Directory"
		m.state.ExplorerInput = ""
	case "esc":
		m.state.Mode = ModeNormal
		m.state.FocusPanel = FocusEditor
		m.state.Log("Mode: NORMAL")
	case "up", "k":
		if m.state.ExplorerSelected > 0 {
			m.state.ExplorerSelected--
		}
	case "down", "j":
		if m.state.ExplorerSelected < len(m.state.ExplorerItems)-1 {
			m.state.ExplorerSelected++
		}
	case "enter":
		m.openExplorerSelection()
	case "r":
		if m.openExplorerSelection() {
			m.runActiveFile(false)
		}
	case "d":
		if m.openExplorerSelection() {
			m.runActiveFile(true)
		}
	}
	return nil
}

func (m *Model) handleCommandKey(key tea.KeyMsg) tea.Cmd {
	k := key.String()
	switch k {
	case "esc":
		m.state.Mode = ModeNormal
		m.state.CommandText = ""
	case "backspace":
		m.state.CommandText = popRune(m.state.CommandText)
		if m.state.CommandText == "" {
			m.state.Mode = ModeNormal
		}
	case "enter":
		cmd := strings.TrimSpace(m.state.CommandText)
		m.state.CommandText = ""
		m.state.Mode = ModeNormal
		if m.executeCommand(cmd) {
			return tea.Quit
		}
	default:
		if key.Type == tea.KeyRunes {
			m.state.CommandText += string(key.Runes)
		}
	}
	return nil
}

func (m *Model) cycleFocus() {
	switch m.state.FocusPanel {
	case FocusEditor:
		if m.state.ShowAIPanel {
			m.state.FocusPanel = FocusAI
		} else if m.state.ShowSidebar {
			m.state.FocusPanel = FocusExplorer
			m.state.Mode = ModeExplorer
			return
		}
	case FocusAI:
		if m.state.ShowSidebar {
			m.state.FocusPanel = FocusExplorer
			m.state.Mode = ModeExplorer
			return
		}
		m.state.FocusPanel = FocusEditor
	case FocusExplorer, FocusTerminal:
		m.state.FocusPanel = FocusEditor
	}
	m.state.Mode = ModeNormal
	m.state.Log("Focused panel: " + focusName(m.state.FocusPanel))
}

func (m *Model) moveUp() {
	if m.state.FocusPanel == FocusAI {
		m.state.AIChatScroll = max(0, m.state.AIChatScroll-1)
	} else if m.state.FocusPanel == FocusTerminal {
		m.state.TerminalScroll = max(0, m.state.TerminalScroll-1)
	} else {
		m.state.Editor.MoveUp()
	}
}

func (m *Model) moveDown() {
	if m.state.FocusPanel == FocusAI {
		m.state.AIChatScroll++
	} else if m.state.FocusPanel == FocusTerminal {
		m.state.TerminalScroll++
	} else {
		m.state.Editor.MoveDown()
	}
}

func (m *Model) executeCommand(cmd string) bool {
	switch {
	case cmd == "w" || cmd == "write":
		if err := m.state.Editor.Save(); err != nil {
			m.state.Log("Failed to save: " + err.Error())
		} else {
			m.state.Log("File saved successfully.")
			m.state.ReadWorkspaceDir()
		}
	case cmd == "q" || cmd == "quit":
		m.state.SaveAISettings()
		return true
	case cmd == "r" || cmd == "run":
		m.runActiveFile(false)
	case cmd == "d" || cmd == "debug":
		m.runActiveFile(true)
	case strings.HasPrefix(cmd, "bp "):
		var line int
		if _, err := fmt.Sscanf(strings.TrimSpace(strings.TrimPrefix(cmd, "bp ")), "%d", &line); err != nil {
			m.state.Log("Usage: :bp <line_number>")
		} else {
			m.toggleBreakpoint(line)
		}
	case cmd == "help":
		m.state.ShowHelp = true
	default:
		m.state.Log("Command not recognized: :" + cmd)
	}
	return false
}

func (m *Model) createExplorerItem() {
	name := strings.TrimSpace(m.state.ExplorerInput)
	mode := m.state.ExplorerInputMode
	defer func() {
		m.state.ExplorerInputMode = ""
		m.state.ExplorerInput = ""
		m.state.ReadWorkspaceDir()
	}()
	if name == "" {
		return
	}
	path, err := safeWorkspacePath(m.state.Root, name)
	if err != nil {
		m.state.Log("Invalid path: " + err.Error())
		return
	}
	if mode == "Directory" {
		if err := os.MkdirAll(path, 0o755); err != nil {
			m.state.Log("Failed to create directory: " + err.Error())
		}
		return
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		m.state.Log("Failed to create file: " + err.Error())
		return
	}
	_ = file.Close()
}

func (m *Model) openExplorerSelection() bool {
	if len(m.state.ExplorerItems) == 0 {
		return false
	}
	item := m.state.ExplorerItems[m.state.ExplorerSelected]
	if item.IsDir {
		m.state.Log("Directory selected: " + item.Name)
		return false
	}
	if err := m.state.Editor.Load(item.Path); err != nil {
		m.state.Log("Failed to load file: " + err.Error())
		return false
	}
	m.state.Log("Loaded file: " + relativePath(m.state.Root, item.Path))
	m.state.FocusPanel = FocusEditor
	m.state.Mode = ModeNormal
	return true
}

func (m *Model) toggleBreakpoint(line int) {
	wasSet := m.state.Breakpoints[line]
	m.state.ToggleBreakpoint(line)
	if wasSet {
		m.sendDebug(DebugRemoveBreakpoint, line)
	} else {
		m.sendDebug(DebugSetBreakpoint, line)
	}
}

func (m *Model) sendDebug(command DebuggerCommand, line int) {
	if m.debugCh == nil {
		return
	}
	filename := m.state.Editor.Path
	select {
	case m.debugCh <- debuggerCommandMsg{Command: command, Line: line, Filename: filename}:
	default:
		m.state.Log("Debugger command queue is full.")
	}
}

func (m *Model) runActiveFile(inspect bool) {
	if m.state.Editor.Path == "" {
		m.state.Log("No file open to run.")
		return
	}
	if m.state.Editor.Modified {
		if err := m.state.Editor.Save(); err != nil {
			m.state.Log("Failed to save before run: " + err.Error())
			return
		}
		m.state.Log("Saved modified file before run.")
	}
	path := m.state.Editor.Path
	args := "deno run -A "
	if inspect {
		args += "--inspect-brk "
	}
	args += relativePath(m.state.Root, path)
	m.state.ConsoleOutput = []string{"$ " + args}
	m.state.ActiveBottomTab = TabOutput
	m.state.IsDebugging = inspect
	m.state.IsPaused = false
	m.state.PausedLine = 0
	m.state.CallFrames = nil
	m.state.DebugVariables = nil
	m.debugCh = startDeno(m.state.Root, path, inspect, m.state.BreakpointLines(), m.eventCh)
}

func (m *Model) sendAIQuery() {
	query := strings.TrimSpace(m.state.AIInput)
	if query == "" {
		return
	}
	m.state.Log("[AI] Sending query: " + query)
	m.state.AIChatHistory = append(m.state.AIChatHistory, ChatMessage{Sender: "U", Text: query})
	m.state.AIInput = ""
	m.state.AIStatus = "THINKING"
	m.state.AIChatScroll = max(0, len(m.state.AIChatHistory)*2)
	history := append([]ChatMessage(nil), m.state.AIChatHistory...)
	settings := m.state.Settings
	root := m.state.Root
	go runAIQuery(root, history, settings, m.eventCh)
}

func (m *Model) executeTerminalCommand() {
	cmdText := strings.TrimSpace(m.state.TerminalInput)
	if cmdText == "" {
		return
	}
	m.state.TerminalOutput = append(m.state.TerminalOutput, "$ "+cmdText)
	m.state.TerminalInput = ""
	root := m.state.Root
	ch := m.eventCh
	go func() {
		cmd := shellCommand(root, cmdText)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			ch <- terminalLineMsg{Line: "Failed to capture stdout: " + err.Error()}
			return
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			ch <- terminalLineMsg{Line: "Failed to capture stderr: " + err.Error()}
			return
		}
		if err := cmd.Start(); err != nil {
			ch <- terminalLineMsg{Line: "Failed to execute command: " + err.Error()}
			return
		}
		done := make(chan struct{}, 2)
		go streamReader(stdout, func(line string) { ch <- terminalLineMsg{Line: line} }, done)
		go streamReader(stderr, func(line string) { ch <- terminalLineMsg{Line: "ERR: " + line} }, done)
		<-done
		<-done
		if err := cmd.Wait(); err != nil {
			ch <- terminalLineMsg{Line: "Process exited with error: " + err.Error()}
		}
	}()
}

func streamReader(r io.Reader, each func(string), done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		each(scanner.Text())
	}
}

func (m *Model) handleDenoMsg(msg denoMsg) {
	switch msg.Kind {
	case "stdout":
		m.state.Output(msg.Line)
	case "stderr":
		if !strings.Contains(msg.Line, "Debugger listening on ws://") {
			m.state.Output("ERR: " + msg.Line)
		}
	case "debugger_listening":
		m.state.Log("[Debugger] V8 listening on " + msg.URL)
	case "debugger_connected":
		m.state.Log("[Debugger] Attached successfully.")
		m.state.IsDebugging = true
	case "paused":
		m.state.IsPaused = true
		m.state.CallFrames = msg.Frames
		m.state.DebugVariables = msg.Variables
		if len(msg.Frames) > 0 {
			top := msg.Frames[0]
			m.state.PausedLine = top.LineNumber
			m.state.Editor.CursorY = max(0, top.LineNumber-1)
			m.state.Editor.CursorX = max(0, top.ColumnNumber)
			m.state.Log(fmt.Sprintf("[Debugger] Paused at line %d", top.LineNumber))
		}
	case "resumed":
		m.state.IsPaused = false
		m.state.PausedLine = 0
		m.state.CallFrames = nil
		m.state.DebugVariables = nil
		m.state.Log("[Debugger] Resumed execution")
	case "finished":
		m.state.IsDebugging = false
		m.state.IsPaused = false
		m.state.PausedLine = 0
		m.state.CallFrames = nil
		m.state.DebugVariables = nil
		m.debugCh = nil
		m.state.Log(fmt.Sprintf("[Runner] Process exited with status %d", msg.Code))
		m.state.Output(fmt.Sprintf("[Process exited with code %d]", msg.Code))
	case "error":
		m.state.Log("Error: " + msg.Err)
		m.state.Output("Error: " + msg.Err)
	}
}

func (m *Model) handleMouse(msg tea.MouseMsg) {
	x, y := msg.X, msg.Y
	switch {
	case msg.Button == tea.MouseButtonWheelUp:
		if m.aiRect.Contains(x, y) {
			m.state.AIChatScroll = max(0, m.state.AIChatScroll-1)
		} else if m.editorRect.Contains(x, y) {
			m.state.Editor.ScrollY = max(0, m.state.Editor.ScrollY-1)
		}
	case msg.Button == tea.MouseButtonWheelDown:
		if m.aiRect.Contains(x, y) {
			m.state.AIChatScroll++
		} else if m.editorRect.Contains(x, y) {
			m.state.Editor.ScrollY = min(len(m.state.Editor.Lines)-1, m.state.Editor.ScrollY+1)
		}
	case msg.Button == tea.MouseButtonLeft && msg.Action == tea.MouseActionPress:
		m.handleMousePress(x, y)
	}
}

func (m *Model) handleMousePress(x, y int) {
	if m.headerRect.Contains(x, y) {
		switch {
		case x < 24:
			m.state.FocusPanel = FocusEditor
			m.state.Mode = ModeNormal
		case x < 48:
			m.state.Mode = ModeInsert
			m.state.FocusPanel = FocusEditor
		case x < 62:
			m.state.Mode = ModeCommand
			m.state.CommandText = ""
		case x < 80:
			m.state.Mode = ModeExplorer
			m.state.FocusPanel = FocusExplorer
		case x < 90:
			m.runActiveFile(false)
		case x < 102:
			if m.state.IsDebugging && m.state.IsPaused {
				m.sendDebug(DebugResume, 0)
			} else if !m.state.IsDebugging {
				m.runActiveFile(true)
			}
		}
		return
	}
	if m.explorerRect.Contains(x, y) {
		m.state.FocusPanel = FocusExplorer
		m.state.Mode = ModeExplorer
		idx := y - m.explorerRect.Y - 2
		if idx >= 0 && idx < len(m.state.ExplorerItems) {
			m.state.ExplorerSelected = idx
			m.openExplorerSelection()
		}
		return
	}
	if m.editorRect.Contains(x, y) {
		m.state.FocusPanel = FocusEditor
		if m.state.Mode == ModeExplorer {
			m.state.Mode = ModeNormal
		}
		if m.editorInnerRect.Contains(x, y) {
			line := m.state.Editor.ScrollY + (y - m.editorInnerRect.Y - 1)
			if line >= 0 && line < len(m.state.Editor.Lines) {
				if x < m.editorInnerRect.X+9 {
					m.toggleBreakpoint(line + 1)
				} else {
					m.state.Editor.CursorY = line
					m.state.Editor.CursorX = clamp(m.state.Editor.ScrollX+x-m.editorInnerRect.X-9, 0, len([]rune(m.state.Editor.Lines[line])))
				}
			}
		}
		return
	}
	if m.bottomRect.Contains(x, y) {
		if y == m.bottomRect.Y {
			switch {
			case x < 14:
				m.state.ActiveBottomTab = TabOutput
			case x < 28:
				m.state.ActiveBottomTab = TabConsole
			default:
				m.state.ActiveBottomTab = TabTerminal
				m.state.FocusPanel = FocusTerminal
			}
		}
		return
	}
	if m.aiRect.Contains(x, y) {
		m.state.FocusPanel = FocusAI
		m.state.Mode = ModeNormal
		m.state.Log("Focused panel: AI Agent")
	}
}

func (m *Model) appendSettingsField(text string) {
	switch m.state.AISettingsFocus {
	case 0:
		m.state.Settings.SystemPrompt += text
	case 1:
		m.state.Settings.BaseURL += text
	case 2:
		m.state.Settings.APIKey += text
	case 3:
		m.state.Settings.Model += text
	}
}

func (m *Model) popSettingsField() {
	switch m.state.AISettingsFocus {
	case 0:
		m.state.Settings.SystemPrompt = popRune(m.state.Settings.SystemPrompt)
	case 1:
		m.state.Settings.BaseURL = popRune(m.state.Settings.BaseURL)
	case 2:
		m.state.Settings.APIKey = popRune(m.state.Settings.APIKey)
	case 3:
		m.state.Settings.Model = popRune(m.state.Settings.Model)
	}
}

func popRune(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return s
	}
	return string(r[:len(r)-1])
}

func focusName(f FocusPanel) string {
	switch f {
	case FocusEditor:
		return "Editor"
	case FocusExplorer:
		return "Explorer"
	case FocusAI:
		return "AI"
	case FocusTerminal:
		return "Terminal"
	default:
		return "Unknown"
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
