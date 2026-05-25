import { useEffect, useState, useRef, useCallback } from "react";
import MonacoEditor, { useMonaco } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";

export default function Editor({
  file,
  breakpoints,
  onToggleBreakpoint,
}: {
  file: string;
  breakpoints: number[];
  onToggleBreakpoint: (line: number) => void;
}) {
  const monaco = useMonaco();
  const [code, setCode] = useState('console.log("Hello from Deno!");\n\n// Try Deno APIs:\n// Deno.readTextFileSync("main.ts")\n');
  const [editorInstance, setEditorInstance] = useState<any>(null);
  const decorationsRef = useRef<any>(null);
  const toggleBreakpointRef = useRef(onToggleBreakpoint);

  // Keep the ref current so the mouseDown handler always uses the latest callback
  useEffect(() => {
    toggleBreakpointRef.current = onToggleBreakpoint;
  }, [onToggleBreakpoint]);

  useEffect(() => {
    if (!monaco) return;
    const monacoAny = monaco as any;

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
      theme="vs-dark"
      path={file}
      value={code}
      onChange={handleChange}
      onMount={handleEditorDidMount}
      options={{
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 14,
        padding: { top: 16 },
        glyphMargin: true,
      }}
    />
  );
}
