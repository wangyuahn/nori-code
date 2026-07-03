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

**Loop-core 编排** — plan → implement → review 三阶段，每阶段可配置模式（规则强制 / 混合 / 自主）。

**自定义规则引擎** — 在 `nori.yaml` 中定义规则，按阶段入口/出口或工具调用触发。以系统提示形式注入，完全可编辑。

**共享 Obsidian 记忆** — Markdown 记忆库，支持 `[[双向链接]]`。智能体编码前搜索、决策后记录。子智能体继承记忆库访问权。

**Agent Swarm** — 基于 DAG 的并行任务执行，支持依赖链和可配置递归深度。

**只读编排器** — 主智能体不能直接写代码，必须通过 `nori_swarm_launch` 委派。可通过 `/settings` 切换。

**编码后强制审查** — review 阶段自动运行测试、lint、类型检查，然后启动 swarm 审查 DAG。

**工具提示** — 出错时系统分类失败类型并建议恢复工具，模型自主决定修复策略。

**集中化 `/settings`** — 所有配置在一个 GUI 选择器中管理：模型、权限、主题、swarm 深度、coder 写入、笔记规则。

---

## 快速开始

```sh
# 从源码构建
git clone <仓库地址>
cd nori-code
pnpm install
pnpm -C apps/kimi-code run build

# 启动交互式 TUI
node apps/kimi-code/dist/main.mjs

# 单任务模式
node apps/kimi-code/dist/main.mjs -p "解释这个项目结构"

# 自动审批模式
node apps/kimi-code/dist/main.mjs --permission auto
```

要求：Node.js ≥ 24.15.0, pnpm。

---

## 配置 (`nori.yaml`)

```yaml
phases:
  - name: plan
    mode: hybrid            # rule-enforced | hybrid | llm-autonomous
  - name: implement
    mode: llm-autonomous
  - name: review
    mode: rule-enforced

rules:
  definitions:
    - name: search_before_code
      condition: { type: on_phase, phase: implement, stage: entry }
      prompt: "编码前搜索 Obsidian 记忆库中的历史决策。"
      enforced: true
      editable: true
```

阶段模式：
- **rule-enforced（规则强制）** — 确定性步骤，无 LLM 参与（测试、lint、构建）
- **hybrid（混合）** — 强制检索门控：模型声明关键词 → 系统搜索记忆库 → 结果注入 → 模型继续
- **llm-autonomous（自主）** — 模型自主规划和分发，自定义规则仍然强制执行

---

## 命令

| 命令 | 操作 |
|------|------|
| `/settings` | 打开设置面板（模型、权限、主题、swarm 深度、coder 写入、笔记规则） |
| `/settings permission auto\|yolo\|manual` | 设置权限模式 |
| `/setting rules` | 查看自定义规则 |
| `/provider` | 配置第三方模型提供商 |

---

## 开发

```sh
pnpm install
pnpm -C apps/kimi-code run dev    # 开发模式，热重载
pnpm -C apps/kimi-code run build  # 生产构建
pnpm test                          # 运行测试
```

---

## 协议

MIT。基于 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)。
