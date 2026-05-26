import { useState, useEffect, useRef, useCallback } from "react";
import { Box, Flex, Text, ScrollArea } from "@radix-ui/themes";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Editor, { EditorMethods } from "./Editor";
import DebugPanel, { DebugCallFrame, DebugVariable } from "./DebugPanel";
import DenoTerminal from "./DenoTerminal";
import ResizeHandle from "./ResizeHandle";
import { debuggerInstance } from "./debugger";
import AIPanel from "./AIPanel";
import "./App.css";

function App() {
  const [activeFile] = useState("main.ts");
  const [consoleOutput, setConsoleOutput] = useState<string[]>(["$ Deno IDE initialized."]);
  const [isDebugging, setIsDebugging] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [breakpoints, setBreakpoints] = useState<number[]>([]);
  const [activeBreakpointIds, setActiveBreakpointIds] = useState<Record<number, string>>({});
  const [pausedLine, setPausedLine] = useState<number | null>(null);
  const [callFrames, setCallFrames] = useState<DebugCallFrame[]>([]);
  const [debugVariables, setDebugVariables] = useState<DebugVariable[]>([]);
  const [activeBottomTab, setActiveBottomTab] = useState<"terminal" | "output">("terminal");
  const [activeActivityTab, setActiveActivityTab] = useState<"explorer" | "search" | "git" | "extensions" | "settings" | null>("explorer");
  
  const breakpointsRef = useRef<number[]>([]);

  // Resizable panel sizes
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(180);
  const [debugPanelWidth, setDebugPanelWidth] = useState(280);
  const [aiPanelWidth, setAiPanelWidth] = useState(350);
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(false);
  const [editorMethods, setEditorMethods] = useState<EditorMethods | null>(null);

  // TUI UI States
  const [timeString, setTimeString] = useState("");
  const [commandText, setCommandText] = useState("");
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const commandInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setTimeString(now.toTimeString().split(" ")[0]);
    };
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === ":" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        commandInputRef.current?.focus();
        setCommandText(":");
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
      }
      if (e.key === "Escape") {
        setShowCommandPalette(false);
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (commandText === ":p" || commandText === ":palette") {
      setShowCommandPalette(true);
    } else if (commandText === ":w" || commandText === ":write") {
      setConsoleOutput(prev => [...prev, "$ File saved successfully via Vim command :w"]);
    } else if (commandText === ":r" || commandText === ":run") {
      handleRun();
    } else if (commandText === ":q" || commandText === ":quit") {
      setConsoleOutput(prev => [...prev, "$ Vim command :q received. Closing IDE app is disabled in prototype."]);
    } else if (commandText.startsWith(":help")) {
      setConsoleOutput(prev => [...prev, "$ Commands: :w (save), :r (run), :p (command palette)"]);
    } else {
      setConsoleOutput(prev => [...prev, `$ Command "${commandText}" not recognized. Try :help`]);
    }
    setCommandText("");
    commandInputRef.current?.blur();
  };

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => Math.max(120, Math.min(500, w + delta)));
  }, []);

  const handleBottomResize = useCallback((delta: number) => {
    setBottomPanelHeight((h) => Math.max(80, Math.min(500, h - delta)));
  }, []);

  const handleDebugPanelResize = useCallback((delta: number) => {
    setDebugPanelWidth((w) => Math.max(180, Math.min(500, w - delta)));
  }, []);

  const handleAIPanelResize = useCallback((delta: number) => {
    setAiPanelWidth((w) => Math.max(250, Math.min(600, w - delta)));
  }, []);
  
  useEffect(() => {
    breakpointsRef.current = breakpoints;
  }, [breakpoints]);

  useEffect(() => {
    const unlisten1 = listen<string>("deno-output", (event) => {
      setConsoleOutput((prev) => [...prev, event.payload]);
    });

    const unlisten2 = listen<string>("debugger-ws-url", async (event) => {
      setConsoleOutput((prev) => [...prev, `$ Attaching debugger to ${event.payload}`]);
      setIsDebugging(true);
      await debuggerInstance.connect(event.payload);
      
      // Send all existing breakpoints to the debugger
      const newIds: Record<number, string> = {};
      for (const line of breakpointsRef.current) {
        try {
          const bpId = await debuggerInstance.setBreakpoint(activeFile, line);
          newIds[line] = bpId;
        } catch (e) {
          console.error(`Failed to set breakpoint on line ${line}:`, e);
        }
      }
      setActiveBreakpointIds(newIds);
      
      setConsoleOutput((prev) => [...prev, `$ Debugger attached! Paused at start.`]);
    });

    debuggerInstance.onPaused = async (frames: any[]) => {
      setIsPaused(true);
      // CDP lineNumber is 0-indexed, Monaco is 1-indexed
      const topFrame = frames[0];
      const line = topFrame ? topFrame.location.lineNumber + 1 : null;
      setPausedLine(line);

      // Build call stack info
      const stack: DebugCallFrame[] = frames.map((f: any) => ({
        functionName: f.functionName,
        lineNumber: f.location.lineNumber + 1,
        columnNumber: f.location.columnNumber,
        scriptUrl: f.url || "",
      }));
      setCallFrames(stack);

      // Fetch local variables from the top frame's scopes
      if (topFrame?.scopeChain) {
        const vars: DebugVariable[] = [];
        for (const scope of topFrame.scopeChain) {
          if (scope.type === "local" || scope.type === "closure") {
            try {
              const props = await debuggerInstance.getScopeProperties(scope.object.objectId);
              for (const prop of props) {
                if (prop.name === "__proto__") continue;
                const val = prop.value;
                vars.push({
                  name: prop.name,
                  value: val ? formatValue(val) : "undefined",
                  type: val?.type ?? "unknown",
                });
              }
            } catch (e) {
              console.error("Failed to get scope properties:", e);
            }
          }
        }
        setDebugVariables(vars);
      }

      setConsoleOutput((prev) => [...prev, `$ Debugger paused at line ${line}.`]);
    };

    debuggerInstance.onResumed = () => {
      setIsPaused(false);
      setPausedLine(null);
      setConsoleOutput((prev) => [...prev, `$ Resumed.`]);
    };

    debuggerInstance.onDisconnected = () => {
      setIsDebugging(false);
      setIsPaused(false);
      setPausedLine(null);
      setCallFrames([]);
      setDebugVariables([]);
      setActiveBreakpointIds({});
      setConsoleOutput((prev) => [...prev, `$ Debugger disconnected.`]);
    };

    return () => {
      unlisten1.then(f => f());
      unlisten2.then(f => f());
    };
  }, []);

  const handleRun = async () => {
    setConsoleOutput(["$ Running main.ts..."]);
    setActiveBottomTab("output");
    setIsDebugging(false);
    debuggerInstance.disconnect();
    setActiveBreakpointIds({});
    try {
      await invoke("run_deno", { path: activeFile, inspect: false });
    } catch (e) {
      setConsoleOutput((prev) => [...prev, `Failed to run: ${e}`]);
    }
  };

  const handleDebug = async () => {
    setConsoleOutput(["$ Debugging main.ts..."]);
    setActiveBottomTab("output");
    try {
      await invoke("run_deno", { path: activeFile, inspect: true });
    } catch (e) {
      setConsoleOutput((prev) => [...prev, `Failed to run: ${e}`]);
    }
  };

  const handleResume = () => debuggerInstance.resume();
  const handleStepOver = () => debuggerInstance.stepOver();

  const handleToggleBreakpoint = async (line: number) => {
    if (breakpoints.includes(line)) {
      setBreakpoints((prev) => prev.filter((l) => l !== line));
      if (isDebugging) {
        const bpId = activeBreakpointIds[line];
        if (bpId) {
          try {
            await debuggerInstance.removeBreakpoint(bpId);
            setActiveBreakpointIds((prev) => {
              const copy = { ...prev };
              delete copy[line];
              return copy;
            });
          } catch (e) {
            console.error(`Failed to remove breakpoint:`, e);
          }
        }
      }
    } else {
      setBreakpoints((prev) => [...prev, line]);
      if (isDebugging) {
        try {
          const bpId = await debuggerInstance.setBreakpoint(activeFile, line);
          setActiveBreakpointIds((prev) => ({
            ...prev,
            [line]: bpId,
          }));
        } catch (e) {
          console.error(`Failed to set breakpoint:`, e);
        }
      }
    }
  };

  return (
    <Flex className="app-container" direction="column" style={{ height: "100vh" }}>
      {/* Top Bar (TUI Header Style) */}
      <Flex className="tui-header" align="center" px="2" style={{ height: "32px", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
        {/* Left Side: Brand and Menus */}
        <Flex align="center" gap="4">
          <Text weight="bold" className="brand-text" style={{ color: "var(--primary)" }}>┌─ Deno-TUI ─┐</Text>
          <Flex gap="2">
            <button className="tui-nav-btn active">&lt; FILE &gt;</button>
            <button className="tui-nav-btn" onClick={() => setShowCommandPalette(true)}>&lt; EDIT &gt;</button>
            <button className="tui-nav-btn" onClick={() => setActiveActivityTab(activeActivityTab ? null : "explorer")}>&lt; VIEW &gt;</button>
            <button className="tui-nav-btn" onClick={() => setIsAIPanelOpen(!isAIPanelOpen)}>&lt; HELP &gt;</button>
          </Flex>
        </Flex>

        {/* Center: status/hint line */}
        <div style={{ flex: 1, textAlign: "center", opacity: 0.5, fontSize: "11px" }}>
          ───────────  ( Alt+X: Menu | Ctrl+P: Command )  ───────────
        </div>

        {/* Right Side: Debug/Run Actions & Time */}
        <Flex gap="2" align="center">
          {isDebugging && isPaused && (
            <>
              <button className="tui-nav-btn" style={{ color: "var(--secondary)", cursor: "pointer" }} onClick={handleResume}>
                &lt; RESUME &gt;
              </button>
              <button className="tui-nav-btn" style={{ color: "var(--primary)", cursor: "pointer" }} onClick={handleStepOver}>
                &lt; STEP &gt;
              </button>
            </>
          )}
          <button className="tui-nav-btn" style={{ color: "var(--secondary)", cursor: "pointer" }} onClick={handleRun}>
            [ RUN ]
          </button>
          <button className="tui-nav-btn" style={{ color: "var(--tertiary)", cursor: "pointer" }} onClick={handleDebug}>
            [ DEBUG ]
          </button>
          <button
            className={`tui-nav-btn ${isAIPanelOpen ? "active" : ""}`}
            style={{ color: "var(--primary)", cursor: "pointer" }}
            onClick={() => setIsAIPanelOpen(!isAIPanelOpen)}
          >
            [ AI COPILOT ]
          </button>
          <span style={{ color: "var(--on-surface-variant)", marginLeft: "4px" }}>│</span>
          <span style={{ color: "var(--on-surface-variant)", fontSize: "11px", marginLeft: "4px" }}>
            {timeString}
          </span>
        </Flex>
      </Flex>

      <Flex style={{ flex: 1, overflow: "hidden" }}>
        {/* Activity Bar (ASCII representation) */}
        <div className="activity-bar" style={{ width: "40px", flexShrink: 0 }}>
          <div
            className={`activity-item ${activeActivityTab === "explorer" ? "active" : ""}`}
            onClick={() => setActiveActivityTab(activeActivityTab === "explorer" ? null : "explorer")}
            title="Explorer"
            style={{ fontSize: "13px" }}
          >
            [F]
          </div>
          <div
            className={`activity-item ${activeActivityTab === "search" ? "active" : ""}`}
            onClick={() => setActiveActivityTab(activeActivityTab === "search" ? null : "search")}
            title="Search"
            style={{ fontSize: "13px" }}
          >
            [S]
          </div>
          <div
            className={`activity-item ${activeActivityTab === "git" ? "active" : ""}`}
            onClick={() => setActiveActivityTab(activeActivityTab === "git" ? null : "git")}
            title="Source Control"
            style={{ fontSize: "13px" }}
          >
            [G]
          </div>
          <div
            className={`activity-item ${activeActivityTab === "extensions" ? "active" : ""}`}
            onClick={() => setActiveActivityTab(activeActivityTab === "extensions" ? null : "extensions")}
            title="Extensions"
            style={{ fontSize: "13px" }}
          >
            [E]
          </div>
          
          <div style={{ marginTop: "auto", width: "100%", display: "flex", flexDirection: "column", gap: "16px", alignItems: "center" }}>
            <div
              className={`activity-item ${activeActivityTab === "settings" ? "active" : ""}`}
              onClick={() => setActiveActivityTab(activeActivityTab === "settings" ? null : "settings")}
              title="Settings"
              style={{ fontSize: "13px" }}
            >
              [?]
            </div>
          </div>
        </div>

        {/* Sidebar Panel */}
        {activeActivityTab && (
          <>
            <Box className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth, flexShrink: 0, display: "flex", flexDirection: "column" }}>
              {activeActivityTab === "explorer" && (
                <>
                  <div style={{ backgroundColor: "var(--surface-container)", padding: "4px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--primary)", fontWeight: "bold" }}>
                    <span>[ EXPLORER ]</span>
                    <span style={{ color: "var(--outline-variant)", marginLeft: "auto" }}>═</span>
                  </div>
                  <div style={{ padding: "8px", overflowY: "auto", flex: 1, whiteSpace: "pre", fontSize: "13px", lineHeight: "1.4" }}>
                    <span style={{ color: "var(--on-surface-variant)" }}>v </span><span style={{ fontWeight: "bold" }}>PROJECT: DENO-IDE</span>{"\n"}
                    <span style={{ color: "var(--on-surface-variant)" }}>│</span>{"\n"}
                    <span style={{ color: "var(--on-surface-variant)" }}>├─v </span><span style={{ color: "var(--primary)" }}>[D] src</span>{"\n"}
                    <span style={{ color: "var(--on-surface-variant)" }}>│ │</span>{"\n"}
                    <span style={{ color: "var(--on-surface-variant)" }}>│ └─ </span><span style={{ backgroundColor: "rgba(162, 201, 255, 0.2)", color: "var(--primary)", fontWeight: "bold", padding: "0 4px" }}>[*] main.ts</span>{"\n"}
                    <span style={{ color: "var(--on-surface-variant)" }}>│</span>{"\n"}
                    <span style={{ color: "var(--on-surface-variant)" }}>├─&gt; </span><span style={{ color: "var(--on-surface-variant)" }}>[D] node_modules</span>{"\n"}
                    <span style={{ color: "var(--on-surface-variant)" }}>└─ </span><span style={{ color: "var(--tertiary)" }}>[.] package.json</span>
                  </div>
                </>
              )}
              {activeActivityTab === "search" && (
                <>
                  <div style={{ backgroundColor: "var(--surface-container)", padding: "4px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--primary)", fontWeight: "bold" }}>
                    <span>[ SEARCH ]</span>
                    <span style={{ color: "var(--outline-variant)", marginLeft: "auto" }}>═</span>
                  </div>
                  <Flex direction="column" gap="2" p="2" style={{ flex: 1 }}>
                    <input
                      type="text"
                      placeholder="Search files..."
                      style={{
                        background: "var(--surface-container)",
                        border: "1px solid var(--border-color)",
                        color: "var(--on-surface)",
                        padding: "4px 8px",
                        fontSize: "12px",
                        outline: "none",
                        fontFamily: "monospace"
                      }}
                    />
                    <Text size="1" style={{ color: "var(--text-muted)", fontStyle: "italic" }}>No search results yet.</Text>
                  </Flex>
                </>
              )}
              {activeActivityTab === "git" && (
                <>
                  <div style={{ backgroundColor: "var(--surface-container)", padding: "4px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--primary)", fontWeight: "bold" }}>
                    <span>[ GIT ]</span>
                    <span style={{ color: "var(--outline-variant)", marginLeft: "auto" }}>═</span>
                  </div>
                  <Flex direction="column" gap="3" p="2" style={{ flex: 1 }}>
                    <Text size="1" style={{ color: "var(--text-muted)" }}>CHANGES (1)</Text>
                    <Flex align="center" justify="between" px="2" py="1" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-light)" }}>
                      <Flex align="center" gap="2">
                        <span style={{ color: "var(--secondary)" }}>[.]</span>
                        <Text size="2" weight="medium">main.ts</Text>
                      </Flex>
                      <Text size="1" style={{ color: "var(--secondary)" }}>M</Text>
                    </Flex>
                    <button className="tui-nav-btn active" style={{ width: "100%" }}>
                      &lt; COMMIT 1 CHANGE &gt;
                    </button>
                  </Flex>
                </>
              )}
              {activeActivityTab === "extensions" && (
                <>
                  <div style={{ backgroundColor: "var(--surface-container)", padding: "4px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--primary)", fontWeight: "bold" }}>
                    <span>[ EXTENSIONS ]</span>
                    <span style={{ color: "var(--outline-variant)", marginLeft: "auto" }}>═</span>
                  </div>
                  <Flex direction="column" gap="3" p="2" style={{ flex: 1 }}>
                    <Flex direction="column" p="2" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-color)" }}>
                      <Text size="2" weight="bold">Deno Support</Text>
                      <Text size="1" style={{ color: "var(--text-muted)" }}>v1.0.4 - Enabled</Text>
                    </Flex>
                    <Flex direction="column" p="2" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-color)" }}>
                      <Text size="2" weight="bold">AI Copilot</Text>
                      <Text size="1" style={{ color: "var(--text-muted)" }}>v0.9.0 - Active</Text>
                    </Flex>
                  </Flex>
                </>
              )}
              {activeActivityTab === "settings" && (
                <>
                  <div style={{ backgroundColor: "var(--surface-container)", padding: "4px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--primary)", fontWeight: "bold" }}>
                    <span>[ SETTINGS ]</span>
                    <span style={{ color: "var(--outline-variant)", marginLeft: "auto" }}>═</span>
                  </div>
                  <Flex direction="column" gap="3" p="2" style={{ flex: 1 }}>
                    <Flex justify="between" align="center">
                      <Text size="2">Font Size</Text>
                      <Text size="2" weight="bold" style={{ color: "var(--primary)" }}>14px</Text>
                    </Flex>
                    <Flex justify="between" align="center">
                      <Text size="2">Theme</Text>
                      <Text size="2" weight="bold" style={{ color: "var(--primary)" }}>Obsidian Flux</Text>
                    </Flex>
                    <Flex justify="between" align="center">
                      <Text size="2">Line Wrap</Text>
                      <Text size="2" weight="bold" style={{ color: "var(--text-muted)" }}>On</Text>
                    </Flex>
                  </Flex>
                </>
              )}
            </Box>
            <ResizeHandle direction="horizontal" onResize={handleSidebarResize} />
          </>
        )}

        {/* Main Editor Area */}
        <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
          <Flex className="editor-tabs" align="end" px="2" style={{ height: "32px" }}>
            <div className="tab active">
              <span style={{ fontSize: "13px" }}>[ main.ts ]</span>
            </div>
            <div className="tab" style={{ opacity: 0.5, borderLeft: "none" }}>
              <span style={{ fontSize: "13px" }}>index.html</span>
            </div>
            <div className="tab" style={{ opacity: 0.5, borderLeft: "none" }}>
              <span style={{ fontSize: "13px" }}>styles.css</span>
            </div>
          </Flex>
          
          <Box className="editor-container" style={{ flex: 1, position: "relative", minHeight: 0 }}>
            <Editor
              file={activeFile}
              breakpoints={breakpoints}
              onToggleBreakpoint={handleToggleBreakpoint}
              currentLine={pausedLine}
              onEditorReady={setEditorMethods}
            />
          </Box>

          <ResizeHandle direction="vertical" onResize={handleBottomResize} />

          {/* Bottom Panel (Terminal/Console) */}
          <Box className="bottom-panel" style={{ display: 'flex', flexDirection: 'column', height: bottomPanelHeight, minHeight: bottomPanelHeight, flexShrink: 0 }}>
            <Flex className="panel-header" px="2" align="center" gap="4" style={{ height: "28px", borderBottom: "1px solid var(--border-color)" }}>
              <button
                className={`panel-tab-btn ${activeBottomTab === "terminal" ? "active" : ""}`}
                onClick={() => setActiveBottomTab("terminal")}
              >
                1: TERMINAL
              </button>
              <button
                className={`panel-tab-btn ${activeBottomTab === "output" ? "active" : ""}`}
                onClick={() => setActiveBottomTab("output")}
              >
                2: OUTPUT
              </button>
              <button
                className="panel-tab-btn"
                onClick={() => {}}
              >
                3: DEBUG
              </button>
              <div style={{ marginLeft: "auto", color: "var(--on-surface-variant)", opacity: 0.5 }}>─ ┼ ─</div>
            </Flex>
            <Box style={{ display: activeBottomTab === "terminal" ? "flex" : "none", flex: 1, minHeight: 0 }}>
              <DenoTerminal />
            </Box>
            <Box style={{ display: activeBottomTab === "output" ? "flex" : "none", flex: 1, minHeight: 0 }}>
              <ScrollArea style={{ flex: 1, padding: "12px" }}>
                <Flex direction="column" gap="1">
                  {consoleOutput.map((line, i) => (
                    <Text key={i} size="2" style={{ fontFamily: "monospace", color: line.startsWith("ERROR") ? "var(--error)" : "var(--on-surface-variant)" }}>
                      {line}
                    </Text>
                  ))}
                </Flex>
              </ScrollArea>
            </Box>
          </Box>
        </Flex>

        {/* Debug Panel (right side, visible when debugging) */}
        {isDebugging && (
          <>
            <ResizeHandle direction="horizontal" onResize={handleDebugPanelResize} />
            <DebugPanel
              isVisible={isDebugging}
              callFrames={callFrames}
              variables={debugVariables}
              width={debugPanelWidth}
            />
          </>
        )}

        {/* AI Copilot Panel */}
        {isAIPanelOpen && (
          <>
            <ResizeHandle direction="horizontal" onResize={handleAIPanelResize} />
            <AIPanel
              activeFile={activeFile}
              activeFileContent={editorMethods?.getValue() || ""}
              consoleLogs={consoleOutput}
              onInsertText={(text) => editorMethods?.insertText(text)}
              onReplaceContent={(content) => editorMethods?.replaceContent(content)}
              onClose={() => setIsAIPanelOpen(false)}
              width={aiPanelWidth}
            />
          </>
        )}
      </Flex>

      {/* TUI Footer Status Bar */}
      <footer className="tui-footer" style={{ flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontWeight: "bold" }}>[ NORMAL ]</span>
          <span style={{ color: "var(--on-primary-fixed-variant)" }}>main*</span>
          <span style={{ color: "var(--on-primary-fixed-variant)" }}>0 ERRORS</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "16px", fontSize: "11px" }}>
          <span>UTF-8</span>
          <span>TYPESCRIPT</span>
          <span>LN {pausedLine || 1}, COL 1</span>
          <span style={{ backgroundColor: "var(--secondary)", color: "var(--on-secondary)", padding: "0 8px", fontWeight: "bold" }}>READY</span>
        </div>
      </footer>

      {/* TUI Vim Style Command Line */}
      <form className="command-line" onSubmit={handleCommandSubmit} style={{ flexShrink: 0 }}>
        <span style={{ color: "var(--primary)", fontWeight: "bold", marginRight: "8px" }}>:</span>
        <input
          ref={commandInputRef}
          value={commandText}
          onChange={(e) => setCommandText(e.target.value)}
          placeholder="command... (try :help or :p for palette)"
          type="text"
        />
      </form>

      {/* TUI Style Command Palette (Overlay) */}
      {showCommandPalette && (
        <div className="command-palette-overlay">
          <div className="command-palette-header">
            ┌── EXECUTE COMMAND ──┐
          </div>
          <div className="command-palette-body">
            <div className="command-palette-input-container">
              <span>&gt;</span>
              <input
                autoFocus
                placeholder="Type a command..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setShowCommandPalette(false);
                    setConsoleOutput(prev => [...prev, "$ Command executed from palette"]);
                  }
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <div className="command-palette-item active" onClick={() => { setShowCommandPalette(false); setActiveActivityTab("explorer"); }}>
                <span>Go to File...</span>
                <span style={{ opacity: 0.5 }}>Ctrl+P</span>
              </div>
              <div className="command-palette-item" onClick={() => { setShowCommandPalette(false); handleRun(); }}>
                <span>Build & Run Project</span>
                <span style={{ opacity: 0.5 }}>F9</span>
              </div>
              <div className="command-palette-item" onClick={() => { setShowCommandPalette(false); setActiveActivityTab(activeActivityTab ? null : "explorer"); }}>
                <span>Toggle Sidebar</span>
                <span style={{ opacity: 0.5 }}>Ctrl+B</span>
              </div>
            </div>
          </div>
          <div className="command-palette-footer">
            Esc: CLOSE | Enter: SELECT
          </div>
        </div>
      )}
    </Flex>
  );
}

function formatValue(val: any): string {
  if (val.type === "string") return `"${val.value}"`;
  if (val.type === "number" || val.type === "boolean") return String(val.value);
  if (val.type === "undefined") return "undefined";
  if (val.type === "object") {
    if (val.subtype === "null") return "null";
    if (val.subtype === "array") {
      return val.description || "Array";
    }
    if (val.preview?.properties) {
      const entries = val.preview.properties
        .map((p: any) => `${p.name}: ${p.value}`)
        .join(", ");
      return `{${entries}}`;
    }
    return val.description || val.className || "Object";
  }
  if (val.type === "function") return `ƒ ${val.description?.split("(")[0] || ""}`;
  return String(val.value ?? val.description ?? "");
}

export default App;
