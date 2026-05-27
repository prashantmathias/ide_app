package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

func safeWorkspacePath(root, rel string) (string, error) {
	if strings.TrimSpace(rel) == "" {
		return "", errors.New("empty path")
	}
	if filepath.IsAbs(rel) {
		return "", errors.New("absolute paths are not allowed")
	}
	clean := filepath.Clean(rel)
	if clean == "." || strings.HasPrefix(clean, "..") {
		return "", errors.New("path escapes workspace")
	}
	path := filepath.Join(root, clean)
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	relToRoot, err := filepath.Rel(absRoot, absPath)
	if err != nil {
		return "", err
	}
	if relToRoot == ".." || strings.HasPrefix(relToRoot, ".."+string(os.PathSeparator)) {
		return "", errors.New("path escapes workspace")
	}
	return absPath, nil
}

func listDirectoryTool(root string) (string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	rows := make([]string, 0, len(entries))
	for _, entry := range entries {
		if shouldHideWorkspaceItem(entry.Name()) {
			continue
		}
		kind := "File"
		if entry.IsDir() {
			kind = "Directory"
		}
		rows = append(rows, fmt.Sprintf("- %s (%s)", entry.Name(), kind))
	}
	sort.Strings(rows)
	if len(rows) == 0 {
		return "Workspace is empty.", nil
	}
	return strings.Join(rows, "\n"), nil
}

func readFileTool(root, rel string) (string, error) {
	path, err := safeWorkspacePath(root, rel)
	if err != nil {
		return "", err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

func writeFileTool(root, rel, content string) (string, error) {
	path, err := safeWorkspacePath(root, rel)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("Successfully wrote file %q.", rel), nil
}

func editFileTool(root, rel, search, replace string) (string, error) {
	path, err := safeWorkspacePath(root, rel)
	if err != nil {
		return "", err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	text := string(content)
	if !strings.Contains(text, search) {
		return "", fmt.Errorf("search block not found in %q", rel)
	}
	next := strings.ReplaceAll(text, search, replace)
	if err := os.WriteFile(path, []byte(next), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("Successfully edited file %q.", rel), nil
}

func deleteFileTool(root, rel string) (string, error) {
	path, err := safeWorkspacePath(root, rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", errors.New("delete_file only deletes files")
	}
	if err := os.Remove(path); err != nil {
		return "", err
	}
	return fmt.Sprintf("Successfully deleted file %q.", rel), nil
}

func installPackageTool(root, pkg string) (string, error) {
	if strings.TrimSpace(pkg) == "" {
		return "", errors.New("empty package")
	}
	cmd := exec.Command("npm", "install", pkg)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("npm install failed: %w\n%s", err, string(out))
	}
	return fmt.Sprintf("Successfully installed package %q.\n%s", pkg, string(out)), nil
}

func shellCommand(root, command string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		cmd := exec.Command("powershell", "-NoLogo", "-NoProfile", "-Command", command)
		cmd.Dir = root
		return cmd
	}
	cmd := exec.Command("sh", "-c", command)
	cmd.Dir = root
	return cmd
}
