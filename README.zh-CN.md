# Nori Code / Nori Work

> **一整个部门的 Agent —— 讨论、分配、执行、记住。**

Nori Code 是终端里的编程 Agent。Nori Work 是配套的 Electron 工作台。二者把项目当成一棵**真实会话组成的部门树**，而不是单条聊天加旁注。

雇佣持久伙伴。他们在**多轮 Discuss** 里发言（每轮一条短 `TeamSpeak`，再用 `action=continue`）。`TeamAssign` 进入 Code。**会话地图**是会话控制台：打开、停止、挂载、改身份。

[English](README.md) · [开始使用](docs/zh/guides/getting-started.md) · [团队工程](docs/zh/guides/team-engineering.md)

![Nori Work 对话工作区](docs/images/nori-work-overview.png)

![Nori Work 浏览器工作区](docs/images/nori-work-browser.png)

---

## 产品形态

| | Nori Code | Nori Work |
|---|---|---|
| **定位** | 终端 CLI / TUI | Electron 桌面工作台 |
| **适合谁** | 终端里的会话 | 对话、文件、Git、终端、浏览器和 Map 在同一屏 |
| **启动** | `nori` | [Releases](https://github.com/wangyuahn/nori-code/releases) 安装包，或 `nori web` 打开浏览器工作台 |

npm 包名是 `nori-code`，可执行文件是 `nori`。已发布 CLI 需要 **Node.js ≥ 22.19.0**。开发本仓库需要 **Node.js ≥ 24.15.0** 和 **pnpm 10.33.0**。

---

## 工作怎么走

1. **`TeamCreate`** — 雇佣伙伴。每次雇佣是一个**挂载子会话**（地图上的卡片），并双写团队 Agent，以便 Discuss 仍按本部门寻址。
2. **`TeamDecide action=start`** — 开启 Discuss。成员按顺序 **`TeamSpeak`**：一个观点、一个分歧、或一个具体建议。禁止一轮把问题想完。用 **`action=continue`** 开下一轮。本轮不发言记为弃权，后面的人照常发言。Discuss 期间 `Write` / `Edit` / `Bash` 被拦截。
3. **`TeamAssign`** — 按文件边界分配任务。成功后**离开 Discuss** 进入 Code。
4. **Code** — 成员执行。`TeamChat` 是同伴之间的工作流量；`TeamDM` 是一对一（包括向父级汇报：`completed` / `blocked` / `needs_decision`）。
5. **地图** — 还是这些会话。单击选中、打开聊天、强制停止、新建子会话、改名称/角色/职责/标签、拆挂或删除。框选可批量操作。

主 Agent 默认是**只读协调者**（`/setting readonly on`）。成员执行分配任务。只有在你希望负责人直接改文件时才 `/setting readonly off`。

**SubAgent** 是另一套模型：归档在父会话下的临时代理，不是地图节点，也不适合当长期部门。

`TeamDismiss` 会删除被雇佣的子会话。地图上拆挂只去掉父链接。

---

## 界面

| 入口 | 用途 |
|---|---|
| `nori` | 在项目目录里开交互 TUI |
| `/team`（别名 `/agents`） | 打开伙伴会话、汇报、本轮 Discuss 发言、最大部门深度 |
| `/map` | 挂载森林：打开、挂载、拆挂 |
| `Shift-Tab` / `/discuss` | 切换 Discuss / Code（`/plan` 是兼容别名） |
| `Ctrl-Y` | 显示或隐藏 Discuss / Chat 栏 |
| `nori web` | 把当前会话交给浏览器工作台 |
| Nori Work **Map** | 平移/缩放控制台：创建、接线、停止、设置、筛选、框选 |

身份是 **`<session_self>`** 加上挂载/身份变更通知。伙伴**不会**复制负责人的 transcript。

---

## 一并带上的能力

- **记忆** — Obsidian 兼容的 Vault（`nori_memory_search` / `nori_memory_write`），`[[wiki-links]]`、反向链接，Nori Work 里有图谱。
- **`nori.yaml`** — 项目阶段、Vault 路径、强制规则（例如进入实现前先搜记忆）。
- **供应商** — 兼容 OpenAI 的云端或本地（Ollama、LM Studio）。用 `/login` 或 `/provider` 配置。
- **Browser 工具** — 导航、快照、点击、输入、截图。允许本地 `.html` / `.htm`，不允许任意 `file://`。没有打开页面时操作立即失败。
- **LSP** — 有语言服务器时提供诊断与跳转。

---

## 快速开始

```sh
npm install -g nori-code
# 或：pnpm add -g nori-code

cd your-project
nori
```

第一次启动：`/login` 或 `/provider`，再 `/model`。可以先试：

```
看一下这个项目，解释主要目录做什么。
```

非交互：

```sh
nori -p "你的任务"
nori -c                 # 恢复上一会话
nori web                # 浏览器工作台
nori upgrade            # 升级 CLI
```

Nori Work 桌面安装包：[Releases](https://github.com/wangyuahn/nori-code/releases)。

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

## 文档

| 主题 | English | 中文 |
|---|---|---|
| 安装与第一次启动 | [Getting started](docs/en/guides/getting-started.md) | [开始使用](docs/zh/guides/getting-started.md) |
| 部门树、Discuss、地图 | [Team engineering](docs/en/guides/team-engineering.md) | [团队工程](docs/zh/guides/team-engineering.md) |
| 1.x → 2.0 | [Migration](docs/en/guides/migration.md) | [迁移](docs/zh/guides/migration.md) |
| 内置工具 | [Tools](docs/en/reference/tools.md) | [工具](docs/zh/reference/tools.md) |

---

## 仓库地图

| 路径 | 职责 |
|---|---|
| `apps/nori-code` | CLI / TUI（`nori`） |
| `apps/nori-web` | Web UI（桌面端与 `nori web`） |
| `apps/nori-desktop` | Electron 工作台 |
| `packages/agent-core` | Agent、Session、Team、工具 |
| `packages/server` | REST + WebSocket（`/api/v1`） |
| `packages/kosong` | 模型 / 供应商层 |
| `packages/kaos` | 文件、进程、环境 |
| `packages/node-sdk` | 公开 TypeScript SDK |
| `packages/oauth` | 认证 |

---

## 开发

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:brand    # 检查是否残留 Kimi 品牌标识
```

先跑你改过的包，合并前再跑根目录命令。

---

## 协议

MIT。从 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)（MIT）fork。Nori 只保留仍需要的共享协议面，部门树运行时、会话地图、记忆库、桌面工作台和品牌是自己的。
