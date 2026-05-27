package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/gorilla/websocket"
)

func startDeno(root, path string, inspect bool, breakpoints []int, eventCh chan<- tea.Msg) chan debuggerCommandMsg {
	cmdCh := make(chan debuggerCommandMsg, 32)
	go runDeno(root, path, inspect, breakpoints, cmdCh, eventCh)
	return cmdCh
}

func runDeno(root, path string, inspect bool, breakpoints []int, cmdCh <-chan debuggerCommandMsg, eventCh chan<- tea.Msg) {
	args := []string{"run", "-A"}
	if inspect {
		args = append(args, "--inspect-brk")
	}
	args = append(args, path)
	cmd := exec.Command("deno", args...)
	cmd.Dir = root

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		eventCh <- denoMsg{Kind: "error", Err: err.Error()}
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		eventCh <- denoMsg{Kind: "error", Err: err.Error()}
		return
	}
	if err := cmd.Start(); err != nil {
		eventCh <- denoMsg{Kind: "error", Err: "failed to spawn Deno: " + err.Error()}
		return
	}

	go scanLines(stdout, func(line string) {
		eventCh <- denoMsg{Kind: "stdout", Line: line}
	})

	wsURLCh := make(chan string, 1)
	go scanLines(stderr, func(line string) {
		if strings.Contains(line, "Debugger listening on ws://") {
			if wsURL := extractWebSocketURL(line); wsURL != "" {
				select {
				case wsURLCh <- wsURL:
				default:
				}
				eventCh <- denoMsg{Kind: "debugger_listening", URL: wsURL}
				return
			}
		}
		eventCh <- denoMsg{Kind: "stderr", Line: line}
	})

	if inspect {
		go attachDenoDebugger(path, breakpoints, wsURLCh, cmdCh, eventCh)
	}

	err = cmd.Wait()
	code := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			eventCh <- denoMsg{Kind: "error", Err: err.Error()}
			code = -1
		}
	}
	eventCh <- denoMsg{Kind: "finished", Code: code}
}

func scanLines(pipe io.Reader, each func(string)) {
	scanner := bufio.NewScanner(pipe)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		each(scanner.Text())
	}
}

func extractWebSocketURL(line string) string {
	idx := strings.Index(line, "ws://")
	if idx < 0 {
		return ""
	}
	fields := strings.Fields(line[idx:])
	if len(fields) == 0 {
		return ""
	}
	raw := strings.TrimRight(fields[0], ".")
	if _, err := url.Parse(raw); err != nil {
		return ""
	}
	return raw
}

func attachDenoDebugger(path string, breakpoints []int, wsURLCh <-chan string, cmdCh <-chan debuggerCommandMsg, eventCh chan<- tea.Msg) {
	wsURL := <-wsURLCh
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		eventCh <- denoMsg{Kind: "error", Err: "WebSocket connection failed: " + err.Error()}
		return
	}
	defer conn.Close()
	eventCh <- denoMsg{Kind: "debugger_connected"}

	var id atomic.Uint64
	var writeMu sync.Mutex
	pending := sync.Map{}
	remoteBreakpoints := sync.Map{}

	send := func(method string, params map[string]any) uint64 {
		msgID := id.Add(1)
		payload := map[string]any{"id": msgID, "method": method}
		if params != nil {
			payload["params"] = params
		}
		writeMu.Lock()
		_ = conn.WriteJSON(payload)
		writeMu.Unlock()
		return msgID
	}
	request := func(method string, params map[string]any) <-chan map[string]any {
		msgID := id.Add(1)
		ch := make(chan map[string]any, 1)
		pending.Store(msgID, ch)
		payload := map[string]any{"id": msgID, "method": method}
		if params != nil {
			payload["params"] = params
		}
		writeMu.Lock()
		_ = conn.WriteJSON(payload)
		writeMu.Unlock()
		return ch
	}

	send("Runtime.enable", nil)
	send("Debugger.enable", nil)
	for _, line := range breakpoints {
		ch := request("Debugger.setBreakpointByUrl", map[string]any{
			"lineNumber": line - 1,
			"urlRegex":   ".*" + strings.ReplaceAll(path, "\\", "/"),
		})
		go rememberBreakpoint(line, ch, &remoteBreakpoints)
	}
	send("Runtime.runIfWaitingForDebugger", nil)

	go func() {
		for c := range cmdCh {
			switch c.Command {
			case DebugStepOver:
				send("Debugger.stepOver", nil)
			case DebugStepInto:
				send("Debugger.stepInto", nil)
			case DebugResume:
				send("Debugger.resume", nil)
			case DebugSetBreakpoint:
				filename := c.Filename
				if filename == "" {
					filename = path
				}
				ch := request("Debugger.setBreakpointByUrl", map[string]any{
					"lineNumber": c.Line - 1,
					"urlRegex":   ".*" + strings.ReplaceAll(filename, "\\", "/"),
				})
				go rememberBreakpoint(c.Line, ch, &remoteBreakpoints)
			case DebugRemoveBreakpoint:
				if idValue, ok := remoteBreakpoints.Load(c.Line); ok {
					send("Debugger.removeBreakpoint", map[string]any{"breakpointId": idValue})
					remoteBreakpoints.Delete(c.Line)
				}
			}
		}
	}()

	for {
		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		if rawID, ok := msg["id"].(float64); ok {
			if chValue, exists := pending.LoadAndDelete(uint64(rawID)); exists {
				chValue.(chan map[string]any) <- msg
			}
		}
		method, _ := msg["method"].(string)
		switch method {
		case "Debugger.paused":
			params, _ := msg["params"].(map[string]any)
			rawFrames, _ := params["callFrames"].([]any)
			frames := parseCallFrames(rawFrames)
			go func() {
				vars := fetchTopFrameVariables(rawFrames, request)
				eventCh <- denoMsg{Kind: "paused", Frames: frames, Variables: vars}
			}()
		case "Debugger.resumed":
			eventCh <- denoMsg{Kind: "resumed"}
		}
	}
}

