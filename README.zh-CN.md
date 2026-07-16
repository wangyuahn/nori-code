# Nori Code / Nori Work

> **多智能体编程工作区 —— 分解、分发、验证、记忆。**

Nori 编排多个 AI Agent 协同完成代码的规划、实现、审查和跨会话知识持久化。不是一个聊天的代码工具，而是一个**多 Agent 工程工作台**。

[English](README.md)

![Nori Work](docs/images/nori-work.png)

---

## 产品形态

| | Nori Code | Nori Work |
|---|---|---|
| **定位** | 终端 CLI/TUI | Electron 桌面工作台 |
| **适合谁** | 终端重度用户 | 桌面 IDE 偏好者 |
| **界面** | Ink 分屏 TUI | 多面板 Electron 桌面 |
| **启动** | `nori` | 独立安装包（见 releases） |

---

## 为什么是 Nori

大多数 AI 编程工具是**单 Agent 聊天壳** —— 一个模型、一个上下文、一问一答。Nori 不一样：

- **并行而非串行。** 复杂任务拆解为 DAG 结构的 Agent 工作流 —— 规划 → 实现 → 验证 → 审查 —— 带依赖调度的并行执行。
- **记忆而非失忆。** 架构决策、代码审查、设计模式持久化到双向链接记忆库。上个月学到的东西，下个会话还能用。
- **策略而非猜测。** `nori.yaml` 强制执行确定性规则：编码前搜索记忆、退出前跑测试、合并前审查。AI 的灵活性加上项目级的纪律约束。
- **桌面而非浏览器标签。** Nori Work 是基于 Electron 的原生桌面工作台。

---

## 核心能力

### 🧠 多 Agent DAG 编排
AgentSwarm 将任务拆解为带显式依赖链的并行子 Agent。多文件重构自动派发 `{ 规划, 实现-1, 实现-2, 验证, 审查 }` 并行工作，无需手动一问一答。

### 📚 持久项目记忆
每个决策、审查和模式都写入 Obsidian 兼容的 `[[双向链接]]` 记忆库。规划阶段自动检索历史上下文。Nori 会随着时间推移越来越了解**你的项目**。

### ⚙️ 策略即代码 (`nori.yaml`)
将项目规则编码为 Agent 循环自动执行：
```yaml
rules:
  - name: search_before_code
    condition: { on_phase: implement, stage: enter }
    prompt: "搜索记忆库，查找已有决策和模式。"
    enforced: true
```
编排器、编码器和审查器可各自使用不同的模型/Provider。

### 🔌 Provider 灵活接入
接入任何兼容 OpenAI 接口的 Provider —— 本地（Ollama、LM Studio）或云端。每个 Agent 角色（编排器/编码器/审查器）可使用不同模型。

### 🖥️ Nori Work 工程工作台
Nori Work 将对话、项目文件、实时代码更改、Git 操作、LSP 结果和持久 PTY 终端放在同一个可调整大小的桌面布局中。右侧检查器工具可以调整顺序，也可以单独打开为独立窗口。用户可创建自定义 Agent 角色，并分别配置角色说明以及读取、写入、终端、联网和委派权限。

Agent 与 AgentSwarm 始终在后台执行。主模型可以查询、暂停、插入指令、恢复或终止 Swarm；智能体协作页面按项目和会话展示调用树、状态、输出与 token 用量。

---

## 开发路线

| 优先级 | 功能 | 状态 |
|--------|------|------|
| P0 | **内置 LSP** — 诊断、悬浮信息、定义、引用、符号、重命名和格式化 | ✅ 已实现 |
| P0 | **自定义 Agent 配置** — 自定义角色、Prompt、基础 Profile 与工具权限 | ✅ 已实现 |
| P0 | **Nori Work — 内嵌终端**（持久 node-pty 会话） | ✅ 已实现 |
| P0 | **Nori Work — 内嵌浏览器**（用于研究与预览的 WebContentsView 标签页） | 🚧 开发中 |
| P0 | **Nori Work — 文件系统沙箱**（白名单 + 黑名单） | 📝 规划中 |
| P0 | **Nori Work — 系统托盘 / 通知** | ✅ 已实现 |
| P0 | **Nori Work — 安全 Preload 桥接** | ✅ 已实现 |
| P1 | **Agent 内置浏览器** — 无头浏览器渲染页面、截图、JS 评估 | 📝 规划中 |

---

## 快速开始

```sh
npm install -g nori-code

# 交互式 TUI
nori

# 单次任务
nori -p "你的任务"

# 启动本地 Web 工作台
nori web
```

Nori Work 桌面版为**独立安装包**，详见 [latest release](https://github.com/wangyuahn/nori-code/releases)。

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
| `apps/nori-code` | CLI/TUI 入口 |
| `apps/nori-web` | Web UI（桌面端加载） |
| `apps/nori-desktop` | Electron 桌面工作台 |
| `packages/agent-core` | Agent、Session、Swarm、Tool、Workflow 引擎 |
| `packages/server` | REST/WebSocket 服务 |
| `packages/kosong` | 模型/Provider 抽象层 |
| `packages/kaos` | 文件、进程、环境抽象 |
| `packages/node-sdk` | 公开 TypeScript SDK |
| `packages/oauth` | 认证与 Provider 注册 |

---

## 开发与验证

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:brand    # 检查是否残留 Kimi 品牌标识
```

开发时先跑定点检查，提交前扩大到全量验证。

---

## 协议

MIT。本项目基于 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)（MIT 协议）fork 并发展出自己的架构：多 Agent DAG 编排、持久记忆、桌面环境、策略引擎和独立品牌。在共享协议层面保持必要的上游兼容性。
