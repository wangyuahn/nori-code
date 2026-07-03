# Nori Code

> Loop-core 多智能体编码工具 — 规划、分发、审查、循环。

Nori Code 是一个通过 plan → implement → review 循环编排工作的 AI 编码智能体。它不自己写代码，而是作为只读编排器，将所有代码变更委派给并行 swarm 子智能体，并以 Obsidian 风格的共享记忆库作为知识底座。

基于 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)（MIT 协议）构建，新增混合规则引擎、阶段式工作流强制执行、自定义用户规则和深度 swarm 集成。

---

## 工作方式

```
用户: "写一个登录系统"

  plan (混合模式)         → 搜索 Obsidian 记忆库 → 分析 → 撰写计划
     ↓
  implement (自主模式)    → nori_swarm_launch → Coder 子智能体写代码
     ↓                          ↓
   (自定义规则强制执行)     ask_parent ←→ 编排器指导
     ↓
  review (规则强制模式)    → 自动测试 + lint + swarm 审查 DAG
     ↓
  完成                    → 审查记录写入 Obsidian 记忆库
```

编排器**只读** — 它规划、搜索记忆、分发任务。所有 Write/Edit/Bash 操作通过 swarm 子智能体完成。

---

## 核心特性

**Loop-core 编排** — plan → implement → review 三阶段，每阶段可配置模式（规则强制 / 混合 / 自主）。Goal 模式自动驱动 turns 穿越所有阶段。

**自定义规则引擎** — 在 `nori.yaml` 中定义规则，按阶段入口/出口或工具调用触发。4 种条件类型：`always`、`on_phase`、`on_tool`、`on_event`。以系统提示形式注入。`/setting rules` 查看/编辑。

**共享 Obsidian 记忆** — Markdown 记忆库位于 `~/.nori-code/vault/`，支持 `[[双向链接]]`。`nori_memory_search` 查询记忆库。`nori_memory_write` 记录决策/分析/审查。笔记规则在阶段边界强制执行。

**Agent Swarm** — 基于 DAG 的并行任务执行，支持依赖链和可配置递归深度（`/settings → Swarm Depth`）。`nori_swarm_launch` 生成 coder/test/review 子代理。`nori_ask_parent` 让子代理向编排器请求指导。

**只读编排器** — 主代理不能直接写代码。必须通过 `nori_swarm_launch` 或 `nori_plan_write`（文档）委派。可通过 `/settings → Read-only Mode` 切换。

**Review Gate 评分** — TurnFlow 追踪每轮活动（文件变更、swarm 调用、shell 命令）并评分 0–10。超过阈值触发强制/建议审查。`/settings → Workflow` 配置阈值。

**编码后强制审查** — review 阶段自动运行测试、lint、类型检查，然后启动 swarm 审查 DAG。

**工具提示** — 出错时系统分类失败类型（编译/测试/类型/运行时/网络/超时）并建议恢复工具。模型自主决定修复策略。

**集中化 `/settings`** — 模型、权限、主题、编辑器、swarm 深度、coder 写入、笔记规则、只读模式、workflow 阈值。统一 GUI 选择器。

---

## 快速开始

```sh
# 全局安装
npm install -g nori-code

# 启动交互式 TUI
nori

# 单任务模式
nori -p "任务描述"

# 自动审批模式
nori --permission auto
```

要求：Node.js ≥ 24.15.0。

安装后配置模型：

```sh
nori
# 进入 TUI:
/provider    # 添加你的 API key（OpenAI、Anthropic、DeepSeek 等）
/model       # 选择模型
```

### 从源码构建

```sh
git clone https://github.com/wangyuahn/nori-code.git
cd nori-code
pnpm install
pnpm -C apps/nori-code run build
node apps/nori-code/dist/main.mjs
```

---

## 配置 (`nori.yaml`)

将 `nori.yaml` 放在项目根目录。若无此文件，使用合理默认值（默认记忆库 `~/.nori-code/vault/`）。

```yaml
phases:
  - name: plan
    mode: hybrid
    hybrid:
      retrieval_gate:
        trigger: { mode: on_keywords }
        max_results: 10
  - name: implement
    mode: llm-autonomous
    llm_autonomous:
      max_iterations: 50
  - name: review
    mode: rule-enforced
    rule_enforced:
      steps:
        - type: exec
          id: run_tests
          command: "npm test"
        - type: exec
          id: lint
          command: "eslint src/"

workflow:
  review:
    suggestion_threshold: 4
    required_threshold: 7
    max_gate_continuations: 2

rules:
  definitions:
    - name: search_before_code
      condition: { type: on_phase, phase: implement, stage: entry }
      prompt: "编码前搜索 Obsidian 记忆库中的历史决策"
      enforced: true
      editable: true
    - name: require_plan_document
      condition: { type: on_phase, phase: plan, stage: exit }
      prompt: "离开计划阶段前撰写规划文档"
      enforced: true
      editable: false

swarm:
  max_concurrency: 4
  max_swarm_depth: 3
  checks:
    - id: type_check
      agent_type: coder
      on_failure: fix_and_retry
    - id: test_check
      agent_type: coder
      depends_on: [type_check]
      on_failure: block
```

阶段模式：
- **rule-enforced（规则强制）** — 确定性步骤，无 LLM 参与（测试、lint、构建）
- **hybrid（混合）** — 强制检索门控：模型声明关键词 → 系统搜索记忆库 → 结果注入 → 模型继续
- **llm-autonomous（自主）** — 模型自主规划和分发，自定义规则仍然强制执行

---

## 命令

| 命令 | 操作 |
|------|------|
| `/settings` | 打开设置面板（12个选项：模型、权限、主题、编辑器、实验、更新、用量、coder 写入、swarm 深度、笔记规则、只读模式、workflow） |
| `/settings auto` | 交互式配置向导（6 步引导） |
| `/settings permission auto\|yolo\|manual` | 设置权限模式 |
| `/setting rules` | 查看/编辑自定义规则 |
| `/setting note` | 切换强制笔记规则（分析/决策/模式） |
| `/provider` | 配置第三方模型提供商 |

## 记忆工具

| 工具 | 描述 |
|------|------|
| `nori_memory_search` | 关键词查询记忆库。返回 embedding + 全文 + 链接图加权排序结果 |
| `nori_memory_write` | 写入笔记到记忆库。使用 `[[wiki-links]]` 双向链接 |
| `nori_plan_write` | 写计划文档到项目工作区（docs/plans/）。不受只读模式限制 |

## Swarm 工具

| 工具 | 描述 |
|------|------|
| `nori_swarm_launch` | 启动基于 DAG 的并行子代理（coder/test/review） |
| `nori_swarm_status` | 检查运行中的 swarm 进度 |
| `nori_swarm_result` | 获取 swarm 结果 |
| `nori_ask_parent` | （仅子代理）向父编排器请求指导 |

---

## 开发

```sh
pnpm install
pnpm -C apps/nori-code run dev    # 开发模式，热重载
pnpm -C apps/nori-code run build  # 生产构建
pnpm test                          # 运行测试
```

---

## 协议

MIT。基于 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)。
