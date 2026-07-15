# Nori Code

> A multi-agent coding workspace for planning, implementation, review, and persistent project knowledge.

[中文说明](README.zh-CN.md)

![Nori Work](docs/images/nori-work.png)

Nori is available through two connected experiences:

- **Nori Code**: the terminal CLI/TUI for focused coding workflows.
- **Nori Work**: the Electron desktop workspace for conversations, files, Git, knowledge, usage, and Agent Swarm activity.

Nori is based on [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) under the MIT license. It retains required upstream compatibility while adding Nori's workflow, memory, desktop, and multi-agent capabilities.

## Highlights

- **Plan and Code modes**: Plan mode is read-only. Code mode can optionally allow the main Agent to use Edit and Write, which avoids launching a Swarm for every small change.
- **Background Agent work**: Agent Swarm and sub-agents continue in the background while the main Agent can keep working. Completion is delivered back into the parent context.
- **Agent activity tree**: Nori Work groups top-level Swarm rounds and nests Agents launched by other Agents beneath their caller. Live output, Markdown results, status, and token totals are available per Agent.
- **Streaming conversations**: assistant reasoning, tool calls, and Markdown answers update in place. Tool calls stay at their actual position in the turn instead of being collected at the bottom.
- **Provider flexibility**: configure API format, base URL, and key for built-in or compatible third-party providers. Models and supported reasoning levels are requested from the provider and selected beside the composer.
- **Multimodal input**: attach files and, when the selected model supports vision, images.
- **Project-oriented sessions**: conversations are grouped by project folder, can be collapsed, archived, restored, or deleted.
- **Workspace inspector**: browse project files and Git status, preview source with syntax highlighting, render Markdown, inspect recent Agent edits, and use Git diff/commit/publish controls.
- **Project knowledge**: Markdown notes support `[[wiki-links]]`, search, removal, and an interactive bidirectional-link graph.
- **Usage visibility**: Nori Work shows per-output usage, Agent totals, session totals, context utilization, and an initial-page usage overview.
- **Permission modes**: Manual asks for every operation, Auto approves ordinary operations according to policy, and Yolo approves all operations.

## Quick Start

Requirements: Node.js `>=24.15.0`.

```sh
npm install -g nori-code

# Interactive terminal UI
nori

# One-shot prompt
nori -p "your task"

# Start the local web workspace
nori web
```

In the TUI, use `/provider` to configure a provider and `/model` to select a model. Nori Work exposes the same provider settings in its Settings page and model selection in the chat composer.

### Build from source

```sh
git clone https://github.com/wangyuahn/nori-code.git
cd nori-code
corepack enable
pnpm install

pnpm dev:cli
pnpm dev:web
pnpm dev:desktop
```

Build the Windows desktop installer:

```sh
pnpm --filter @nori-code/nori-web build
pnpm -C apps/nori-code build:native:sea
pnpm -C apps/nori-code test:native:smoke
pnpm --filter @nori-code/nori-work dist
```

The generated installers are written to `apps/nori-desktop/dist-app/`.

## Workflow

Nori can combine model-driven work with deterministic project policy:

```text
request -> plan -> implement -> verify -> review -> summarize
             |          |
             |          +-> background Agent Swarm / sub-agents
             +-> project memory and rules
```

The optional `nori.yaml` in a project root controls phases, rules, review thresholds, and Swarm execution. Missing configuration uses runtime defaults.

```yaml
phases:
  - name: plan
    mode: hybrid
  - name: implement
    mode: llm-autonomous
  - name: review
    mode: rule-enforced
    rule_enforced:
      steps:
        - type: exec
          id: test
          command: "pnpm test"

workflow:
  review:
    suggestion_threshold: 4
    required_threshold: 7

swarm:
  max_concurrency: 4
  max_swarm_depth: 3
```

Configuration is resolved by the current runtime implementation in `packages/agent-core`. Invalid or security-sensitive configuration should fail closed rather than silently widen permissions.

## Tools

### Memory

| Tool | Purpose |
| --- | --- |
| `nori_memory_search` | Search Markdown notes using text, metadata, and link relationships |
| `nori_memory_write` | Create or update a project note with optional `[[wiki-links]]` |
| `nori_memory_remove` | Move a matching note into the vault's `.trash` directory |
| `nori_plan_write` | Write a plan document in the project workspace |

### Agent Swarm

| Tool | Purpose |
| --- | --- |
| `nori_swarm_launch` | Launch a dependency-aware group of background Agents |
| `nori_swarm_status` | Read live status for a running Swarm |
| `nori_swarm_result` | Retrieve completed Swarm results |
| `nori_ask_parent` | Let a child Agent request guidance from its parent |

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:brand
```

Run focused checks while developing, then expand verification according to the affected packages.

## License

MIT. Based on [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code), also licensed under MIT.
