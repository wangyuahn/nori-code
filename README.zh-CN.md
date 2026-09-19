# Nori Code / Nori Work

> **早期项目。** 当前产品是 **团队工程**：持久的部门树、先 Discuss 再 Assign、用 `parent_session_id` 连起来的会话地图。已删除的 SubAgent DAG **不是** 产品路径。

Nori 是一个从 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)（MIT）fork 出来的编程 Agent 工作区。终端里是 Nori Code；桌面端是 Nori Work。和 Codex / Claude Code 一样，它能读改代码、跑命令、接 MCP；和它们不一样的地方，是它把「把活交给另一个 Agent」做成了**长期部门**，而不是一次性 fan-out。

[English](README.md)

![Nori Work 对话工作区](docs/images/nori-work-overview.png)

![Nori Work 浏览器工作区](docs/images/nori-work-browser.png)

> [!NOTE]
> 最新发布说明见 [CHANGELOG.md](CHANGELOG.md) 的 `v2.0.0`。那一节才是当前委派模型的源。更早条目里的 SubAgent、DAG、`nori_swarm_launch` 描述的是已经拿掉的路径。

---

## 1. 现在的 Nori 是什么

**团队工程（Team Engineering）** 是现在把工作交给另一个 Agent 的**唯一**方式。临时 `SubAgent` 工具、`'sub'` 节点、TUI 的 subagent 进度条都已删除。原因写在 changelog 里：两个 spawn 路径会变成两套「现在谁在干活」的状态源；更重要的是，一次性子 Agent 各自闷头做完再汇报，错位假设要到 `done` 才露面——那是 fan-out，不是团队。

### 部门树，不是任务池

- 每个 Agent 可以用 `TeamCreate` 雇佣自己的成员，并主持自己的部门。深度受 `team.maxDepth` 约束（默认 `2`，上限 `5`）。
- 一次 Discuss 的范围是**一个部门**：父节点 + 它的直接成员。节点不会同时当主席又当发言人。
- 雇佣走的是和会话地图同一条路径：创建一个**真实子会话**，用 `parent_session_id` 挂到你下面，地图上就是一张会话卡片。工作、工具、兄弟交流和身份都住在这个子会话上。Discuss / Assign 按 session id（或展示名）寻址。
- `TeamDismiss` 移除成员并**删除**对应子会话。地图上的 Unmount 是用户操作：只拆挂载，不删会话。一个会话目前只能有一个父节点。

### 先 Discuss，再 Code

典型流程：

1. **`TeamCreate`** — 只雇当前工作真正需要的人（`name` / `role` / `mandate`）。
2. **`TeamDecide action=start`** — 主席抛出目标、约束和未决问题，**还没有**固定方案。
3. **`TeamSpeak`** — 成员轮流发言。后发言的人会读到本轮已发表的全部内容；光附和不算贡献。一轮只推进一步。
4. **`TeamAssign`** — 给每个成员恰好一份任务（`task=null` 表示闲置）。成功则离开 Discuss，进入 Code。
5. 计划变了、两人要碰到同一块地、或进展卡住时，用 **`TeamDecide action=continue`** 再开会，而不是等所有人报 `done` 再对账。

Discuss 开着时，包括主席在内，`Write`、`Edit`、`Bash`、`TaskStop`、`CronCreate`、`CronDelete` 都会被拒绝。出路写在拒绝信息里：用 `Read` / `Grep` / `Glob` 弄清事实，然后 `TeamAssign`。

主 Agent 默认是**只读协调者**（`/setting readonly on`）：自己不写文件，成员在 Assign 之后执行。需要负责人直接改代码时再用 `/setting readonly off`。

### 成员之间能直接说话

