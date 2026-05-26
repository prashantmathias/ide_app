import { useState, useEffect, useRef, useCallback } from "react";
import { Box, Flex, Text, Button, ScrollArea } from "@radix-ui/themes";
import { Play, Bug, File, Terminal, FastForward, StepForward, Sparkles, FolderOpen, Search, GitBranch, Blocks, Settings } from "lucide-react";
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
      {/* Top Bar */}
      <Flex className="top-bar" align="center" justify="between" px="4">
        {/* Left Side: Brand & Navigation */}
        <Flex align="center" gap="3">
          <Text weight="bold" size="3" className="brand-text">Deno IDE</Text>
          <Flex gap="3" ml="4" className="hidden md:flex">
            <div className="top-bar-nav-btn">File</div>
            <div className="top-bar-nav-btn">Edit</div>
            <div className="top-bar-nav-btn">Selection</div>
            <div className="top-bar-nav-btn">View</div>
            <div className="top-bar-nav-btn">Go</div>
          </Flex>
        </Flex>

        {/* Center Search Bar */}
        <Flex style={{ flex: 1, justifyContent: "center" }} px="4">
          <Flex align="center" gap="2" px="3" py="1" className="top-bar-search" style={{ width: "100%", maxWidth: "360px" }}>
            <Search size={12} />
            <Text style={{ fontSize: "11px" }}>Search main.ts...</Text>
          </Flex>
        </Flex>

        {/* Right Side: Debug/Run Actions & AI Panel trigger */}
        <Flex gap="2" align="center">
          {isDebugging && isPaused && (
             <>
               <Button variant="soft" color="green" size="2" style={{ cursor: "pointer" }} onClick={handleResume}>
                 <FastForward size={16} /> Resume
               </Button>
               <Button variant="soft" color="blue" size="2" style={{ cursor: "pointer" }} onClick={handleStepOver}>
                 <StepForward size={16} /> Step
               </Button>
             </>
          )}
          <Button variant="soft" size="2" style={{ cursor: "pointer" }} onClick={handleRun}>
            <Play size={16} /> Run
          </Button>
          <Button variant="soft" color="tomato" size="2" style={{ cursor: "pointer" }} onClick={handleDebug}>
            <Bug size={16} /> Debug
          </Button>
          <Button
            variant={isAIPanelOpen ? "solid" : "soft"}
            color="indigo"
            size="2"
            style={{ cursor: "pointer" }}
            onClick={() => setIsAIPanelOpen(!isAIPanelOpen)}
          >
            <Sparkles size={16} /> AI Copilot
          </Button>
        </Flex>
      </Flex>

      <Flex style={{ flex: 1, overflow: "hidden" }}>
        {/* Activity Bar (Vertical Navigation) */}
        <div className="activity-bar">
          <div
            className={`activity-item ${activeActivityTab === "explorer" ? "active" : ""}`}
            onClick={() => setActiveActivityTab(activeActivityTab === "explorer" ? null : "explorer")}
            title="Explorer"
          >
            <FolderOpen size={20} />
          </div>
          <div
            className={`activity-item ${activeActivityTab === "search" ? "active" : ""}`}
            onClick={() => setActiveActivityTab(activeActivityTab === "search" ? null : "search")}
            title="Search"
          >
            <Search size={20} />
          </div>
          <div
            className={`activity-item ${activeActivityTab === "git" ? "active" : ""}`}
            onClick={() => setActiveActivityTab(activeActivityTab === "git" ? null : "git")}
            title="Source Control"
          >
            <GitBranch size={20} />
          </div>
          <div
            className={`activity-item ${activeActivityTab === "extensions" ? "active" : ""}`}
            onClick={() => setActiveActivityTab(activeActivityTab === "extensions" ? null : "extensions")}
            title="Extensions"
          >
            <Blocks size={20} />
          </div>
          
          <div style={{ marginTop: "auto", width: "100%", display: "flex", flexDirection: "column", gap: "16px", alignItems: "center" }}>
            <div
              className={`activity-item ${activeActivityTab === "settings" ? "active" : ""}`}
              onClick={() => setActiveActivityTab(activeActivityTab === "settings" ? null : "settings")}
              title="Settings"
            >
              <Settings size={20} />
            </div>
          </div>
        </div>

        {/* Sidebar Panel */}
        {activeActivityTab && (
          <>
            <Box className="sidebar" p="3" style={{ width: sidebarWidth, minWidth: sidebarWidth, flexShrink: 0, display: "flex", flexDirection: "column" }}>
              {activeActivityTab === "explorer" && (
                <>
                  <Text size="1" weight="bold" mb="2" color="gray" style={{ letterSpacing: "0.05em" }}>EXPLORER</Text>
                  <ScrollArea style={{ flex: 1 }}>
                    <Flex direction="column" gap="1">
                      <Flex align="center" gap="2" className="file-item active" pl="4">
                        <File size={14} /> <Text size="2">main.ts</Text>
                      </Flex>
                    </Flex>
                  </ScrollArea>
                </>
              )}
              {activeActivityTab === "search" && (
                <>
                  <Text size="1" weight="bold" mb="2" color="gray" style={{ letterSpacing: "0.05em" }}>SEARCH</Text>
                  <ScrollArea style={{ flex: 1 }}>
                    <Flex direction="column" gap="2" p="1">
                      <input
                        type="text"
                        placeholder="Search files..."
                        style={{
                          background: "var(--surface-container)",
                          border: "1px solid var(--border-color)",
                          color: "var(--on-surface)",
                          padding: "6px 10px",
                          borderRadius: "var(--radius-md)",
                          fontSize: "12px",
                          outline: "none",
                        }}
                      />
                      <Text size="1" style={{ color: "var(--text-muted)", fontStyle: "italic" }}>No search results yet.</Text>
                    </Flex>
                  </ScrollArea>
                </>
              )}
              {activeActivityTab === "git" && (
                <>
                  <Text size="1" weight="bold" mb="2" color="gray" style={{ letterSpacing: "0.05em" }}>SOURCE CONTROL</Text>
                  <ScrollArea style={{ flex: 1 }}>
                    <Flex direction="column" gap="3" p="1">
                      <Text size="1" style={{ color: "var(--text-muted)" }}>CHANGES (1)</Text>
                      <Flex align="center" justify="between" px="2" py="1" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)" }}>
                        <Flex align="center" gap="2">
                          <File size={12} style={{ color: "var(--secondary)" }} />
                          <Text size="2" weight="medium">main.ts</Text>
                        </Flex>
                        <Text size="1" style={{ color: "var(--secondary)" }}>M</Text>
                      </Flex>
                      <Button size="1" variant="soft" color="green" style={{ cursor: "pointer", width: "100%" }}>
                        Commit 1 Change
                      </Button>
                    </Flex>
                  </ScrollArea>
                </>
              )}
              {activeActivityTab === "extensions" && (
                <>
                  <Text size="1" weight="bold" mb="2" color="gray" style={{ letterSpacing: "0.05em" }}>EXTENSIONS</Text>
                  <ScrollArea style={{ flex: 1 }}>
                    <Flex direction="column" gap="3" p="1">
                      <Flex direction="column" p="2" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)" }}>
                        <Text size="2" weight="bold">Deno Support</Text>
                        <Text size="1" style={{ color: "var(--text-muted)" }}>v1.0.4 - Enabled</Text>
                      </Flex>
                      <Flex direction="column" p="2" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-md)" }}>
                        <Text size="2" weight="bold">AI Copilot</Text>
                        <Text size="1" style={{ color: "var(--text-muted)" }}>v0.9.0 - Active</Text>
                      </Flex>
                    </Flex>
                  </ScrollArea>
                </>
              )}
              {activeActivityTab === "settings" && (
                <>
                  <Text size="1" weight="bold" mb="2" color="gray" style={{ letterSpacing: "0.05em" }}>SETTINGS</Text>
                  <ScrollArea style={{ flex: 1 }}>
                    <Flex direction="column" gap="3" p="1">
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
                  </ScrollArea>
                </>
              )}
            </Box>
            <ResizeHandle direction="horizontal" onResize={handleSidebarResize} />
          </>
        )}

        {/* Main Editor Area */}
        <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
          <Flex className="editor-tabs" align="center" gap="1" px="2">
            <div className="tab active">
              <Text size="2">main.ts</Text>
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
            <Flex className="panel-header" px="3" py="1" align="center" gap="2">
              <Button
                size="1"
                variant={activeBottomTab === "terminal" ? "soft" : "ghost"}
                onClick={() => setActiveBottomTab("terminal")}
                style={{ cursor: "pointer" }}
              >
                <Terminal size={14} /> Terminal
              </Button>
              <Button
                size="1"
                variant={activeBottomTab === "output" ? "soft" : "ghost"}
                onClick={() => setActiveBottomTab("output")}
                style={{ cursor: "pointer" }}
              >
                Output
              </Button>
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
