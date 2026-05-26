import { useEffect, useState, useRef, useCallback } from "react";
import MonacoEditor, { useMonaco } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";

export interface EditorMethods {
  insertText: (text: string) => void;
  replaceContent: (content: string) => void;
  getValue: () => string;
}

export default function Editor({
  file,
  breakpoints,
  onToggleBreakpoint,
  currentLine,
  onEditorReady,
}: {
  file: string;
  breakpoints: number[];
  onToggleBreakpoint: (line: number) => void;
  currentLine: number | null;
  onEditorReady?: (methods: EditorMethods) => void;
}) {
  const monaco = useMonaco();
  const [code, setCode] = useState('console.log("Hello from Deno!");\n\n// Try Deno APIs:\n// Deno.readTextFileSync("main.ts")\n');
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const decorationsRef = useRef<any>(null);
  const currentLineDecRef = useRef<any>(null);
  const toggleBreakpointRef = useRef(onToggleBreakpoint);

  // Keep the ref current so the mouseDown handler always uses the latest callback
  useEffect(() => {
    toggleBreakpointRef.current = onToggleBreakpoint;
  }, [onToggleBreakpoint]);

  useEffect(() => {
    if (!monaco) return;
    const monacoAny = monaco as any;

    monaco.editor.defineTheme("obsidian-flux", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "fabc45" },
        { token: "string", foreground: "74dd7e" },
        { token: "comment", foreground: "8b919d", fontStyle: "italic" },
        { token: "type", foreground: "ffdeaa" },
        { token: "delimiter", foreground: "dfe2eb" },
        { token: "number", foreground: "74dd7e" },
      ],
      colors: {
        "editor.background": "#10141a",
        "editor.foreground": "#dfe2eb",
        "editor.lineHighlightBackground": "#1c2026",
        "editorGutter.background": "#10141a",
        "editor.selectionBackground": "#58a6ff33",
        "editorLineNumber.foreground": "#8b919d40",
        "editorLineNumber.activeForeground": "#a2c9ff",
      },
    });
    monaco.editor.setTheme("obsidian-flux");

    invoke<string>("get_deno_types").then((types) => {
      monacoAny.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monacoAny.languages.typescript.ScriptTarget.ESNext,
        module: monacoAny.languages.typescript.ModuleKind.ESNext,
        allowNonTsExtensions: true,
        moduleResolution: monacoAny.languages.typescript.ModuleResolutionKind.NodeJs,
      });

      monacoAny.languages.typescript.typescriptDefaults.addExtraLib(
        types,
        "file:///node_modules/@types/deno/index.d.ts"
      );
    }).catch(console.error);
    
    // Initial load
    invoke<string>("read_file", { path: file }).then((content) => {
      setCode(content);
    }).catch(() => {
      // If file doesn't exist, create it with default code
      invoke("save_file", { path: file, content: code });
    });

  }, [monaco, file]);

  useEffect(() => {
    if (!editorInstance || !monaco) return;

    const newDecorations = breakpoints.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: false,
        glyphMarginClassName: "breakpoint-glyph",
        glyphMarginHoverMessage: { value: "Breakpoint" },
      },
    }));

    if (!decorationsRef.current) {
      decorationsRef.current = editorInstance.createDecorationsCollection([]);
    }
    decorationsRef.current.set(newDecorations);
  }, [breakpoints, editorInstance, monaco]);

  // Current execution line highlight
  useEffect(() => {
    if (!editorInstance || !monaco) return;

    if (!currentLineDecRef.current) {
      currentLineDecRef.current = editorInstance.createDecorationsCollection([]);
    }

    if (currentLine !== null) {
      currentLineDecRef.current.set([{
        range: new monaco.Range(currentLine, 1, currentLine, 1),
        options: {
          isWholeLine: true,
          className: "debug-current-line",
          glyphMarginClassName: "debug-current-line-glyph",
        },
      }]);
      editorInstance.revealLineInCenter(currentLine);
    } else {
      currentLineDecRef.current.set([]);
    }
  }, [currentLine, editorInstance, monaco]);
  
  useEffect(() => {
    if (editorInstance && monaco && onEditorReady) {
      onEditorReady({
        insertText: (text: string) => {
          const selection = editorInstance.getSelection();
          const range = selection 
            ? new monaco.Range(
                selection.startLineNumber,
                selection.startColumn,
                selection.endLineNumber,
                selection.endColumn
              )
            : editorInstance.getPosition();
          
          editorInstance.executeEdits("ai-agent", [{
            range: range,
            text: text,
            forceMoveMarkers: true
          }]);
        },
        replaceContent: (content: string) => {
          editorInstance.setValue(content);
        },
        getValue: () => {
          return editorInstance.getValue();
        }
      });
    }
  }, [editorInstance, monaco, onEditorReady]);

  const handleEditorDidMount = useCallback((editor: any, monacoInst: any) => {
    setEditorInstance(editor);

    const GLYPH_MARGIN = monacoInst.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
    const LINE_DECORATIONS = monacoInst.editor.MouseTargetType.GUTTER_LINE_DECORATIONS;

    editor.onMouseDown((e: any) => {
      const target = e.target;
      if (
        target.type === GLYPH_MARGIN ||
        target.type === LINE_DECORATIONS
      ) {
        if (target.position) {
          const line = target.position.lineNumber;
          toggleBreakpointRef.current(line);
        }
      }
    });
  }, []);

  const handleChange = (value: string | undefined) => {
    if (value !== undefined) {
      setCode(value);
      // Auto-save on change
      invoke("save_file", { path: file, content: value }).catch(console.error);
    }
  };

  return (
    <MonacoEditor
      height="100%"
      language="typescript"
      theme="obsidian-flux"
      path={file}
      value={code}
      onChange={handleChange}
      onMount={handleEditorDidMount}
      options={{
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', monospace",
        padding: { top: 8 },
        glyphMargin: true,
        lineNumbersMinChars: 3,
        scrollbar: {
          vertical: 'visible',
          horizontal: 'visible',
          useShadows: false,
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
        }
      }}
    />
  );
}
