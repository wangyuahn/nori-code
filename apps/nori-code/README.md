# nori-code

> Nori Code - Loop-Core Multi-Agent Coding Tool

[![npm](https://img.shields.io/npm/v/nori-code)](https://www.npmjs.com/package/nori-code) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## What is Nori Code CLI

Nori Code CLI is an AI coding agent that runs in your terminal. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives.

## Install

The recommended install path is the official script. It does not require Node.js to be installed first.

- **macOS / Linux**:

```sh
curl -fsSL https://example.com/nori-code/install.sh | bash
```

- **Windows (PowerShell)**:

```powershell
irm https://example.com/nori-code/install.ps1 | iex
```

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Nori Code CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

Then run it with a new Terminal session:

```sh
nori --version
```

### Alternative: npm

If you prefer npm, use Node.js 22.19.0 or later:

```sh
npm install -g nori-code
```

Or with pnpm:

```sh
pnpm add -g nori-code
```

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
nori
```

On first launch, run `/login` inside Nori Code CLI to authenticate. After login, try a first task:

```
Take a look at this project and explain the main directories.
```

## Key Features

- **Single-binary distribution.** Install with one command — no Node.js setup, no PATH gymnastics, no global module conflicts.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so opening a session never feels heavy.
- **Polished TUI.** A carefully tuned interface designed for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat — let the agent watch instead of typing out what's hard to describe in words.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally via `/mcp-config` — no hand-editing JSON.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated context windows; the main conversation stays clean.
- **Lifecycle hooks.** Run local commands at key points — gate risky tool calls, audit decisions, fire desktop notifications, wire into your own automation.

## Documentation

- Full docs: (TBD)
- Getting Started: (TBD)

## Repository & Issues

- Source: (TBD)
- Issues: (TBD)
- Security: see SECURITY.md in the main repository

## License

MIT
