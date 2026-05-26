import { useState, useEffect, useRef } from "react";
import { Box, Flex, Text, Button, ScrollArea, TextField, IconButton, Card } from "@radix-ui/themes";
import { Send, Settings, Sparkles, Copy, CornerDownLeft, X, Bug, Wrench, Check, FileCode, Eye, ChevronDown, ChevronUp } from "lucide-react";
import { OpenAI } from "openai";
import { invoke } from "@tauri-apps/api/core";

interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: Date;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  is_tool_status?: boolean;
}

export interface AIPanelProps {
  activeFile: string;
  activeFileContent: string;
  consoleLogs: string[];
  onInsertText: (text: string) => void;
  onReplaceContent: (content: string) => void;
  onClose: () => void;
  width: number;
}

// Tool definitions for OpenAI function calling
const agentTools = [
  {
    type: "function" as const,
    function: {
      name: "list_directory",
      description: "List files and directories in the given path (defaults to current project root directory if path is empty/'.')",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The relative or absolute path of the directory to list." }
        },
        required: []
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the full contents of a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The path of the file to read." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Create a new file or completely overwrite an existing file with new content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The path of the file to write to." },
          content: { type: "string", description: "The complete content to write into the file." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "Edit code by replacing a specific block of search text with replacement text in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The path of the file to edit." },
          searchText: { type: "string", description: "The exact block of code to find/replace. Be precise." },
          replaceText: { type: "string", description: "The new code to replace the searchText with." }
        },
        required: ["path", "searchText", "replaceText"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "delete_file",
      description: "Delete a file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The path of the file to delete." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "install_package",
      description: "Install a new NPM package into the project via npm install.",
      parameters: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "The name of the package to install." }
        },
        required: ["packageName"]
      }
    }
  }
];