- **`TeamChat`**：同一父节点雇来的同事共享群聊；父节点不读这条通道。
- **`TeamDM`**：按 agent id 找到三种关系——上级、同级、自己雇的成员。任务汇报（`completed` / `blocked` / `needs_decision`）走给上级的 DM。
- **`TeamStatus`**：除了自己的 `members`，还报告 `colleagues`（同事的角色、idle/running、任务、是否已向上级汇报）。`running` 的同事不该被抢活。
- 身份不靠复制 transcript。每个会话的 system prompt 注入 **`<session_self>`**（id、标题、深度、父节点、角色、职责、标签、直接成员）；挂载或身份变更时下一回合注入 **`<session_mount_changed>`** / **`<session_identity_changed>`**。

### 会话地图

会话靠 **`parent_session_id`** 连成森林。TUI 用 `/map` 浏览、打开、挂载、卸载；Nori Work / Web 侧栏有 **Map** 画布（平移、缩放、建子会话、改挂）。`/team` 管部门成员（打开伙伴会话、看汇报和本轮 Discuss）；`/map` 管挂载拓扑。二者不是同一件事。

---

## 2. 和其他工具比

下面按**现在公开能核对的能力**写，不按愿景写。Codex、Claude Code、Cursor 都是更成熟的单 Agent 编程循环；Nori 还早，赌注放在「长期部门 + 会前对齐」。

| | **Nori（现在）** | **OpenAI Codex CLI / Agent** | **Anthropic Claude Code** | **Cursor Agent**（简写） |
|---|---|---|---|---|
| **形态** | 终端 TUI + 本地 Web + Electron 桌面 | 终端 CLI，并接到 ChatGPT / IDE / 云端 Agent | 终端 CLI，并接到 IDE / 桌面 / 浏览器 | VS Code 系 AI IDE（编辑器才是主场） |
| **主循环** | 读/改文件、`Bash`、搜索；主 Agent 默认可读不可写 | 单 Agent 编码循环：文件、Shell、沙箱与审批 | 同左，工具面更完整 | 同左，再加 Tab 补全、可视化 diff、编辑器 LSP |
| **把活分出去** | **唯一路径：团队工程。** 雇持久子会话，先 Discuss 再 Assign | **Subagents**：按需拉起专职 Agent 并行干活，结果收回主线程；可用 TOML 自定义；CLI 用 `/agent` 切线程 | **Subagents**：独立上下文，可配工具 / 模型 / MCP；`.claude/agents/` | 内置 Explore / Bash / Browser 子 Agent；可用 worktree 并行 |
| **协作模型** | 站着的部门树 + 轮流可见的会。要防的是**沉默并行** | 主线程编排、子 Agent 做完交摘要。偏 fan-out | 主 Agent 协调、子 Agent 做事再合并。仍更接近 fan-out | 编辑器里的 Agent 线程；隔离多用 git worktree |
| **会话拓扑** | **一等公民**：挂载森林、`/map`、Web Map | 子 Agent 线程可打开检查，不是跨会话部门图 | 子 Agent / 后台 Agent 面板 | Agent 窗口 + worktree；不是 Nori 这种会话树 |
| **Git** | 毛坯：状态徽标 + REST 的 status/diff/commit/push；Agent 主要靠 `Bash` | 沙箱内 git-aware；产品级提交/PR 体验随 Codex App / ChatGPT 走 | **产品级**：stage、commit、branch、PR、`--worktree` | 可视化 diff、worktree、云端 Agent 走独立 checkout |
| **LSP** | 毛坯：有语言服务器发现、REST、检查器面板；**没有**进 Agent 工具循环 | 原生 LSP 仍在演进（诊断/定义等工具有公开设计与实现讨论） | **一等工具**：定义、引用、诊断，改码后可吃 LSP 反馈 | 编辑器自带 LSP，这是它的主场 |
| **权限 / 沙箱** | 工具审批 + Discuss 只读闸门；**文件系统沙箱仍是规划** | 本地沙箱 + 审批模式，子 Agent 继承 | 细粒度 allow/deny/ask；多种 permission mode | 编辑器权限 + 云端隔离 |
| **MCP / Skills** | 有（stdio / HTTP / SSE；Skills、Hooks、Plugins）——从上游继承，能用 | MCP、Skills、Plugins、`AGENTS.md` | MCP、Skills、Hooks、`CLAUDE.md` | MCP、Rules、Skills；市场与团队配置更完整 |
| **记忆** | Obsidian 兼容 vault（`nori_memory_search` / `nori_memory_write`） | Memories + `AGENTS.md` | `CLAUDE.md` / auto-memory | Rules + Memories |
| **模型** | 任意 OpenAI 兼容 Provider（本地或云） | 以 OpenAI / ChatGPT 计划为主 | 以 Claude 为主 | 多模型 |

