import { useState, useEffect, useRef } from "react";
import { Box, Flex, Text, Button, ScrollArea } from "@radix-ui/themes";
import { Play, Bug, File, Terminal, FastForward, StepForward } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Editor from "./Editor";
import { debuggerInstance } from "./debugger";
import "./App.css";

function App() {
  const [activeFile] = useState("main.ts");
  const [consoleOutput, setConsoleOutput] = useState<string[]>(["$ Deno IDE initialized."]);
  const [isDebugging, setIsDebugging] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [breakpoints, setBreakpoints] = useState<number[]>([]);
  const [activeBreakpointIds, setActiveBreakpointIds] = useState<Record<number, string>>({});
  
  const breakpointsRef = useRef<number[]>([]);
  
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

    debuggerInstance.onPaused = () => {
      setIsPaused(true);
      setConsoleOutput((prev) => [...prev, `$ Debugger paused.`]);
    };

    debuggerInstance.onResumed = () => {
      setIsPaused(false);
      setConsoleOutput((prev) => [...prev, `$ Resumed.`]);
    };

    debuggerInstance.onDisconnected = () => {
      setIsDebugging(false);
      setIsPaused(false);
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
      <Flex className="top-bar" align="center" justify="between" px="4" py="2">
        <Flex align="center" gap="3">
          <Text weight="bold" size="3" style={{ color: "var(--accent-9)" }}>Deno IDE</Text>
        </Flex>
        <Flex gap="2">
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
        </Flex>
      </Flex>

      <Flex style={{ flex: 1, overflow: "hidden" }}>
        {/* Sidebar */}
        <Box className="sidebar" width="250px" p="3">
          <Text size="2" weight="bold" mb="2" color="gray">EXPLORER</Text>
          <ScrollArea>
            <Flex direction="column" gap="1">
              <Flex align="center" gap="2" className="file-item active" pl="4">
                <File size={14} /> <Text size="2">main.ts</Text>
              </Flex>
            </Flex>
          </ScrollArea>
        </Box>

        {/* Main Editor Area */}
        <Flex direction="column" style={{ flex: 1 }}>
          <Flex className="editor-tabs" px="3" py="2" gap="2">
            <Box className="tab active">
              <Text size="2">main.ts</Text>
            </Box>
          </Flex>
          
          <Box className="editor-container" style={{ flex: 1, position: "relative" }}>
            <Editor
              file={activeFile}
              breakpoints={breakpoints}
              onToggleBreakpoint={handleToggleBreakpoint}
            />
          </Box>

          {/* Bottom Panel (Terminal/Console) */}
          <Box className="bottom-panel" height="200px" style={{ display: 'flex', flexDirection: 'column' }}>
            <Flex className="panel-header" px="3" py="1" align="center" gap="2">
              <Terminal size={14} /> <Text size="2" weight="bold">Console</Text>
            </Flex>
            <ScrollArea style={{ flex: 1, padding: "12px" }}>
              <Flex direction="column" gap="1">
                {consoleOutput.map((line, i) => (
                  <Text key={i} size="2" style={{ fontFamily: "monospace", color: line.startsWith("ERROR") ? "var(--tomato-11)" : "var(--gray-11)" }}>
                    {line}
                  </Text>
                ))}
              </Flex>
            </ScrollArea>
          </Box>
        </Flex>
      </Flex>
    </Flex>
  );
}

export default App;
