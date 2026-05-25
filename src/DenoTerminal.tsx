import { useEffect, useRef, useState } from "react";
import { Box, Button, Flex, Text } from "@radix-ui/themes";
import { Square } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const PROMPT = "\r\ndeno$ ";

export default function DenoTerminal() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputRef = useRef("");
  const commandHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
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

    terminal.writeln("Deno terminal ready.");
    terminal.writeln("Only deno commands are allowed, for example: deno run main.ts");
    terminal.write("deno$ ");

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(containerRef.current);

    const dataDisposable = terminal.onData((data) => {
      if (runningRef.current) {
        if (data === "\u0003") {
          void stopCommand();
          return;
        }
        void invoke("send_terminal_input", { data });
        return;
      }

      handlePromptInput(data);
    });

    const unlistenOutput = listen<string>("terminal-output", (event) => {
      terminal.write(event.payload);
    });

    const unlistenExit = listen<string>("terminal-exit", () => {
      runningRef.current = false;
      setIsRunning(false);
      terminal.write(PROMPT);
    });

    return () => {
      dataDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      void unlistenOutput.then((unlisten) => unlisten());
      void unlistenExit.then((unlisten) => unlisten());
    };
  }, []);

  const handlePromptInput = (data: string) => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (data === "\r") {
      const command = inputRef.current.trim();
      terminal.write("\r\n");
      inputRef.current = "";
      historyIndexRef.current = null;

      if (!command) {
        terminal.write("deno$ ");
        return;
      }

      if (command === "clear") {
        terminal.clear();
        terminal.write("deno$ ");
        return;
      }

      commandHistoryRef.current.push(command);
      void runCommand(command);
      return;
    }

    if (data === "\u007f") {
      if (inputRef.current.length > 0) {
        inputRef.current = inputRef.current.slice(0, -1);
        terminal.write("\b \b");
      }
      return;
    }

    if (data === "\u001b[A" || data === "\u001b[B") {
      navigateHistory(data === "\u001b[A" ? -1 : 1);
      return;
    }

    if (data >= " " && data !== "\u007f") {
      inputRef.current += data;
      terminal.write(data);
    }
  };

  const navigateHistory = (direction: -1 | 1) => {
    const terminal = terminalRef.current;
    if (!terminal || commandHistoryRef.current.length === 0) return;

    const history = commandHistoryRef.current;
    const currentIndex =
      historyIndexRef.current === null ? history.length : historyIndexRef.current;
    const nextIndex = Math.max(0, Math.min(history.length, currentIndex + direction));
    historyIndexRef.current = nextIndex === history.length ? null : nextIndex;

    while (inputRef.current.length > 0) {
      inputRef.current = inputRef.current.slice(0, -1);
      terminal.write("\b \b");
    }

    const nextCommand = historyIndexRef.current === null ? "" : history[nextIndex];
    inputRef.current = nextCommand;
    terminal.write(nextCommand);
  };

  const runCommand = async (command: string) => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    runningRef.current = true;
    setIsRunning(true);

    try {
      await invoke("run_terminal_command", { command });
    } catch (error) {
      runningRef.current = false;
      setIsRunning(false);
      terminal.writeln(`\x1b[31m${String(error)}\x1b[0m`);
      terminal.write("deno$ ");
    }
  };

  const stopCommand = async () => {
    const terminal = terminalRef.current;
    terminal?.write("^C\r\n");
    await invoke("stop_terminal_command");
  };

  return (
    <Flex direction="column" style={{ flex: 1, minHeight: 0 }}>
      <Flex align="center" justify="between" px="3" py="1" className="terminal-toolbar">
        <Text size="1" color="gray">
          Deno-only terminal
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
