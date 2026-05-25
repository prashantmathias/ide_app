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

## Main UI

The app has a small IDE layout:

- Top bar: Run, Debug, Resume, and Step controls.
- Sidebar: file explorer area currently focused on `main.ts`.
- Editor: Monaco editor with breakpoint gutter support and current execution line highlighting.
- Bottom panel: tabs for `Terminal` and `Output`.
- Debug panel: appears while debugging and shows variables plus call stack frames.

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
- Fetching Deno types.
- Running and debugging Deno files.
- Starting, resizing, writing to, and stopping the shell terminal.

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
