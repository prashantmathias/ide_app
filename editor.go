package main

import (
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type EditorBuffer struct {
	Path     string
	Lines    []string
	CursorX  int
	CursorY  int
	ScrollX  int
	ScrollY  int
	Modified bool
}

func NewEditorBuffer() EditorBuffer {
	return EditorBuffer{Lines: []string{""}}
}

func (e *EditorBuffer) Load(path string) error {
	content, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		content = nil
	}

	text := strings.ReplaceAll(string(content), "\r\n", "\n")
	text = strings.TrimSuffix(text, "\n")
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || (len(lines) == 1 && lines[0] == "") {
		lines = []string{""}
	}

	e.Path = path
	e.Lines = lines
	e.CursorX = 0
	e.CursorY = 0
	e.ScrollX = 0
	e.ScrollY = 0
	e.Modified = false
	return nil
}

func (e *EditorBuffer) Save() error {
	if e.Path == "" {
		return errNoFile
	}
	if err := os.MkdirAll(filepath.Dir(e.Path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(e.Path, []byte(strings.Join(e.Lines, "\n")), 0o644); err != nil {
		return err
	}
	e.Modified = false
	return nil
}

func (e *EditorBuffer) InsertRune(r rune) {
	e.ensureLine()
	line := []rune(e.Lines[e.CursorY])
	e.CursorX = clamp(e.CursorX, 0, len(line))
	line = append(line[:e.CursorX], append([]rune{r}, line[e.CursorX:]...)...)
	e.Lines[e.CursorY] = string(line)
	e.CursorX++
	e.Modified = true
}

func (e *EditorBuffer) InsertText(s string) {
	for _, r := range s {
		if r == '\n' {
			e.InsertNewline()
			continue
		}
		if r != '\r' {
			e.InsertRune(r)
		}
	}
}

func (e *EditorBuffer) InsertTab() {
	e.InsertText("    ")
}

func (e *EditorBuffer) InsertNewline() {
	e.ensureLine()
	line := []rune(e.Lines[e.CursorY])
	e.CursorX = clamp(e.CursorX, 0, len(line))
	left := string(line[:e.CursorX])
	right := string(line[e.CursorX:])
	e.Lines[e.CursorY] = left
	e.Lines = append(e.Lines[:e.CursorY+1], append([]string{right}, e.Lines[e.CursorY+1:]...)...)
	e.CursorY++
	e.CursorX = 0
	e.Modified = true
}

func (e *EditorBuffer) Backspace() {
	e.ensureLine()
	if e.CursorX > 0 {
		line := []rune(e.Lines[e.CursorY])
		e.CursorX = clamp(e.CursorX, 0, len(line))
		line = append(line[:e.CursorX-1], line[e.CursorX:]...)
		e.Lines[e.CursorY] = string(line)
		e.CursorX--
		e.Modified = true
		return
	}
	if e.CursorY > 0 {
		current := e.Lines[e.CursorY]
		e.Lines = append(e.Lines[:e.CursorY], e.Lines[e.CursorY+1:]...)
		e.CursorY--
		prevLen := utf8.RuneCountInString(e.Lines[e.CursorY])
		e.Lines[e.CursorY] += current
		e.CursorX = prevLen
		e.Modified = true
	}
}

func (e *EditorBuffer) Delete() {
	e.ensureLine()
	line := []rune(e.Lines[e.CursorY])
	if e.CursorX < len(line) {
		line = append(line[:e.CursorX], line[e.CursorX+1:]...)
		e.Lines[e.CursorY] = string(line)
		e.Modified = true
		return
	}
	if e.CursorY < len(e.Lines)-1 {
		e.Lines[e.CursorY] += e.Lines[e.CursorY+1]
		e.Lines = append(e.Lines[:e.CursorY+1], e.Lines[e.CursorY+2:]...)
		e.Modified = true
	}
}

func (e *EditorBuffer) MoveUp() {
	if e.CursorY > 0 {
		e.CursorY--
		e.clampCursorX()
	}
}

func (e *EditorBuffer) MoveDown() {
	if e.CursorY < len(e.Lines)-1 {
		e.CursorY++
		e.clampCursorX()
	}
}

func (e *EditorBuffer) MoveLeft() {
	if e.CursorX > 0 {
		e.CursorX--
		return
	}
	if e.CursorY > 0 {
		e.CursorY--
		e.CursorX = utf8.RuneCountInString(e.Lines[e.CursorY])
	}
}

func (e *EditorBuffer) MoveRight() {
	e.ensureLine()
	if e.CursorX < utf8.RuneCountInString(e.Lines[e.CursorY]) {
		e.CursorX++
		return
	}
	if e.CursorY < len(e.Lines)-1 {
		e.CursorY++
		e.CursorX = 0
	}
}

func (e *EditorBuffer) AdjustScroll(height, width int) {
	if height < 1 {
		height = 1
	}
	if width < 1 {
		width = 1
	}
	if e.CursorY < e.ScrollY {
		e.ScrollY = e.CursorY
	}
	if e.CursorY >= e.ScrollY+height {
		e.ScrollY = e.CursorY - height + 1
	}
	if e.CursorX < e.ScrollX {
		e.ScrollX = e.CursorX
	}
	if e.CursorX >= e.ScrollX+width {
		e.ScrollX = e.CursorX - width + 1
	}
	if e.ScrollY < 0 {
		e.ScrollY = 0
	}
	if e.ScrollX < 0 {
		e.ScrollX = 0
	}
}

func (e *EditorBuffer) clampCursorX() {
	e.ensureLine()
	e.CursorX = min(e.CursorX, utf8.RuneCountInString(e.Lines[e.CursorY]))
}

func (e *EditorBuffer) ensureLine() {
	if len(e.Lines) == 0 {
		e.Lines = []string{""}
	}
	if e.CursorY < 0 {
		e.CursorY = 0
	}
	for e.CursorY >= len(e.Lines) {
		e.Lines = append(e.Lines, "")
	}
}
