# Nori Code

> 面向规划、实现、审查和项目长期知识的多智能体编程工作区。

[English](README.md)

![Nori Work](docs/images/nori-work.png)

Nori 提供两个相互连通的使用界面：

- **Nori Code**：适合专注编程流程的命令行 CLI/TUI。
- **Nori Work**：覆盖会话、文件、Git、知识库、用量和 Agent Swarm 活动的 Electron 桌面工作台。

Nori 基于 MIT 协议的 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) 开发。在保留必要上游兼容性的同时，增加了 Nori 自己的工作流、记忆、桌面端和多智能体能力。

## 主要功能

- **Plan 与 Code 模式**：Plan 模式始终只读；Code 模式可选择是否允许主 Agent 使用 Edit 和 Write，小任务不必强制启动 Swarm。
- **Agent 后台执行**：Agent Swarm 和普通子 Agent 在后台继续工作，主 Agent 可以同时处理其他内容；完成结果会重新注入父级上下文。
- **智能体调用树**：Nori Work 按顶层 Swarm 轮次分组，并将 Agent 调用的子 Agent 显示在调用者节点下。每个 Agent 都可以查看实时输出、Markdown 结果、状态和 Token 总量。
- **流式会话**：推理、工具调用和 Markdown 回答原位更新；工具卡片显示在实际调用位置，而不是统一堆到回答底部。
- **第三方模型接入**：可设置 API 格式、Base URL 和 Key，支持内置及兼容的第三方 Provider。模型列表与可用思考强度从 Provider 获取，在发送框旁选择。
- **多模态输入**：支持上传文件；当所选模型支持视觉能力时可以发送图片。
- **按项目管理会话**：会话按项目文件夹分组，可折叠、归档、恢复和删除；归档会话也按项目组织。
- **工作区检查器**：浏览项目文件和 Git 状态，语法高亮预览源码，渲染 Markdown，查看 Agent 最新代码改动，并使用 Git diff、提交和发布功能。
- **项目知识库**：Markdown 笔记支持 `[[双向链接]]`、搜索、删除以及可缩放、可拖动、可点击的链接图。
- **用量可视化**：显示单条输出用量、Agent 总量、会话总量和上下文占用比例；初始页提供整体用量概览。
- **权限模式**：Manual 对全部操作逐项询问；Auto 按策略自动允许普通操作；Yolo 不再询问并允许全部操作。

## 快速开始

环境要求：Node.js `>=24.15.0`。

```sh
npm install -g nori-code

# 启动交互式终端界面
nori

# 单次任务
nori -p "你的任务"

# 启动本地 Web 工作台
nori web
```

在 TUI 中使用 `/provider` 配置 Provider，使用 `/model` 选择模型。Nori Work 在设置页提供同一套 Provider 配置，并在聊天发送框中选择模型。

### 从源码运行

```sh
git clone https://github.com/wangyuahn/nori-code.git
cd nori-code
corepack enable
pnpm install

pnpm dev:cli
pnpm dev:web
pnpm dev:desktop
```

构建 Windows 桌面安装包：

```sh
pnpm --filter @nori-code/nori-web build
pnpm -C apps/nori-code build:native:sea
pnpm -C apps/nori-code test:native:smoke
pnpm --filter @nori-code/nori-work dist
```

安装包输出到 `apps/nori-desktop/dist-app/`。

## 工作流程

Nori 可以把模型驱动的工作与确定性的项目策略组合起来：

```text
用户请求 -> 规划 -> 实现 -> 验证 -> 审查 -> 总结
             |       |
             |       +-> 后台 Agent Swarm / 子 Agent
             +-> 项目记忆与规则
```

项目根目录中可选的 `nori.yaml` 用于配置阶段、规则、审查阈值和 Swarm 执行；没有该文件时使用运行时默认值。

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

当前配置事实来源是 `packages/agent-core` 中的运行时实现。无效配置或涉及安全的配置不应静默回退到更宽松的权限。

## 工具

### 记忆工具

| 工具 | 用途 |
| --- | --- |
| `nori_memory_search` | 按文本、元数据和链接关系搜索 Markdown 笔记 |
| `nori_memory_write` | 创建或更新项目笔记，可写入 `[[双向链接]]` |
| `nori_memory_remove` | 将匹配笔记移动到知识库的 `.trash` 目录 |
| `nori_plan_write` | 在项目工作区写入规划文档 |

### Agent Swarm 工具

| 工具 | 用途 |
| --- | --- |
| `nori_swarm_launch` | 启动支持依赖关系的后台 Agent 组 |
| `nori_swarm_status` | 查看运行中 Swarm 的实时状态 |
| `nori_swarm_result` | 获取已完成的 Swarm 结果 |
| `nori_ask_parent` | 子 Agent 向父 Agent 请求指导 |

## 开发与验证

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:brand
```

开发时优先运行受影响包的定点检查，提交前再按改动范围扩大验证。

## 协议

MIT。项目基于同样使用 MIT 协议的 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)。
