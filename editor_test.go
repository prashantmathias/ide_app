package main

import (
	"path/filepath"
	"testing"
)

func TestEditorBufferEditsAndSaves(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.ts")

	var editor EditorBuffer = NewEditorBuffer()
	editor.Path = path
	editor.InsertText("const x = 1")
	editor.InsertNewline()
	editor.InsertText("console.log(x)")

	if got, want := len(editor.Lines), 2; got != want {
		t.Fatalf("line count = %d, want %d", got, want)
	}
	if !editor.Modified {
		t.Fatal("editor should be marked modified")
	}
	if err := editor.Save(); err != nil {
		t.Fatalf("save failed: %v", err)
	}

	var loaded EditorBuffer = NewEditorBuffer()
	if err := loaded.Load(path); err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if got, want := loaded.Lines[1], "console.log(x)"; got != want {
		t.Fatalf("loaded second line = %q, want %q", got, want)
	}

	loaded.CursorY = 1
	loaded.CursorX = 8
	loaded.Backspace()
	if got, want := loaded.Lines[1], "consolelog(x)"; got != want {
		t.Fatalf("after backspace = %q, want %q", got, want)
	}
}

func TestWorkspaceToolsStayInsideRoot(t *testing.T) {
	root := t.TempDir()
	if _, err := writeFileTool(root, "src/main.ts", "console.log('ok')"); err != nil {
		t.Fatalf("writeFileTool failed: %v", err)
	}
	content, err := readFileTool(root, "src/main.ts")
	if err != nil {
		t.Fatalf("readFileTool failed: %v", err)
	}
	if content != "console.log('ok')" {
		t.Fatalf("content = %q", content)
	}
	if _, err := editFileTool(root, "src/main.ts", "'ok'", "'better'"); err != nil {
		t.Fatalf("editFileTool failed: %v", err)
	}
	if _, err := safeWorkspacePath(root, "../escape.txt"); err == nil {
		t.Fatal("expected escaping path to be rejected")
	}
	if _, err := deleteFileTool(root, "src/main.ts"); err != nil {
		t.Fatalf("deleteFileTool failed: %v", err)
	}
}
