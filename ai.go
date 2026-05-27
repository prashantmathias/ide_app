package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

type openAIMessage map[string]any

type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Role      string     `json:"role"`
			Content   string     `json:"content"`
			ToolCalls []toolCall `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
}

func runAIQuery(root string, history []ChatMessage, settings AISettings, eventCh chan<- tea.Msg) {
	reply, err := callOpenAIAPI(root, history, settings, eventCh)
	eventCh <- aiDoneMsg{Reply: reply, Err: err}
}

func callOpenAIAPI(root string, history []ChatMessage, settings AISettings, eventCh chan<- tea.Msg) (string, error) {
	key := strings.TrimSpace(settings.APIKey)
	if key == "" {
		key = getOpenAIKey(root)
	}
	if key == "" {
		return "", errors.New("OpenAI API key not found. Set OPENAI_API_KEY, .env, or F2 settings")
	}
	if strings.TrimSpace(settings.BaseURL) == "" {
		settings.BaseURL = "https://api.openai.com/v1/chat/completions"
	}
	if strings.TrimSpace(settings.Model) == "" {
		settings.Model = "gpt-4o-mini"
	}

	messages := []openAIMessage{{
		"role":    "system",
		"content": settings.SystemPrompt,
	}}
	start := len(history) - 10
	if start < 0 {
		start = 0
	}
	for _, msg := range history[start:] {
		role := "assistant"
		if msg.Sender == "U" {
			role = "user"
		}
		messages = append(messages, openAIMessage{"role": role, "content": msg.Text})
	}

	client := &http.Client{Timeout: 90 * time.Second}
	for i := 0; i < 5; i++ {
		body := map[string]any{
			"model":    settings.Model,
			"messages": messages,
			"tools":    aiToolSchemas(),
		}
		payload, _ := json.Marshal(body)
		req, err := http.NewRequest(http.MethodPost, settings.BaseURL, bytes.NewReader(payload))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)

		resp, err := client.Do(req)
		if err != nil {
			return "", fmt.Errorf("request failed: %w", err)
		}
		respBody, readErr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if readErr != nil {
			return "", readErr
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", fmt.Errorf("API error %s: %s", resp.Status, string(respBody))
		}

		var parsed chatResponse
		if err := json.Unmarshal(respBody, &parsed); err != nil {
			return "", fmt.Errorf("failed to parse API response: %w", err)
		}
		if len(parsed.Choices) == 0 {
			return "", errors.New("API returned no choices")
		}
		msg := parsed.Choices[0].Message
		if len(msg.ToolCalls) == 0 {
			return msg.Content, nil
		}

		assistantMsg := openAIMessage{
			"role":       "assistant",
			"content":    msg.Content,
			"tool_calls": msg.ToolCalls,
		}
		messages = append(messages, assistantMsg)

		for _, tc := range msg.ToolCalls {
			eventCh <- aiLogMsg{Text: fmt.Sprintf("[AI Tool] %s %s", tc.Function.Name, tc.Function.Arguments)}
			result := executeAITool(root, tc.Function.Name, tc.Function.Arguments)
			eventCh <- aiLogMsg{Text: fmt.Sprintf("[AI Tool Result] %s returned %d chars", tc.Function.Name, len(result))}
			messages = append(messages, openAIMessage{
				"role":         "tool",
				"tool_call_id": tc.ID,
				"name":         tc.Function.Name,
				"content":      result,
			})
		}
	}
	return "", errors.New("agent loop limit reached after 5 tool rounds")
}

func executeAITool(root, name, rawArgs string) string {
	var args map[string]string
	_ = json.Unmarshal([]byte(rawArgs), &args)
	var (
		result string
		err    error
	)
	switch name {
	case "list_directory":
		result, err = listDirectoryTool(root)
	case "read_file":
		result, err = readFileTool(root, args["path"])
	case "write_file":
		result, err = writeFileTool(root, args["path"], args["content"])
	case "edit_file":
		result, err = editFileTool(root, args["path"], args["search"], args["replace"])
	case "delete_file":
		result, err = deleteFileTool(root, args["path"])
	case "install_package":
		result, err = installPackageTool(root, args["package"])
	default:
		err = fmt.Errorf("unknown tool %q", name)
	}
	if err != nil {
		return "Error: " + err.Error()
	}
	return result
}

func getOpenAIKey(root string) string {
	if key := strings.TrimSpace(os.Getenv("OPENAI_API_KEY")); key != "" {
		return key
	}
	content, err := os.ReadFile(root + string(os.PathSeparator) + ".env")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "OPENAI_API_KEY=") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				return strings.Trim(strings.TrimSpace(parts[1]), `"'`)
			}
		}
	}
	return ""
}

func aiToolSchemas() []map[string]any {
	return []map[string]any{
		toolSchema("list_directory", "List all files and directories in the current workspace", map[string]any{}),
		toolSchema("read_file", "Read the contents of a file in the workspace", map[string]any{
			"path": map[string]any{"type": "string", "description": "Path relative to workspace root"},
		}, "path"),
		toolSchema("write_file", "Create a new file or completely overwrite an existing file", map[string]any{
			"path":    map[string]any{"type": "string"},
			"content": map[string]any{"type": "string"},
		}, "path", "content"),
		toolSchema("edit_file", "Search and replace a specific block of text inside an existing file", map[string]any{
			"path":    map[string]any{"type": "string"},
			"search":  map[string]any{"type": "string"},
			"replace": map[string]any{"type": "string"},
		}, "path", "search", "replace"),
		toolSchema("delete_file", "Delete a file from the workspace", map[string]any{
			"path": map[string]any{"type": "string"},
		}, "path"),
		toolSchema("install_package", "Install an NPM package in the workspace", map[string]any{
			"package": map[string]any{"type": "string"},
		}, "package"),
	}
}

func toolSchema(name, description string, properties map[string]any, required ...string) map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        name,
			"description": description,
			"parameters": map[string]any{
				"type":       "object",
				"properties": properties,
				"required":   required,
			},
		},
	}
}
