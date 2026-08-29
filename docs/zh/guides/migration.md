# 从 kimi-cli 迁移

Nori Code 由 Kimi Code 分叉而来，自有 CLI（`nori`）、数据根目录（`~/.nori-code`），以及 2.0 **团队工程**模型。本页覆盖两类升级：从「单 Agent / 会话内 Team」心智迁到持久部门会话与会话地图；以及（针对更早安装）旧版 kimi-cli 数据与 Nori 主目录的关系。

## 升级到 2.0（团队工程）

Nori Code **1.x** 已在会话内使用 SubAgent 与协作工具。**2.0** 增加由**真实子会话**组成的部门树，以及**会话地图**。`~/.nori-code/sessions/` 下已有 transcript 可继续使用，会话地图**不需要**单独的数据格式迁移；改变的是团队工作的建模方式与导航入口。

### 心智模型

| 1.x 习惯 | 2.0 行为 |
| --- | --- |
| 把 Team 伙伴当作同一聊天里的旁注角色 | `TeamCreate` 雇佣由 `parent_session_id` 连接的**挂载子会话**（在地图上可见） |
| 期望伙伴共享负责人 transcript | 身份来自 **`<session_self>`** 与挂载变更通知——**不是**复制 transcript |
| 用一个斜杠命令当作「Team 主入口」 | **`/team`** 管部门成员（打开伙伴会话、汇报、Discuss 发言）；**`/map`** 管会话挂载 |
| 卸载与解散混用 | **`TeamDismiss`** 移除伙伴并**删除**其子会话；**`/map` 卸载**只清除父链接 |
| 默认认为主 Agent 可自由写代码 | 主 Agent 默认是**只读协调者**（拦截 `Write` / `Edit`）；成员在 `TeamAssign` 后执行。仅在需要负责人直接改文件时用 `/setting readonly off` |

典型 2.0 流程：`TeamCreate` → Discuss（`TeamDecide` / `TeamSpeak`）→ `TeamAssign`（进入 Code）→ 成员执行并汇报。详见[团队工程](./team-engineering.md)。

### 需要熟悉的命令与界面

- **`/team`**（别名 **`/agents`**）— 浏览并打开已雇佣伙伴；`/team settings` 设置最大部门深度
- **`/map`** — 浏览挂载森林；Enter 打开会话；**M** 挂载；**U** 卸载
- **Nori Work / Web Map** — 同一棵森林，支持平移/缩放与本地标注（不会发给模型）
- **`Ctrl-Y`** — 在 `/team` 打开成员会话时显示或隐藏 Discuss / Chat 栏

### 不变的部分

- 临时 **`SubAgent`** 仍用于归档在父会话下的有界任务——它们不是地图节点
- Discuss / Code 切换（`Shift-Tab`、`/discuss`、`/plan`）仍然适用；`TeamAssign` 成功时离开 Discuss
- 已在 `~/.nori-code/`（或 `$NORI_CODE_HOME`）下的配置与会话，升级后继续加载

::: tip 提示
当 TUI 与 Nori Work 共用主目录锁时，避免同时编辑**同一会话**——挂载元数据与 transcript 可能竞态。见[团队工程](./team-engineering.md#终端与桌面并存)。
:::

## 旧版 kimi-cli 数据

更早的 **kimi-cli**（Python/uv）把数据放在 `~/.kimi/`。Nori Code 的运行时数据在 **`~/.nori-code/`**（可用 **`NORI_CODE_HOME`** 覆盖）。两棵目录树互不覆盖。

仓库中仍保留私有包 `@nori-code/migration-legacy`，可将配置、MCP、输入历史、Skills 与选定会话从旧 kimi-cli 主目录复制到 Nori 数据根，且**不删除**源数据。当前 `nori` CLI **没有**注册交互式 `migrate` 子命令，因此本树中不存在受支持的一键 `nori migrate` / `kimi migrate` 入口。

若仍需要旧 kimi-cli 设置：

1. 安装 Nori Code（`npm install -g nori-code`）并运行 `nori`。
2. 用 `/login` 或 `/provider` 重新配置供应商——不要假定 kimi-cli 的 OAuth 与 MCP 授权会自动带过来。
3. 按需在 `~/.nori-code/` 下重新添加 MCP 与 Skills（见 [MCP](../customization/mcp.md) 与 [Agent Skills](../customization/skills.md)）。
4. 聊天历史可选；除非你已在其他工具路径下导入过会话，否则从新会话开始即可。

::: tip 提示
正常 CLI 启动不会修改或删除 `~/.kimi/`。在不再需要旧安装前可以保留它。
:::

## 下一步

- [团队工程](./team-engineering.md) — 部门树、Discuss/Assign、`/team` 与 `/map`
- [开始使用](./getting-started.md) — 安装 `nori` 与首次启动
- [会话与上下文](./sessions.md) — `state.json` 上的挂载元数据
- [数据路径](../configuration/data-locations.md) — `~/.nori-code` 目录布局
