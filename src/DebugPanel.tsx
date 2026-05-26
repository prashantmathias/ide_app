import { Box, Flex, Text, ScrollArea } from "@radix-ui/themes";
import { Layers, Variable } from "lucide-react";

export interface DebugVariable {
  name: string;
  value: string;
  type: string;
}

export interface DebugCallFrame {
  functionName: string;
  lineNumber: number;
  columnNumber: number;
  scriptUrl: string;
}

export default function DebugPanel({
  isVisible,
  callFrames,
  variables,
  width = 280,
}: {
  isVisible: boolean;
  callFrames: DebugCallFrame[];
  variables: DebugVariable[];
  width?: number;
}) {
  if (!isVisible) return null;

  return (
    <Box className="debug-panel" p="3" style={{ width, minWidth: width, flexShrink: 0 }}>
      {/* Variables Section */}
      <Flex direction="column" gap="1" mb="4">
        <Flex align="center" gap="2" className="debug-section-header" mb="1">
          <Variable size={14} style={{ color: "var(--tertiary)" }} />
          <Text size="2" weight="bold" style={{ color: "var(--tertiary)" }}>
            VARIABLES
          </Text>
        </Flex>
        <ScrollArea style={{ maxHeight: "260px" }}>
          <Flex direction="column" gap="1">
            {variables.length === 0 ? (
              <Text size="1" color="gray" style={{ fontStyle: "italic", paddingLeft: 4 }}>
                No variables in scope
              </Text>
            ) : (
              variables.map((v, i) => (
                <Flex
                  key={i}
                  className="debug-variable-row"
                  align="center"
                  gap="2"
                  px="2"
                  py="1"
                >
                  <Text
                    size="1"
                    weight="medium"
                    style={{ color: "var(--primary)", fontFamily: "monospace", minWidth: 80 }}
                  >
                    {v.name}
                  </Text>
                  <Text
                    size="1"
                    style={{ color: "var(--on-surface-variant)", fontFamily: "monospace" }}
                  >
                    {v.type}
                  </Text>
                  <Text
                    size="1"
                    style={{
                      color: "var(--on-surface)",
                      fontFamily: "monospace",
                      marginLeft: "auto",
                      maxWidth: 120,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={v.value}
                  >
                    {v.value}
                  </Text>
                </Flex>
              ))
            )}
          </Flex>
        </ScrollArea>
      </Flex>

      {/* Call Stack Section */}
      <Flex direction="column" gap="1">
        <Flex align="center" gap="2" className="debug-section-header" mb="1">
          <Layers size={14} style={{ color: "var(--tertiary)" }} />
          <Text size="2" weight="bold" style={{ color: "var(--tertiary)" }}>
            CALL STACK
          </Text>
        </Flex>
        <ScrollArea style={{ maxHeight: "200px" }}>
          <Flex direction="column" gap="1">
            {callFrames.length === 0 ? (
              <Text size="1" color="gray" style={{ fontStyle: "italic", paddingLeft: 4 }}>
                Not paused
              </Text>
            ) : (
              callFrames.map((frame, i) => (
                <Flex
                  key={i}
                  className={`debug-stack-frame ${i === 0 ? "active" : ""}`}
                  direction="column"
                  px="2"
                  py="1"
                >
                  <Text
                    size="1"
                    weight="medium"
                    style={{ color: i === 0 ? "var(--tertiary)" : "var(--on-surface)", fontFamily: "monospace" }}
                  >
                    {frame.functionName || "(anonymous)"}
                  </Text>
                  <Text size="1" style={{ color: "var(--on-surface-variant)", fontFamily: "monospace" }}>
                    line {frame.lineNumber}:{frame.columnNumber}
                  </Text>
                </Flex>
              ))
            )}
          </Flex>
        </ScrollArea>
      </Flex>
    </Box>
  );
}
