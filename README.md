# CodeCraft Go

A Bubble Tea terminal IDE for Deno TypeScript projects. This rewrite replaces the previous Rust/Ratatui prototype with a Go application built on Charm's Bubble Tea and lipgloss stack.

## Features

- Workspace file explorer with create/open/run/debug actions.
- Modal text editor with Vim-flavored normal, insert, explorer, and command modes.
- Save, run, and debug the active Deno file.
- Deno runner output plus console logs and a one-shot shell command panel.
- V8 inspector debugging through Chrome DevTools Protocol:
  - breakpoints
  - pause/resume
  - step over
  - step into
  - call stack
  - local and closure variable inspection
- AI Agent side panel using OpenAI-compatible chat completions and function tools:
  - list workspace
  - read file
  - write file
  - edit file
  - delete file
  - install NPM package
- AI settings overlay for API key, model, base URL, and system prompt.

## Requirements

- Go 1.26 or newer
- Deno
- Node.js/npm if you want the AI tool to install NPM packages
- `OPENAI_API_KEY` in the environment, `.env`, or the F2 settings panel for AI chat

## Run

```powershell
go run .
```

To open a different workspace:

```powershell
go run . C:\path\to\workspace
```

## Build

```powershell
go build -o codecraft.exe .
```

## Install On Windows

```powershell
.\install.ps1
```

Use `-Force` to overwrite an existing installed binary:

```powershell
.\install.ps1 -Force
```

## Keyboard

- `F1`: help
- `F2`: AI settings
- `Ctrl+A`: toggle AI panel
- `Ctrl+Q`: quit
- `i`: insert mode
- `Esc`: normal mode
- `:`: command mode
- `v`: explorer mode
- `Tab`: cycle focus
- `1`, `2`, `3`: Output, Console, Terminal tabs
- `F9`: run active file with `deno run -A`
- `F5`: start debug session or resume while paused
- `F10`: step over
- `F11`: step into
- `b`: toggle breakpoint on the editor line

Command mode supports `:w`, `:q`, `:r`, `:d`, `:bp <line>`, and `:help`.

## Notes

The terminal tab runs one shell command at a time and streams stdout/stderr back into the TUI. It is not a persistent PTY session.