### Nori 相对强在哪

- **长期伙伴，不是一次性工人。** `TeamCreate` 雇出来的是地图上的真实会话，能开会、能改挂、能解雇。Codex / Claude Code 的 subagent 很强，但默认是「拉起来、干完、把摘要交回主线程」。
- **会是为了对齐，不是为了收工。** Discuss 里后发言的人必须读到前面的话；Code 中途还能 `continue`。这是刻意和「各做各的，最后对账」对着干。
- **会话树是 UI，不只是内部实现。** `/team`、`/map`、Web Map、部门 Chat / Discuss 检查器是同一套挂载森林的不同面。
- **同事通道。** 同级用 `TeamChat` / `TeamDM` 交接文件边界，不必每件事都经过主席。

这些强项建立在一个仍很新的运行时上。它们还不是 Codex / Claude Code 那种打磨过的日常编码体验。

### 对方有、我们刻意不做或还没做的

Codex 和 Claude Code 仍然提供**打磨过的一次性 subagent fan-out**（并行探索、审查、收摘要）。Nori 在 v2 删掉了这条路径，因为两套委派和沉默并行是当时要关掉的失败模式。如果你要的是「主 Agent + 一堆用完即走的工人」，他们现在更合适。Nori 赌的是：复杂改动值得先开会。

---

## 3. 诚实的缺口

用户原话：LSP 和 Git 基本是「毛坯房」。对照代码和 `CHANGELOG.md` 之后，至少还有这些。

### LSP 和 Git（毛坯房）

- **LSP**：`LspService` 能拉起语言服务器，REST 上有 `status` / `request`（diagnostics、hover、definition、references、symbols、rename、format）。Nori Work 检查器里有一个按当前文件拉诊断和符号的面板。Agent **没有** Claude Code 那种 `LSP` 工具，改码循环也不会自动吃诊断。发现逻辑能找到常见语言服务器，但离「改完就能用类型信息纠错」还早。
- **Git**：文件树可以打 porcelain 状态；服务端有 `git status` / `diff` / `commit` / `push`。Web 客户端绑了这些 API，**提交和推送没有做成完整 UI**。没有 Claude Code 那种 stage → 写 message → 开 PR → worktree 的产品流。Agent 改仓库，今天主要还是 `Bash` 跑 git。

### 代码里核对过的其它缺口

