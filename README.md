# Deno IDE

A desktop IDE prototype for writing, running, debugging, and managing Deno TypeScript code. The app is built with Tauri, React, Vite, Monaco Editor, Radix UI, xterm.js, and a Rust backend.

## What It Does

- Provides a Monaco-powered TypeScript editor for `main.ts`.
- Auto-saves editor changes through Tauri file commands.
- Loads Deno type definitions from `deno types` so Monaco can understand Deno globals.
- Runs the active file with `deno run -A main.ts`.
- Starts a Deno debug session with `deno run -A --inspect-brk main.ts`.
- Connects to the Deno inspector over the Chrome DevTools Protocol for breakpoints, pause/resume, stepping, call stack, and local variable inspection.
- Shows run/debug output in an `Output` panel.
- Includes a PTY-backed unrestricted shell terminal in the bottom panel using xterm.js.
- Uses resizable sidebar, editor, bottom panel, and debugger panes.
- **AI Agent Copilot**: A side panel for chat assistance that can explain, refactor, and write tests, as well as execute autonomous workspace modifications (read, write, edit, and delete files, list directories, and install NPM packages).

## Main UI

The app has a small IDE layout:

- Top bar: Run, Debug, Resume, Step, and **AI Copilot** panel controls.
- Sidebar: file explorer area currently focused on `main.ts`.
- Editor: Monaco editor with breakpoint gutter support and current execution line highlighting.
- Bottom panel: tabs for `Terminal` and `Output`.
- Debug panel: appears while debugging and shows variables plus call stack frames.
- **AI Copilot Side Panel**: Collapsible right-hand panel offering interactive chat, system prompt settings, quick actions, and tool output streams.

## Terminal

The terminal is an unrestricted interactive shell backed by `portable-pty`.

On Windows, the backend starts the first available shell in this order:

1. `bash -i`
2. `pwsh -NoLogo`
3. `powershell.exe -NoLogo`

Keystrokes are sent directly to the PTY, output is streamed back to xterm.js, and terminal resize events are forwarded to the backend.

## Backend Commands

The Tauri backend exposes commands for:

- Reading directories and files.
- Saving file contents.
- Deleting files.
- Installing NPM packages.
- Fetching Deno types.
- Running and debugging Deno files.
- Starting, resizing, writing to, and stopping the shell terminal.

## AI Agent Copilot & Tools

The AI Copilot operates as an autonomous agent using the official OpenAI SDK. It features a ReAct-style loop that allows the model to decide when to call tools, execute them on the system using Tauri commands, and feed the results back to continue the response.

### Available Tools:
- `list_directory`: Traverses workspace files and folders.
- `read_file`: Reads file content.
- `write_file`: Writes/overwrites files.
- `edit_file`: Performs search-and-replace edits.
- `delete_file`: Deletes files from the workspace.
- `install_package`: Installs NPM packages via `npm install`.

### AI Configuration:
Users can configure the following in the side panel settings:
- **OpenAI API Key** (saved locally in `localStorage`).
- **OpenAI Model** (defaults to `gpt-4o-mini`).
- **Base URL** (enabling custom endpoints like Ollama, LocalAI, or gateway proxies).
- **System Prompt** (allowing customization of the agent's behavior and context).

## Development

Install dependencies:

```bash
npm install
```

Run the web dev server only:

```bash
npm run dev
```

Run the full Tauri app:

```bash
npm run tauri dev
```

Build the frontend:

```bash
npm run build
```

Check the Rust backend:

```bash
cd src-tauri
cargo check
```

## Requirements

- Node.js and npm
- Rust toolchain
- Deno
- Tauri prerequisites for your platform
