package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var errNoFile = errors.New("no file path set")

type AppMode int

const (
	ModeNormal AppMode = iota
	ModeInsert
	ModeCommand
	ModeExplorer
)

type FocusPanel int

const (
	FocusEditor FocusPanel = iota
	FocusExplorer
	FocusAI
	FocusTerminal
)

type BottomTab int

const (
	TabOutput BottomTab = iota
	TabConsole
	TabTerminal
)

type Rect struct {
	X int
	Y int
	W int
	H int
}

func (r Rect) Contains(x, y int) bool {
	return x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H
}

type ExplorerItem struct {
	Name  string
	Path  string
	IsDir bool
}

type ChatMessage struct {
	Sender string `json:"sender"`
	Text   string `json:"text"`
}

type DebugCallFrame struct {
	FunctionName string `json:"function_name"`
	LineNumber   int    `json:"line_number"`
	ColumnNumber int    `json:"column_number"`
	ScriptURL    string `json:"script_url"`
}

type DebugVariable struct {
	Name    string `json:"name"`
	ValType string `json:"val_type"`
	Value   string `json:"value"`
}

type AISettings struct {
	SystemPrompt string `json:"system_prompt"`
	BaseURL      string `json:"base_url"`
	APIKey       string `json:"api_key"`
	Model        string `json:"model"`
}

type AppState struct {
	Root              string
	Mode              AppMode
	Editor            EditorBuffer
	ExplorerItems     []ExplorerItem
	ExplorerSelected  int
	ExplorerInputMode string
	ExplorerInput     string
	CommandText       string
	ConsoleOutput     []string
	SystemLogs        []string
	IsDebugging       bool
	IsPaused          bool
	PausedLine        int
	CallFrames        []DebugCallFrame
	DebugVariables    []DebugVariable
	Breakpoints       map[int]bool
	ActiveBottomTab   BottomTab
	ShowSidebar       bool
	FocusPanel        FocusPanel
	TimeString        string
	ShowAIPanel       bool
	AIStatus          string
	AIInput           string
	AIChatHistory     []ChatMessage
	AIChatScroll      int
	ShowHelp          bool
	Settings          AISettings
	ShowAISettings    bool
	AISettingsFocus   int
	TerminalOutput    []string
	TerminalInput     string
	TerminalScroll    int
	LastError         string
}

func NewAppState(root string) *AppState {
	st := &AppState{
		Root:            root,
		Mode:            ModeNormal,
		Editor:          NewEditorBuffer(),
		ConsoleOutput:   []string{"$ CodeCraft Go IDE initialized."},
		SystemLogs:      []string{"[System] App started"},
		Breakpoints:     map[int]bool{},
		ActiveBottomTab: TabOutput,
		ShowSidebar:     true,
		FocusPanel:      FocusEditor,
		TimeString:      time.Now().Format("15:04:05"),
		ShowAIPanel:     true,
		AIStatus:        "LISTENING",
		AIChatHistory:   []ChatMessage{{Sender: "A", Text: "Hello! I am your CodeCraft assistant. Ask me about this workspace or let me modify files for you."}},
		Settings: AISettings{
			SystemPrompt: "You are a helpful AI assistant in the CodeCraft TUI IDE. Answer developer queries concisely. You can list, read, write, edit, and delete files in the workspace and install NPM packages when requested.",
			BaseURL:      "https://api.openai.com/v1/chat/completions",
			Model:        "gpt-4o-mini",
		},
		TerminalOutput: []string{"CodeCraft Terminal (one-shot shell command runner)"},
	}
	st.LoadAISettings()
	st.ReadWorkspaceDir()
	return st
}

func (s *AppState) LoadAISettings() {
	content, err := os.ReadFile(filepath.Join(s.Root, "ai_settings.json"))
	if err != nil {
		return
	}
	_ = json.Unmarshal(content, &s.Settings)
	if s.Settings.SystemPrompt == "" {
		s.Settings.SystemPrompt = "You are a helpful AI assistant in the CodeCraft TUI IDE."
	}
	if s.Settings.BaseURL == "" {
		s.Settings.BaseURL = "https://api.openai.com/v1/chat/completions"
	}
	if s.Settings.Model == "" {
		s.Settings.Model = "gpt-4o-mini"
	}
}

func (s *AppState) SaveAISettings() {
	content, err := json.MarshalIndent(s.Settings, "", "  ")
	if err == nil {
		_ = os.WriteFile(filepath.Join(s.Root, "ai_settings.json"), content, 0o600)
	}
}

func (s *AppState) Log(msg string) {
	s.SystemLogs = append(s.SystemLogs, msg)
	if len(s.SystemLogs) > 1000 {
		s.SystemLogs = s.SystemLogs[len(s.SystemLogs)-1000:]
	}
}

func (s *AppState) Output(msg string) {
	s.ConsoleOutput = append(s.ConsoleOutput, msg)
	if len(s.ConsoleOutput) > 1000 {
		s.ConsoleOutput = s.ConsoleOutput[len(s.ConsoleOutput)-1000:]
	}
}

func (s *AppState) ReadWorkspaceDir() {
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		s.Log("Failed to read workspace: " + err.Error())
		return
	}
	items := make([]ExplorerItem, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if shouldHideWorkspaceItem(name) {
			continue
		}
		items = append(items, ExplorerItem{
			Name:  name,
			Path:  filepath.Join(s.Root, name),
			IsDir: entry.IsDir(),
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].IsDir != items[j].IsDir {
			return items[i].IsDir
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	s.ExplorerItems = items
	if len(items) == 0 {
		s.ExplorerSelected = 0
		return
	}
	s.ExplorerSelected = clamp(s.ExplorerSelected, 0, len(items)-1)
}

func (s *AppState) ActiveFileName() string {
	if s.Editor.Path == "" {
		return "Untitled"
	}
	return filepath.Base(s.Editor.Path)
}

func (s *AppState) BreakpointLines() []int {
	lines := make([]int, 0, len(s.Breakpoints))
	for line := range s.Breakpoints {
		lines = append(lines, line)
	}
	sort.Ints(lines)
	return lines
}

func (s *AppState) ToggleBreakpoint(line int) {
	if line < 1 {
		return
	}
	if s.Breakpoints[line] {
		delete(s.Breakpoints, line)
		s.Log("Breakpoint removed at line " + itoa(line))
		return
	}
	s.Breakpoints[line] = true
	s.Log("Breakpoint set at line " + itoa(line))
}

func shouldHideWorkspaceItem(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	switch name {
	case "target", "node_modules", "go.sum":
		return true
	default:
		return false
	}
}