- **TUI 测试债**（changelog 原文）：`apps/nori-code` 里约 66 个测试、25 个文件失败。一部分还在断言改名之前的 `kimi-code` 家目录、UA、命令名；一部分在断言注册表很久没再暴露的斜杠命令。数量从 68 降到 66，只是因为 SubAgent 自己的测试随功能一起删了。
- **已有 dual-write 会话会在加载时迁移：** 父会话里还挂着 team agent 的旧雇佣，会绑到（或物化成）子会话，再拆掉影子。新雇佣不再创建影子。
- **Kimi 命名残留**：TUI 协调器仍叫 `KimiTUI`；构建宏是 `__KIMI_CODE_*`；原生缓存目录仍能落到 `kimi-code`；文档站组件和不少 VitePress 页面还带着上游品牌与 SubAgent 说法。`pnpm check:brand` 管的是对外品牌漂移，不是一次清完所有内部标识。
- **Map 的 peer / service 边只在 localStorage**：父边以服务端 `parent_session_id` 为准。对等边、服务边、标注、钉住的位置写在 `nori-session-map-doc` 里，换浏览器或清站点数据就会丢。服务端图存储还没落地（见 `docs/adr/pre.1-session-node-graph.md`）。
- **`nori.yaml` 不是 DAG 调度器**：文件里有 `phases:`、步骤、甚至旧的 SubAgent 规则，但运行时真正读的是规则 prompt 注入，以及 review / memory / bug-hunt **闸门**（复杂度打分后往上下文里塞指令）。没有一个按 `depends_on` 跑节点的编排引擎。旧 README 把这份 YAML 写成「策略即代码的 DAG」，那是超售。
- **文件系统沙箱**：仍是规划。默认 system prompt 写明环境**不在沙箱里**，动作会立刻作用在用户机器上。
- **文档滞后**：VitePress 里仍有页面把 SubAgent 和 Team 写成并存，或把 DAG 当产品。根 README 以本节为准；站点最刺眼的几处会改掉或挂上指向这里的提示，整站不会在这次重写。

---

## 产品形态

| | Nori Code | Nori Work |
|---|---|---|
| **是什么** | 终端 CLI / TUI | Electron 桌面工作台 |
| **适合谁** | 终端优先 | 想把对话、文件、浏览器、终端放在一起 |
| **界面** | 分屏 TUI | 多面板桌面 |
| **启动** | `nori` | 独立安装包（见 [Releases](https://github.com/wangyuahn/nori-code/releases)） |

同一套会话也可以 `nori web` 开本地 Web。TUI 和 Nori Work 不要同时改**同一个会话**（挂载元数据和 transcript 会竞态）。

其它从上游带过来、现在仍能用的能力（不假装已经打磨完）：MCP、Agent Skills、Hooks、Plugins、Obsidian 风格记忆库、内嵌浏览器工具、Provider 配置、Cron、权限审批。

---

## 快速开始

```sh
npm install -g nori-code

# 交互式 TUI
nori

# 一次性 prompt
nori -p "你的任务"

# 本地 Web 工作台
nori web
```

需要 Node.js `>=24.15.0`（仓库 `engines`；`.npmrc` 开了 `engine-strict`）。首次进入项目目录后 `/login` 或 `/provider`。团队工作流见文档站 [团队工程](docs/zh/guides/team-engineering.md)。

Nori Work 提供**独立安装包**：[Releases](https://github.com/wangyuahn/nori-code/releases)。当前桌面标签是 **2.0.0**；**委派模型以 v2 changelog 和这份 README 为准**。

### 从源码运行

```sh
git clone https://github.com/wangyuahn/nori-code.git
cd nori-code
corepack enable
pnpm install

pnpm dev:cli       # 终端 TUI
pnpm dev:web       # Web UI
pnpm dev:desktop   # 桌面工作台
```

---

## 代码包

| 包 | 职责 |
|----|------|
| `apps/nori-code` | CLI / TUI 入口 |
| `apps/nori-web` | Web UI（桌面端也会加载） |
| `apps/nori-desktop` | Electron 桌面工作台 |
| `packages/agent-core` | Agent、Session、Team、工具、记忆与工作流闸门 |
| `packages/server` | REST / WebSocket（`/api/v1`） |
| `packages/kosong` | 模型 / Provider 抽象 |
| `packages/kaos` | 文件、进程、环境抽象 |
| `packages/node-sdk` | 公开 TypeScript SDK |
| `packages/oauth` | 认证与 Provider 注册 |

---

## 开发

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:brand    # 检查对外文案是否残留 Kimi 品牌
```

开发时先跑定点检查。根目录 `pnpm test` 目前不能当作绿灯：TUI 测试债见上面。

---

## 协议

MIT。基于 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)（MIT）fork。共享协议面保持必要的上游兼容；产品方向已经走到团队工程，而不是上游的临时 SubAgent 编排。
