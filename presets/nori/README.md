# Nori 三大系统 → DeepSeek Harness 插件

把 nori-code 的三套能力移植为 DeepSeek Harness（DSH）插件：

| 包 | 内容 | 已验证 |
|---|---|---|
| `@nori-code/dsh-nori-memory` | Obsidian vault 共享记忆：两段式写入、全文+图谱评分、链式多跳检索（`chain_depth`/`follow_up_keywords`）、`.trash` 回收站；`registerContinuableSetup` 让每个 continuable 子代理自动获得记忆工具；`nori-core.memory.preRetrieve` 供 spawn 前预检索（消除 nori 的 Phase-0 额外 LLM 往返） | 动态原型验收 + 11 项行为测试 |
| `@nori-code/dsh-nori-loop` | 规则引擎（`always/on_phase/on_tool/on_event` + stage）+ discussion/implementation/review 相位机（从会话日志折叠）+ `agent/pre-step` 注入为 plugin-source notice 消息（聊天/轨迹可见）+ `nori_rule_control` per-agent/rule 暂停 | 动态原型验收（T1–T7）+ 8 项行为测试 |

## 目录结构

```
nori-workspace/packages/dsh-nori-{memory,loop}/
  src/index.ts        # host half（export { name, apply }）
  src/types.dsh.ts    # 自声明的 DSH 最小契约面（零 @deepseek-ai 运行时依赖）
  src/{vault,rule-engine,dag}.ts  # 纯逻辑（行为测试对象）
  test/*.test.ts      # vitest 行为测试（27 项）
  tsdown.config.ts    # tsdown 构建 → lib/（postbuild 复制 .mjs→.js 以符合 DSH 约定）
nori-workspace/presets/nori/
  agent.cordis.yml    # 用户预设组合（基于 shipped code 预设 + 三插件行）
  preset.yml
```

## 构建与测试

```powershell
pnpm -C nori-workspace install
pnpm -C nori-workspace --filter @nori-code/dsh-nori-memory run typecheck
pnpm -C nori-workspace --filter @nori-code/dsh-nori-memory exec vitest run
pnpm -C nori-workspace --filter @nori-code/dsh-nori-memory run build
# 对 loop 同理
```

构建产物：`lib/index.js`、`lib/index.d.ts`。

## 安装进你的 DSH 部署

1. **打包**（在 nori-workspace 内）：
   ```powershell
   pnpm --filter @nori-code/dsh-nori-memory pack --pack-destination ../dist-tarballs
   pnpm --filter @nori-code/dsh-nori-loop pack --pack-destination ../dist-tarballs
   ```
2. **安装进部署**（在你的 DSH 部署目录，即包含 cordis.yml / agent-presets 的安装根）：
   ```powershell
   pnpm add <path-to>/@nori-code-dsh-nori-memory-0.1.0.tgz
   pnpm add <path-to>/@nori-code-dsh-nori-loop-0.1.0.tgz
   ```
3. **落预设**：把 `nori-workspace/presets/nori/` 复制到用户预设根
   `~/.dsh/.agent-presets/nori/`（或以 `agentPresets.copy('code','nori')` 复制后再替换
   `agent.cordis.yml` 内容；**绝不修改 shipped 预设本身**）。
4. **挂载校验**：`agentPresets.standingKeyFor('nori')` 应正常返回。
5. **真实会话冒烟**：用 `nori` 预设开新会话，确认工具清单含
  `nori_memory_*`、`nori_rule_control`、`SubAgent`、
   `send_message`/`interrupt_agent`；会话头出现 `Agents` 按钮，面板可开合。

## 配置：`nori-harness.json`（workspace 根）

```jsonc
{
  "memory":  { "vaultPath": "./nori-vault", "topK": 10, "maxChainDepth": 3 },
  "phases":  ["plan", "implement", "review"],
  "agents":  { "coder": { "purpose": "…", "model": null, "persona": null,
                "permissions": { "read": true, "write": true, "shell": true,
                                 "web": false, "delegate": false, "converse": false } },
               "reviewer": { "permissions": { "read": true, "converse": false, "delegate": false } } },
  "rules":   { "definitions": [ { "name": "search_before_code",
                "condition": { "type": "on_phase", "phase": "implement", "stage": "enter" },
                "prompt": "…", "enforced": true, "targets": ["main"] } ] },
}
```

- `permissions` 组映射到 DSH 工具：`read→read/grep/glob/nori_memory_search`、
  `write→write/edit/nori_memory_write/remove`、`shell→pwsh/bash`、`web→web_search/web_fetch`、
  `delegate→SubAgent`、
  `converse→send_message/interrupt_agent/ask_user_question/list_agents`。
  组值为 `false` 时通过 `toolFilter.deny` 从子代理同时剥离可见性与执行权。
- `rules.targets`：`"main"`（仅主代理）/ `"subagent"` / `"agent_type:<type>"`（按代理注册表类型）。
- 名字注册表持久化在 `<workspace>/.nori-agents.json`，重启后按注册表恢复。

## 设计原则（复用 DSH 原生通道，零重复实现）

- **注入**：`always` 规则 → `systemPrompt.section`（请求头/轨迹 prompt 检查可见）；
  边界规则 → `agent/pre-step` 追加 plugin-source（`form:'notice'`）消息 = durable
  `user/message`，聊天与轨迹原生渲染为 context 节点。
- **唤醒**：相位转换、SubAgent 或 graph-check 完成通知走 shipped 的 settlement notice / steering 通道，不另造消息总线。
- **不发明 session 事件类型**：`KNOWN_SESSION_EVENT_TYPES` 是部署构建期生成的封闭目录，
  外置插件事件无法被持久化读取识别；全部可见性复用 user/message、tool/call、
  `subagent/*` 等既有词汇。
- **子代理对话/暂停**：直接复用 `send_message`（多轮推敲）、`interrupt_agent`（暂停），
  本仓库不重复注册这些工具。
- **面板 RPC**：动态运行走 `harness.handle`/`host.call`；部署包走 `webServer.register`
  的 `/__nori-panel/*` 路由（client 自动回退）。

## 本机部署（已执行）

本机的 DSH 部署采用 web profile 结构（`~/.dsh/profiles/web/`），已完成以下安装：

1. 两个包装入 `~/.dsh/local-plugins/dsh-nori-{memory,loop}/`（package.json + `lib/` 构建产物 + 空 `cordis.patch.yml`，行由预设提供）；
2. `~/.dsh/profiles/web/package.json`：`dependencies` 增加三个 `link:` 条目，`dsh.profile.bundles` 增加三个 `@nori-code/*` bundle；
3. 用户预设落盘 `~/.dsh/.agent-presets/nori/`（`agent.cordis.yml` + `preset.yml`）。

挂载校验（`agentPresets.standingKeyFor('nori')`）已迭代修复：fs-search config、Discuss section、
nori-core 服务归属（memory 唯一提供，loop/graph-check 通过 `inject: ['nori-core']` 消费）。
当前进程首次校验已缓存旧模块（标记探针证实 loader 不重新 import），因此**最终校验需重启 DSH
应用**：重启后以 `nori` 预设新建会话，确认工具清单与 `Agents` 面板即可。

## 尚未验证（部署侧）

- 重启后的最终 `standingKeyFor` / 真实会话冒烟（重启后执行）。
- `WebRoute.kind` 的取值（包内按 `'exact'` 传递，部署端验证）。
