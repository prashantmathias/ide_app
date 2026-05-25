import { useEffect, useRef, useState } from "react";
import { Box, Button, Flex, Text } from "@radix-ui/themes";
import { Square } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export default function DenoTerminal() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const runningRef = useRef(false);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      fontSize: 13,
      theme: {
        background: "#0b0d12",
        foreground: "#d6deeb",
        cursor: "#7dd3fc",
        selectionBackground: "#334155",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.writeln("Starting unrestricted shell...");

    let shellStarted = false;

    const startShell = () => {
      if (shellStarted) return;
      fitAddon.fit();
      if (terminal.rows < 2 || terminal.cols < 2) return;

      shellStarted = true;
      void invoke("start_terminal_shell", { rows: terminal.rows, cols: terminal.cols }).catch((error) => {
        shellStarted = false;
        terminal.writeln(`\x1b[31mFailed to start shell: ${String(error)}\x1b[0m`);
      });
    };

    const resizeTerminal = () => {
      fitAddon.fit();
      startShell();
      if (runningRef.current) {
        void invoke("resize_terminal", { rows: terminal.rows, cols: terminal.cols });
      }
    };

    const resizeObserver = new ResizeObserver(resizeTerminal);
    resizeObserver.observe(containerRef.current);

    const dataDisposable = terminal.onData((data) => {
      void invoke("send_terminal_input", { data });
    });

    const unlistenOutput = listen<string>("terminal-output", (event) => {
      terminal.write(event.payload);
    });

    const unlistenReady = listen("terminal-ready", () => {
      runningRef.current = true;
      setIsRunning(true);
    });

    const unlistenExit = listen<string>("terminal-exit", () => {
      runningRef.current = false;
      setIsRunning(false);
      shellStarted = false;
      terminal.writeln("\x1b[33mShell stopped. Resize the panel or restart the app to reconnect.\x1b[0m");
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(startShell);
    });

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      void unlistenOutput.then((unlisten) => unlisten());
      void unlistenReady.then((unlisten) => unlisten());
      void unlistenExit.then((unlisten) => unlisten());
    };
  }, []);

  const stopCommand = async () => {
    await invoke("stop_terminal_command");
  };

  return (
    <Flex direction="column" style={{ flex: 1, minHeight: 0 }}>
      <Flex align="center" justify="between" px="3" py="1" className="terminal-toolbar">
        <Text size="1" color="gray">
          Unrestricted shell terminal
        </Text>
        <Button
          size="1"
          variant="soft"
          color="tomato"
          disabled={!isRunning}
          onClick={() => void stopCommand()}
          style={{ cursor: isRunning ? "pointer" : "default" }}
        >
          <Square size={12} /> Stop
        </Button>
      </Flex>
      <Box ref={containerRef} className="terminal-host" />
    </Flex>
  );
}