export default function AIPanel({
  activeFile,
  activeFileContent,
  consoleLogs,
  onInsertText,
  onReplaceContent,
  onClose,
  width,
}: AIPanelProps) {
  // Config state (persisted in localStorage)
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("openai_api_key") || "");
  const [model, setModel] = useState(() => localStorage.getItem("openai_model") || "gpt-4o-mini");
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem("openai_endpoint") || "https://api.openai.com/v1");
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem("openai_system_prompt") || 
    "You are an AI agent built into the Deno IDE. You have access to tools to read, write, edit, and delete files, list directories, and install NPM packages. You can use these tools to perform tasks in the workspace automatically. Always explain what you are doing, and summarize your changes at the end."
  );

  const [showSettings, setShowSettings] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem(`ai_messages_${activeFile}`);
    if (saved) {
      try {
        return JSON.parse(saved).map((m: any) => ({
          ...m,
          timestamp: new Date(m.timestamp),
        }));
      } catch (e) {
        console.error(e);
      }
    }
    return [
      {
        id: "welcome",
        role: "assistant",
        content: `Hi! I'm your AI Agent Copilot. I have tools to explore directories, read, write, edit, and delete files, and install NPM packages. Ask me to make changes in your project!`,
        timestamp: new Date(),
      },
    ];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedToolIds, setExpandedToolIds] = useState<Record<string, boolean>>({});

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Persist messages per file
  useEffect(() => {
    localStorage.setItem(`ai_messages_${activeFile}`, JSON.stringify(messages));
  }, [messages, activeFile]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Save settings
  const handleSaveSettings = () => {
    localStorage.setItem("openai_api_key", apiKey);
    localStorage.setItem("openai_model", model);
    localStorage.setItem("openai_endpoint", endpoint);
    localStorage.setItem("openai_system_prompt", systemPrompt);
    setShowSettings(false);
  };

  const handleClearHistory = () => {
    if (confirm("Are you sure you want to clear chat history for this file?")) {
      const welcomeMsg: Message = {
        id: "welcome",
        role: "assistant",
        content: `Hi! I'm your AI Agent Copilot. I have tools to explore directories, read, write, edit, and delete files, and install NPM packages. Ask me to make changes in your project!`,
        timestamp: new Date(),
      };
      setMessages([welcomeMsg]);
    }
  };

  const handleCopyCode = (code: string, blockId: string) => {
    navigator.clipboard.writeText(code);
    setCopiedId(blockId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleToolExpand = (id: string) => {
    setExpandedToolIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Tool execution logic invoking Tauri Rust backends
  const executeTool = async (name: string, argsStr: string) => {
    let args: any = {};
    try {
      args = JSON.parse(argsStr || "{}");
    } catch (e) {
      return `Error parsing tool arguments: ${e}`;
    }

    try {
      switch (name) {
        case "list_directory": {
          const path = args.path || ".";
          const result = await invoke<any[]>("read_dir", { path });
          // Format output cleanly
          const filesSummary = result
            .map((f) => `${f.is_dir ? "📁" : "📄"} ${f.name} (${f.path})`)
            .join("\n");
          return filesSummary || "(Directory is empty)";
        }
        case "read_file": {
          const path = args.path;
          if (!path) return "Error: path is required";
          const content = await invoke<string>("read_file", { path });
          return content;
        }
        case "write_file": {
          const { path, content } = args;
          if (!path) return "Error: path is required";
          await invoke("save_file", { path, content });
          return `Successfully wrote file to ${path}`;
        }
        case "edit_file": {
          const { path, searchText, replaceText } = args;
          if (!path) return "Error: path is required";

          const originalContent = await invoke<string>("read_file", { path });
          if (!originalContent.includes(searchText)) {
            return `Error: Could not find exact search text in ${path}. Make sure search text matches exactly.`;
          }

          const newContent = originalContent.replace(searchText, replaceText);
          await invoke("save_file", { path, content: newContent });
          return `Successfully edited file ${path}`;
        }
        case "delete_file": {
          const path = args.path;
          if (!path) return "Error: path is required";
          await invoke("delete_file", { path });
          return `Successfully deleted file ${path}`;
        }
        case "install_package": {
          const { packageName } = args;
          if (!packageName) return "Error: packageName is required";
          const stdout = await invoke<string>("install_npm_package", { packageName });
          return `Successfully installed package ${packageName}.\nNPM Output:\n${stdout}`;
        }
        default:
          return `Error: Unknown tool ${name}`;
      }
    } catch (e: any) {
      return `Error executing tool ${name}: ${e.message || e.toString()}`;
    }
  };

  const callOpenAI = async (userQuery: string, overrideMessages?: Message[]) => {
    if (!apiKey) {
      alert("Please configure your OpenAI API Key in the settings first!");
      setShowSettings(true);
      return;
    }

    setIsLoading(true);
    const userMessage: Message = {
      id: Math.random().toString(),
      role: "user",
      content: userQuery,
      timestamp: new Date(),
    };

    let currentHistory = overrideMessages || [...messages, userMessage];
    if (!overrideMessages) {
      setMessages(currentHistory);
    }

    let loopLimit = 10;
    let currentIteration = 0;
    let shouldContinue = true;

    while (shouldContinue && currentIteration < loopLimit) {
      currentIteration++;

      const assistantMessageId = Math.random().toString();
      const newAssistantMessage: Message = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, newAssistantMessage]);

      try {
        const openai = new OpenAI({
          apiKey: apiKey,
          baseURL: endpoint || undefined,
          dangerouslyAllowBrowser: true,
        });

        const contextSystemPrompt = `${systemPrompt}\n\n=== ACTIVE FILE: ${activeFile} ===\n\`\`\`typescript\n${activeFileContent}\n\`\`\``;

        // Strip custom properties to prevent OpenAI API payload errors
        const apiMessages = [
          { role: "system", content: contextSystemPrompt },
          ...currentHistory.map((m) => {
            const apiMsg: any = { role: m.role, content: m.content || "" };
            if (m.tool_calls) apiMsg.tool_calls = m.tool_calls;
            if (m.tool_call_id) apiMsg.tool_call_id = m.tool_call_id;
            return apiMsg;
          }),
        ];

        const stream = await openai.chat.completions.create({
          model: model,
          messages: apiMessages as any,
          tools: agentTools,
          stream: true,
        });

        let accumulatedContent = "";
        let toolCalls: any[] = [];

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            accumulatedContent += delta.content;
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantMessageId ? { ...msg, content: accumulatedContent } : msg
              )
            );
          }

          if (delta?.tool_calls) {
            for (const tCall of delta.tool_calls) {
              const idx = tCall.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: tCall.id || "",
                  type: "function",
                  function: { name: "", arguments: "" }
                };
              }
              if (tCall.id) toolCalls[idx].id = tCall.id;
              if (tCall.function?.name) toolCalls[idx].function.name += tCall.function.name;
              if (tCall.function?.arguments) toolCalls[idx].function.arguments += tCall.function.arguments;
            }
          }
        }

        const finalToolCalls = toolCalls.filter(Boolean);

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  content: accumulatedContent,
                  tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
                }
              : msg
          )
        );

        const lastAssistantMsg: Message = {
          id: assistantMessageId,
          role: "assistant",
          content: accumulatedContent,
          timestamp: new Date(),
          tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
        };

        currentHistory = [...currentHistory, lastAssistantMsg];

        if (finalToolCalls.length > 0) {
          const toolResults: Message[] = [];

          for (const toolCall of finalToolCalls) {
            const toolCallId = toolCall.id;
            const functionName = toolCall.function.name;
            const functionArgs = toolCall.function.arguments;

            const statusMsgId = Math.random().toString();
            setMessages((prev) => [
              ...prev,
              {
                id: statusMsgId,
                role: "system",
                content: `🔧 Running tool "${functionName}" with args: ${functionArgs}...`,
                timestamp: new Date(),
                is_tool_status: true,
              },
            ]);

            const executionOutput = await executeTool(functionName, functionArgs);

            // Clear temporary status
            setMessages((prev) => prev.filter((m) => m.id !== statusMsgId));

            const toolResultMsg: Message = {
              id: Math.random().toString(),
              role: "tool",
              content: executionOutput,
              timestamp: new Date(),
              tool_call_id: toolCallId,
              name: functionName,
            };

            toolResults.push(toolResultMsg);
            setMessages((prev) => [...prev, toolResultMsg]);
          }

          currentHistory = [...currentHistory, ...toolResults];
        } else {
          shouldContinue = false;
        }
      } catch (e: any) {
        console.error(e);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, content: `Error communicating with AI: ${e.message || e.toString()}` }
              : msg
          )
        );
        shouldContinue = false;
      }
    }

    setIsLoading(false);
  };

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    const query = input;
    setInput("");
    callOpenAI(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleQuickAction = (actionType: "explain" | "refactor" | "test" | "debug") => {
    if (isLoading) return;

    let query = "";
    if (actionType === "explain") {
      query = "Explain the code in the active file, and outline what its main functions do.";
    } else if (actionType === "refactor") {
      query = "Refactor the active file's code to make it more clean, performant, and follow Deno best practices. Return the refactored code and explain the changes.";
    } else if (actionType === "test") {
      query = "Write comprehensive unit tests for the code in the active file using Deno's standard library `Deno.test`. Return the test suite code.";
    } else if (actionType === "debug") {
      const recentLogs = consoleLogs.slice(-15).join("\n");
      query = `I am getting errors. Here are the recent console/debugger logs:\n\`\`\`\n${recentLogs}\n\`\`\`\nPlease analyze these errors and the active file, explain the root cause, and propose code corrections.`;
    }

    callOpenAI(query);
  };

  const renderMessageContent = (msg: Message) => {
    if (msg.is_tool_status) {
      return (
        <Flex align="center" gap="2" style={{ padding: "4px 8px" }}>
          <Box className="ai-pulse-dot" style={{ width: "6px", height: "6px" }} />
          <Text size="1" color="indigo" style={{ fontStyle: "italic" }}>
            {msg.content}
          </Text>
        </Flex>
      );
    }

    if (msg.role === "tool") {
      const isExpanded = !!expandedToolIds[msg.id];
      return (
        <Flex direction="column" gap="1" style={{ width: "100%" }}>
          <Flex
            align="center"
            gap="2"
            style={{
              background: "var(--surface-lowest)",
              padding: "6px 10px",
              borderRadius: "6px",
              border: "1px solid var(--border-color)",
            }}
          >
            <Wrench size={12} style={{ color: "var(--tertiary)" }} />
            <Text size="1" weight="bold" style={{ color: "var(--tertiary)" }}>
              Tool executed: {msg.name}
            </Text>
            <IconButton
              size="1"
              variant="ghost"
              style={{ marginLeft: "auto", cursor: "pointer" }}
              onClick={() => toggleToolExpand(msg.id)}
            >
              {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </IconButton>
          </Flex>
          {isExpanded && (
            <pre
              style={{
                margin: 0,
                padding: "8px",
                background: "var(--surface-container-lowest)",
                border: "1px solid var(--border-color)",
                borderRadius: "4px",
                overflowX: "auto",
                fontSize: "11px",
                fontFamily: "monospace",
                color: "var(--primary)",
                maxHeight: "150px",
                overflowY: "auto",
              }}
            >
              <code>{msg.content}</code>
            </pre>
          )}
        </Flex>
      );
    }

    const text = msg.content;
    const parts = [];
    const regex = /```(\w*)\n([\s\S]*?)(?:```|$)/g;
    let lastIndex = 0;
    let match;
    let blockCount = 0;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({
          type: "text" as const,
          content: text.slice(lastIndex, match.index),
        });
      }
      parts.push({
        type: "code" as const,
        language: match[1] || "typescript",
        content: match[2],
        id: `${msg.id}-block-${blockCount++}`,
      });
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push({
        type: "text" as const,
        content: text.slice(lastIndex),
      });
    }

    return (
      <Flex direction="column" gap="2" style={{ width: "100%" }}>
        {parts.map((part, index) => {
          if (part.type === "code") {
            const isCopied = copiedId === part.id;
            return (
              <Card
                key={index}
                className="ai-code-card"
                style={{
                  background: "rgba(0, 0, 0, 0.4)",
                  border: "1px solid rgba(255, 255, 255, 0.08)",
                  borderRadius: "6px",
                  overflow: "hidden",
                  padding: "8px",
                }}
              >
                <Flex
                  align="center"
                  justify="between"
                  mb="2"
                  pb="1"
                  style={{ borderBottom: "1px solid rgba(255, 255, 255, 0.05)" }}
                >
                  <Text
                    size="1"
                    weight="bold"
                    color="gray"
                    style={{ fontFamily: "monospace", textTransform: "uppercase" }}
                  >
                    {part.language || "code"}
                  </Text>
                  <Flex gap="2">
                    <Button
                      size="1"
                      variant="ghost"
                      onClick={() => handleCopyCode(part.content, part.id)}
                      style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}
                    >
                      {isCopied ? <Check size={12} /> : <Copy size={12} />}
                      <Text size="1">{isCopied ? "Copied" : "Copy"}</Text>
                    </Button>
                    <Button
                      size="1"
                      variant="ghost"
                      onClick={() => onInsertText(part.content)}
                      style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}
                      title="Insert at Cursor in active file"
                    >
                      <CornerDownLeft size={12} />
                      <Text size="1">Insert</Text>
                    </Button>
                    <Button
                      size="1"
                      variant="ghost"
                      onClick={() => onReplaceContent(part.content)}
                      style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}
                      title="Replace entire active file content"
                    >
                      <FileCode size={12} />
                      <Text size="1">Replace File</Text>
                    </Button>
                  </Flex>
                </Flex>
                <pre
                  style={{
                    margin: 0,
                    padding: "8px",
                    overflowX: "auto",
                    fontSize: "12px",
                    fontFamily: "monospace",
                    color: "#e4f0fc",
                  }}
                >
                  <code>{part.content}</code>
                </pre>
              </Card>
            );
          } else {
            const textContent = part.content;
            const lines = textContent.split("\n");
            return (
              <Box key={index} style={{ fontSize: "13px", lineHeight: "1.5", color: "var(--gray-12)" }}>
                {lines.map((line, lIdx) => {
                  const boldRegex = /\*\*([\s\S]*?)\*\*/g;
                  const lineParts = [];
                  let lastTextIdx = 0;
                  let boldMatch;

                  while ((boldMatch = boldRegex.exec(line)) !== null) {
                    if (boldMatch.index > lastTextIdx) {
                      lineParts.push(line.slice(lastTextIdx, boldMatch.index));
                    }
                    lineParts.push(<strong key={boldMatch.index}>{boldMatch[1]}</strong>);
                    lastTextIdx = boldRegex.lastIndex;
                  }

                  if (lastTextIdx < line.length) {
                    lineParts.push(line.slice(lastTextIdx));
                  }

                  return (
                    <div
                      key={lIdx}
                      style={{ minHeight: "1.2em", marginBottom: line === "" ? "8px" : "2px" }}
                    >
                      {lineParts.length > 0 ? lineParts : " "}
                    </div>
                  );
                })}
              </Box>
            );
          }
        })}
      </Flex>
    );
  };

  return (
    <Box
      className="ai-panel"
      style={{
        width,
        minWidth: width,
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Panel Header */}
      <Flex
        className="ai-panel-header"
        align="center"
        justify="between"
        px="3"
        py="2"
        style={{ borderBottom: "1px solid var(--border-color)" }}
      >
        <Flex align="center" gap="2">
          <Sparkles size={16} style={{ color: "var(--primary)" }} />
          <Text size="2" weight="bold">
            AI Agent Copilot
          </Text>
          {isLoading && <Box className="ai-pulse-dot" />}
        </Flex>
        <Flex gap="1">
          <IconButton
            size="1"
            variant="ghost"
            onClick={() => setShowSettings(!showSettings)}
            style={{ cursor: "pointer" }}
            title="OpenAI Settings"
          >
            <Settings size={14} />
          </IconButton>
          <IconButton size="1" variant="ghost" onClick={onClose} style={{ cursor: "pointer" }} title="Close Panel">
            <X size={14} />
          </IconButton>
        </Flex>
      </Flex>

      {/* Settings Dialog Overlay */}
      {showSettings && (
        <Card
          style={{
            background: "var(--surface-container)",
            border: "1px solid var(--border-color)",
            padding: "12px",
            margin: "12px",
          }}
        >
          <Flex direction="column" gap="3">
            <Flex justify="between" align="center">
              <Text size="2" weight="bold">
                OpenAI Settings
              </Text>
              <IconButton size="1" variant="ghost" onClick={() => setShowSettings(false)} style={{ cursor: "pointer" }}>
                <X size={12} />
              </IconButton>
            </Flex>

            <Box>
              <Text size="1" color="gray" style={{ display: "block", marginBottom: "4px" }}>
                API Key
              </Text>
              <TextField.Root
                type="password"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </Box>

            <Box>
              <Text size="1" color="gray" style={{ display: "block", marginBottom: "4px" }}>
                Model
              </Text>
              <TextField.Root
                placeholder="gpt-4o-mini"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </Box>

            <Box>
              <Text size="1" color="gray" style={{ display: "block", marginBottom: "4px" }}>
                Base URL
              </Text>
              <TextField.Root
                placeholder="https://api.openai.com/v1"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </Box>

            <Box>
              <Text size="1" color="gray" style={{ display: "block", marginBottom: "4px" }}>
                System Prompt
              </Text>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3}
                style={{
                  width: "100%",
                  backgroundColor: "rgba(0, 0, 0, 0.3)",
                  border: "1px solid rgba(255, 255, 255, 0.1)",
                  borderRadius: "4px",
                  color: "white",
                  fontSize: "12px",
                  fontFamily: "sans-serif",
                  padding: "6px",
                  resize: "vertical",
                }}
              />
            </Box>

            <Flex gap="2" justify="end">
              <Button
                size="1"
                variant="soft"
                color="gray"
                onClick={() => setShowSettings(false)}
                style={{ cursor: "pointer" }}
              >
                Cancel
              </Button>
              <Button size="1" onClick={handleSaveSettings} style={{ cursor: "pointer" }}>
                Save Config
              </Button>
            </Flex>
          </Flex>
        </Card>
      )}

      {/* Main Panel Content */}
      {!showSettings && (
        <>
          {/* Messages Area */}
          <ScrollArea style={{ flex: 1, padding: "12px" }}>
            <Flex direction="column" gap="3" style={{ paddingBottom: "12px" }}>
              {messages.map((msg) => (
                <Flex
                  key={msg.id}
                  direction="column"
                  align={msg.role === "user" ? "end" : "start"}
                  style={{ width: "100%" }}
                >
                  {/* Don't render role label/timestamp for tool statuses */}
                  {!msg.is_tool_status && (
                    <Flex align="center" gap="1" mb="1" style={{ opacity: 0.6 }}>
                      <Text size="1" color="gray">
                        {msg.role === "user" ? "You" : msg.role === "tool" ? "Tool" : "Copilot"}
                      </Text>
                      <Text size="1" color="gray" style={{ fontSize: "10px" }}>
                        • {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </Text>
                    </Flex>
                  )}
                  <Box
                    className={
                      msg.is_tool_status
                        ? "tool-status-bubble"
                        : msg.role === "user"
                        ? "chat-bubble user"
                        : msg.role === "tool"
                        ? "chat-bubble tool"
                        : "chat-bubble assistant"
                    }
                    p={msg.is_tool_status ? "1" : "2"}
                    style={{
                      maxWidth: msg.is_tool_status ? "100%" : "90%",
                      borderRadius: "8px",
                      backgroundColor: msg.is_tool_status
                        ? "transparent"
                        : msg.role === "user"
                        ? "rgba(162, 201, 255, 0.08)"
                        : msg.role === "tool"
                        ? "rgba(250, 188, 69, 0.05)"
                        : "var(--surface-container-low)",
                      border: msg.is_tool_status
                        ? "none"
                        : msg.role === "user"
                        ? "1px solid rgba(162, 201, 255, 0.15)"
                        : msg.role === "tool"
                        ? "1px solid rgba(250, 188, 69, 0.1)"
                        : "1px solid var(--border-color)",
                      boxShadow: msg.is_tool_status ? "none" : "0 4px 12px rgba(0,0,0,0.1)",
                    }}
                  >
                    {renderMessageContent(msg)}
                  </Box>
                </Flex>
              ))}
              <div ref={messagesEndRef} />
            </Flex>
          </ScrollArea>

          {/* Quick Action Chips */}
          <Flex
            direction="column"
            gap="1"
            px="3"
            py="2"
            style={{ borderTop: "1px solid var(--border-color)", background: "rgba(255,255,255,0.01)" }}
          >
            <Flex gap="2" wrap="wrap">
              <Button
                size="1"
                variant="soft"
                color="blue"
                onClick={() => handleQuickAction("explain")}
                disabled={isLoading}
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}
              >
                <Eye size={12} /> Explain Code
              </Button>
              <Button
                size="1"
                variant="soft"
                color="indigo"
                onClick={() => handleQuickAction("refactor")}
                disabled={isLoading}
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}
              >
                <Wrench size={12} /> Refactor
              </Button>
              <Button
                size="1"
                variant="soft"
                color="purple"
                onClick={() => handleQuickAction("test")}
                disabled={isLoading}
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}
              >
                <FileCode size={12} /> Generate Tests
              </Button>
              {consoleLogs.length > 0 && (
                <Button
                  size="1"
                  variant="soft"
                  color="tomato"
                  onClick={() => handleQuickAction("debug")}
                  disabled={isLoading}
                  style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}
                >
                  <Bug size={12} /> Debug Error
                </Button>
              )}
            </Flex>
            <Flex justify="between" align="center" mt="1">
              <Text size="1" color="gray">
                Context: {activeFile} ({activeFileContent.length} chars)
              </Text>
              <Button
                size="1"
                variant="ghost"
                color="gray"
                onClick={handleClearHistory}
                style={{ cursor: "pointer", fontSize: "10px" }}
              >
                Clear History
              </Button>
            </Flex>
          </Flex>

          {/* Input Panel */}
          <Box p="3" style={{ borderTop: "1px solid var(--border-color)", background: "var(--surface-container)" }}>
            <Flex gap="2" align="end">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask AI Agent... (e.g. 'install express' or 'edit main.ts to...')"
                rows={2}
                disabled={isLoading}
                style={{
                  flex: 1,
                  backgroundColor: "var(--surface-container-lowest)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                  color: "var(--on-surface)",
                  fontSize: "13px",
                  padding: "8px",
                  resize: "none",
                  fontFamily: "sans-serif",
                  outline: "none",
                }}
              />
              <IconButton
                size="2"
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                style={{
                  cursor: "pointer",
                  height: "36px",
                  width: "36px",
                  backgroundColor: input.trim() ? "var(--primary)" : "rgba(255, 255, 255, 0.03)",
                  color: input.trim() ? "var(--on-primary)" : "var(--on-surface-variant)",
                }}
              >
                <Send size={16} />
              </IconButton>
            </Flex>
          </Box>
        </>
      )}
    </Box>
  );
}
