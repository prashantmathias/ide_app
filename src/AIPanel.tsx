import { useState, useEffect, useRef } from "react";
import { Box, Flex, Text, Button, ScrollArea, TextField, IconButton, Card } from "@radix-ui/themes";
import { Send, Settings, Sparkles, Copy, CornerDownLeft, X, Bug, Wrench, Check, FileCode, Eye } from "lucide-react";
import { OpenAI } from "openai";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
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
    "You are an AI programming assistant built into the Deno IDE. Help the user write, debug, and optimize their code. You have access to their active file and recent console output. When writing code, output complete, syntax-correct typescript blocks in markdown triple backticks. Keep explanations concise."
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
        content: `Hi! I'm your AI Copilot. I can see you are editing **${activeFile}**. Ask me to write code, explain functions, or debug errors!`,
        timestamp: new Date(),
      },
    ];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
        content: `Hi! I'm your AI Copilot. I can see you are editing **${activeFile}**. Ask me to write code, explain functions, or debug errors!`,
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

    const newMessages = overrideMessages || [...messages, userMessage];
    if (!overrideMessages) {
      setMessages(newMessages);
    }

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

      // Construct system payload with file context
      const contextSystemPrompt = `${systemPrompt}\n\n=== ACTIVE FILE: ${activeFile} ===\n\`\`\`typescript\n${activeFileContent}\n\`\`\``;

      const apiMessages = [
        { role: "system", content: contextSystemPrompt },
        ...newMessages.slice(-8).map((m) => ({
          role: m.role,
          content: m.content,
        })),
      ];

      const stream = await openai.chat.completions.create({
        model: model,
        messages: apiMessages as any,
        stream: true,
      });

      let accumulatedContent = "";
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        accumulatedContent += text;
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId ? { ...msg, content: accumulatedContent } : msg
          )
        );
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
    } finally {
      setIsLoading(false);
    }
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

  // Quick action prompt handlers
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

  // Simple custom Markdown formatter to avoid react-markdown npm issues
  const renderMessageContent = (msg: Message) => {
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
                <Flex align="center" justify="between" mb="2" pb="1" style={{ borderBottom: "1px solid rgba(255, 255, 255, 0.05)" }}>
                  <Text size="1" weight="bold" color="gray" style={{ fontFamily: "monospace", textTransform: "uppercase" }}>
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
                <pre style={{ margin: 0, padding: "8px", overflowX: "auto", fontSize: "12px", fontFamily: "monospace", color: "#e4f0fc" }}>
                  <code>{part.content}</code>
                </pre>
              </Card>
            );
          } else {
            // Render basic text formatting, handling bold **text** and newlines
            const textContent = part.content;
            const lines = textContent.split("\n");
            return (
              <Box key={index} style={{ fontSize: "13px", lineHeight: "1.5", color: "var(--gray-12)" }}>
                {lines.map((line, lIdx) => {
                  // Basic markdown parser for bold **text**
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
                    <div key={lIdx} style={{ minHeight: "1.2em", marginBottom: line === "" ? "8px" : "2px" }}>
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
        borderLeft: "1px solid var(--border-color)",
        backgroundColor: "var(--sidebar-bg)",
        backdropFilter: "blur(10px)",
      }}
    >
      {/* Panel Header */}
      <Flex className="ai-panel-header" align="center" justify="between" px="3" py="2" style={{ borderBottom: "1px solid var(--border-color)" }}>
        <Flex align="center" gap="2">
          <Sparkles size={16} style={{ color: "var(--accent-9)" }} />
          <Text size="2" weight="bold">AI Copilot</Text>
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
          <IconButton
            size="1"
            variant="ghost"
            onClick={onClose}
            style={{ cursor: "pointer" }}
            title="Close Panel"
          >
            <X size={14} />
          </IconButton>
        </Flex>
      </Flex>

      {/* Settings Dialog Overlay */}
      {showSettings && (
        <Card style={{ background: "rgba(20, 20, 25, 0.95)", border: "1px solid var(--accent-5)", padding: "12px", margin: "12px" }}>
          <Flex direction="column" gap="3">
            <Flex justify="between" align="center">
              <Text size="2" weight="bold">OpenAI Settings</Text>
              <IconButton size="1" variant="ghost" onClick={() => setShowSettings(false)} style={{ cursor: "pointer" }}>
                <X size={12} />
              </IconButton>
            </Flex>

            <Box>
              <Text size="1" color="gray" style={{ display: "block", marginBottom: "4px" }}>API Key</Text>
              <TextField.Root
                type="password"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </Box>

            <Box>
              <Text size="1" color="gray" style={{ display: "block", marginBottom: "4px" }}>Model</Text>
              <TextField.Root
                placeholder="gpt-4o-mini"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </Box>

            <Box>
              <Text size="1" color="gray" style={{ display: "block", marginBottom: "4px" }}>Base URL</Text>
              <TextField.Root
                placeholder="https://api.openai.com/v1"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </Box>

            <Box>
              <Text size="1" color="gray" style={{ display: "block", marginBottom: "4px" }}>System Prompt</Text>
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
              <Button size="1" variant="soft" color="gray" onClick={() => setShowSettings(false)} style={{ cursor: "pointer" }}>
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
                  <Flex align="center" gap="1" mb="1" style={{ opacity: 0.6 }}>
                    <Text size="1" color="gray">
                      {msg.role === "user" ? "You" : "Copilot"}
                    </Text>
                    <Text size="1" color="gray" style={{ fontSize: "10px" }}>
                      • {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </Flex>
                  <Box
                    className={msg.role === "user" ? "chat-bubble user" : "chat-bubble assistant"}
                    p="2"
                    style={{
                      maxWidth: "90%",
                      borderRadius: "8px",
                      backgroundColor: msg.role === "user" ? "rgba(0, 122, 255, 0.15)" : "rgba(255, 255, 255, 0.03)",
                      border: msg.role === "user" ? "1px solid rgba(0, 122, 255, 0.25)" : "1px solid rgba(255, 255, 255, 0.05)",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
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
          <Flex direction="column" gap="1" px="3" py="2" style={{ borderTop: "1px solid var(--border-color)", background: "rgba(255,255,255,0.01)" }}>
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
          <Box p="3" style={{ borderTop: "1px solid var(--border-color)", background: "var(--panel-bg)" }}>
            <Flex gap="2" align="end">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask AI Copilot... (Shift+Enter for newline)"
                rows={2}
                disabled={isLoading}
                style={{
                  flex: 1,
                  backgroundColor: "rgba(0, 0, 0, 0.3)",
                  border: "1px solid rgba(255, 255, 255, 0.1)",
                  borderRadius: "6px",
                  color: "white",
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
                  backgroundColor: input.trim() ? "var(--accent-9)" : "rgba(255, 255, 255, 0.05)",
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