func rememberBreakpoint(line int, ch <-chan map[string]any, breakpoints *sync.Map) {
	resp := <-ch
	result, _ := resp["result"].(map[string]any)
	if bpID, _ := result["breakpointId"].(string); bpID != "" {
		breakpoints.Store(line, bpID)
	}
}

func parseCallFrames(raw []any) []DebugCallFrame {
	frames := make([]DebugCallFrame, 0, len(raw))
	for _, item := range raw {
		frame, ok := item.(map[string]any)
		if !ok {
			continue
		}
		location, _ := frame["location"].(map[string]any)
		line := int(number(location["lineNumber"])) + 1
		col := int(number(location["columnNumber"]))
		fn, _ := frame["functionName"].(string)
		if fn == "" {
			fn = "(anonymous)"
		}
		scriptURL, _ := frame["url"].(string)
		frames = append(frames, DebugCallFrame{
			FunctionName: fn,
			LineNumber:   line,
			ColumnNumber: col,
			ScriptURL:    scriptURL,
		})
	}
	return frames
}

func fetchTopFrameVariables(rawFrames []any, request func(string, map[string]any) <-chan map[string]any) []DebugVariable {
	if len(rawFrames) == 0 {
		return nil
	}
	frame, _ := rawFrames[0].(map[string]any)
	rawScopes, _ := frame["scopeChain"].([]any)
	var vars []DebugVariable
	for _, rawScope := range rawScopes {
		scope, _ := rawScope.(map[string]any)
		scopeType, _ := scope["type"].(string)
		if scopeType != "local" && scopeType != "closure" {
			continue
		}
		obj, _ := scope["object"].(map[string]any)
		objID, _ := obj["objectId"].(string)
		if objID == "" {
			continue
		}
		resp := <-request("Runtime.getProperties", map[string]any{
			"objectId":        objID,
			"ownProperties":   false,
			"generatePreview": true,
		})
		result, _ := resp["result"].(map[string]any)
		props, _ := result["result"].([]any)
		for _, rawProp := range props {
			prop, _ := rawProp.(map[string]any)
			name, _ := prop["name"].(string)
			if name == "" || name == "__proto__" {
				continue
			}
			rawVal, _ := prop["value"].(map[string]any)
			valType, _ := rawVal["type"].(string)
			vars = append(vars, DebugVariable{
				Name:    name,
				ValType: valType,
				Value:   formatDebugValue(rawVal),
			})
		}
	}
	return vars
}

func formatDebugValue(v map[string]any) string {
	typ, _ := v["type"].(string)
	switch typ {
	case "string":
		return fmt.Sprintf("%q", v["value"])
	case "number", "boolean":
		return fmt.Sprintf("%v", v["value"])
	case "undefined":
		return "undefined"
	case "object":
		if subtype, _ := v["subtype"].(string); subtype == "null" {
			return "null"
		}
		if desc, _ := v["description"].(string); desc != "" {
			return desc
		}
		return "Object"
	case "function":
		if desc, _ := v["description"].(string); desc != "" {
			return "f " + strings.Split(desc, "(")[0]
		}
		return "f()"
	default:
		if raw, err := json.Marshal(v["value"]); err == nil && string(raw) != "null" {
			return string(raw)
		}
	}
	return ""
}

func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	default:
		return 0
	}
}
