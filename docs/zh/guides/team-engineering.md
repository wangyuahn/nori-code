# 团队工程

Nori Code CLI 2.0 把项目当作一棵由真实「会话」组成的**部门树**，而不是单条聊天记录加旁注。每位雇佣伙伴拥有独立会话，Discuss 轮次在动手前收集团队发言，**会话地图**则展示会话之间的挂载关系。本页说明终端与 Nori Work 中这些能力如何配合。

## 部门树与 SubAgent

两种协作模型并存：

- **团队伙伴**（`TeamCreate`）是通过 `parent_session_id` 挂载在父会话下的**持久子会话**。它们保留自己的 transcript、Discuss/Assign 流程，以及地图上的节点，直到 `TeamDismiss` 删除。
- **SubAgent**（`SubAgent`）是归档在父会话目录内的**临时代理**，完成有界任务后返回结果；不是地图节点，也不适合作为长期部门。

主 Agent 默认是**只读协调者**：直接 `Write` / `Edit` 会被拦截（`/setting readonly on`），雇佣成员在 `TeamAssign` 离开 Discuss 后执行分配任务。只有在你希望负责人直接改文件时才使用 `/setting readonly off`。

## Discuss 与 Code

**Discuss** 是只读团队会议。开启期间，`Write`、`Edit`、`Bash`、`SubAgent` 及部分调度工具会被拦截，直到团队进入 **Code**。

典型流程：

1. **`TeamCreate`** — 在本部门雇佣伙伴（每人成为挂载的子会话）。
2. **`TeamDecide`**，`action=start` — 以主题开启 Discuss；成员用 **`TeamSpeak`** 发言（本轮不调用会记为弃权）。
3. **`TeamAssign`** — 分配具体任务；成功后**离开 Discuss** 进入 Code，成员可以执行。
4. 工作完成后 **`TeamDecide`**，`action=vote` — 全队投票（`discuss_again` / `proceed` / `abstain`），无需再次进入完整 Discuss。

在 UI 中用 **`Shift-Tab`**、**`/discuss`** 或兼容别名 **`/plan`** 切换 Discuss。**`TeamAssign`** 与 Discuss/Code 切换都可以离开 Discuss；YOLO 不会额外增加退出审批。

审批行为见[交互与输入](./interaction.md#模式切换)，工具细节见[内置工具](../reference/tools.md#discuss讨论)。

## TeamCreate 与 TeamDismiss

| 工具 | 作用 |
| --- | --- |
| `TeamCreate` | 雇佣一名或多名伙伴（各需 `name`、`role`、`mandate`）。创建可在地图上看到的挂载子会话。受 `/team settings` 最大部门深度限制。 |
| `TeamDismiss` | 从本部门移除伙伴并**删除**其挂载子会话。必须提供 `reason`。若成员仍在工作，先以 `confirm_active=false` 调用；确认中断后再以 `confirm_active=true` 重试。 |

`TeamDismiss` 是移除雇佣伙伴的正式路径。通过 `/map` 卸载只会去掉挂载关系，**不会**删除子会话。

## 会话地图（Session 挂载树）

**会话地图**是由 **`parent_session_id`** 元数据（以及可选的 `mount_role` / `mount_mandate`）连成的会话森林。支持：

- **Mount** — 将会话 B 挂到会话 A 下。
- **Unmount** — 去掉 B 的父链接（会话数据仍在）。
- **Remount** — 在 B 已有父节点时更换挂载位置。

### 终端：`/map`

输入 **`/map`** 浏览当前工作目录下的挂载森林：

- **Enter** — 打开高亮会话（TUI 切换到该会话）。
- **M** — 开始挂载：先选子会话行，再选父会话行；随后可填可选 role/mandate。
- **U** — 卸载高亮会话（需已有父节点）。
- 输入文字搜索；**Esc** 取消。

`/map` 管理**会话挂载**；**`/team`** 管理**部门成员**（打开伙伴会话、浏览汇报、查看本回合 Discuss 发言）。

### Web：Map 视图

在 Nori Work / Web UI 中，打开侧栏 **Map**（会话地图）。画布展示同一棵挂载树：平移/缩放、打开会话进入 Chat、在父节点下创建子会话、挂载或 remount 并填写 role/mandate，以及添加本地标签与注释框（仅地图装饰，不会发给模型）。

需要大屏地图时，可在 TUI 使用 **`/web`** 将当前会话交给浏览器工作台。

## 身份模型：`<session_self>` 与挂载变更

团队身份**不是**通过复制其他会话 transcript 或旧版摘要工具注入，而是：

- **`<session_self>`** — 根据当前挂载元数据写入各会话 system prompt：会话 id、标题、深度、父节点、role、mandate 及直接下属。
- **`<session_mount_changed>`** — 在 mount、unmount、remount 或父节点删除时（`event.session.mount_changed`），在下一回合向受影响会话注入变更通知。

挂载元数据变更后，运行时会刷新 `<session_self>`，让每个伙伴知道自己位于树中的位置。这是身份与拓扑信息，**不是**共享聊天历史。

## 终端栏位：`/team` 与 `Ctrl-Y`

- **`/team`**（别名 **`/agents`**）— 可搜索的部门浏览器。**Enter** 打开选中伙伴的会话（消息与输入都针对该成员）。**Main** 回到主会话。**Tab** 查看成员详情。讨论节点会打开 Discuss 栏。**`/team settings`** 设置最大部门深度。
- **`Ctrl-Y`** — 显示或隐藏底部 **Discuss / Chat** 栏。Discuss 开启时为只读会议轨；否则显示部门 Chat。隐藏栏位不会离开 Discuss，也不会退出已打开的成员会话。

完整键位见[键盘快捷键](../reference/keyboard.md#team-栏)。

## 终端与桌面并存

当 Nori server 或 Nori Work 已占用 home 目录锁时，TUI 可能提示它以**进程内 core** 访问同一存储。请避免在终端与 Nori Work **同时编辑同一会话** —— 挂载变更与 transcript 可能互相覆盖。

## 接下来

- [斜杠命令](../reference/slash-commands.md) — `/team`、`/map`、`/discuss`、`/web`
- [内置工具](../reference/tools.md#协作工具) — `TeamCreate`、`TeamAssign`、`TeamDismiss` 等
- [Agent 与子 Agent](../customization/agents.md) — 只读主 Agent 与 SubAgent 委派
- [会话与上下文](./sessions.md) — 存储布局与会话元数据
