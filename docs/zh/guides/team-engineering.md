# 团队工程

Nori Code CLI 2.0 把项目当作一棵**部门树**，而不是单条聊天记录加旁注。`TeamCreate` 通过创建并 resume **挂载子会话**雇佣伙伴——地图上的那张卡片就是这个会话。工作、工具、cwd、兄弟交流和身份都住在这个子会话上。Discuss 轮次在动手前收集团队发言。本页说明终端与 Nori Work 中这些能力如何配合。

::: warning 注意
临时 `SubAgent` DAG 编排已在 v2.0 **删除**。把工作交给另一个 Agent 的唯一方式是团队工程。与 Codex / Claude Code 的对照，以及 LSP、Git 仍是毛坯等缺口，见 GitHub [README](https://github.com/wangyuahn/nori-code/blob/master/README.zh-CN.md)。
:::

## 部门树与会话地图

协作模型只有一套，出现在两个面上：

- **团队伙伴**（`TeamCreate`）是挂在你下面的**真实子会话**。它们出现在会话地图上的会话卡片中。Discuss、Assign、兄弟交流和身份都按这个 session id 寻址，直到 `TeamDismiss` 移除。
- **会话地图节点**与雇佣是同一类：**真实子会话**，通过 `parent_session_id` 链接。在 Web Map 画布上拉线或「新建会话」走的是与 `TeamCreate` 相同的「创建并 resume 挂载子会话」路径。一个会话只能有一个父节点（暂不支持兼职）。

持久协作者只有 Session 这一类。父会话里不再另造一套 Team Agent 身份。

主 Agent 默认是**只读协调者**：直接 `Write` / `Edit` 会被拦截（`/setting readonly on`），雇佣成员在 `TeamAssign` 离开 Discuss 后执行分配任务。只有在你希望负责人直接改文件时才使用 `/setting readonly off`。

## Discuss 与 Code

**Discuss** 是只读团队会议。开启期间，`Write`、`Edit`、`Bash`、`TaskStop`、`CronCreate`、`CronDelete` 会被拦截，直到团队进入 **Code**。

典型流程：

1. **`TeamCreate`** — 在本部门雇佣伙伴（每人是地图上的真实子会话）。
2. **`TeamDecide`**，`action=start` — 以主题开启 Discuss；成员用 **`TeamSpeak`** 发言（本轮不调用会记为弃权）。
3. **`TeamAssign`** — 分配具体任务；成功后**离开 Discuss** 进入 Code，成员可以执行。
4. 工作完成后 **`TeamDecide`**，`action=vote` — 全队投票（`discuss_again` / `proceed` / `abstain`），无需再次进入完整 Discuss。

Discuss 是**多轮**的会。每条 `TeamSpeak` 只推进一步（一个可裁决的点），不是完整方案。用 `TeamDecide` 的 `action=continue` 开下一轮。有人弃权只记为该人弃权，后面的人照常发言。

在 UI 中用 **`Shift-Tab`**、**`/discuss`** 或兼容别名 **`/plan`** 切换 Discuss。**`TeamAssign`** 与 Discuss/Code 切换都可以离开 Discuss；YOLO 不会额外增加退出审批。

审批行为见[交互与输入](./interaction.md#模式切换)，工具细节见[内置工具](../reference/tools.md#discuss讨论)。

## TeamCreate 与 TeamDismiss

| 工具 | 作用 |
| --- | --- |
| `TeamCreate` | 雇佣一名或多名伙伴（各需 `name`、`role`、`mandate`）。创建并 resume 挂载子会话（地图上的会话卡片）。Discuss/Assign/Chat 按该 session id 寻址。受 `/team settings` 最大部门深度限制。 |
| `TeamDismiss` | 从本部门移除伙伴。解雇会删除该子会话。必须提供 `reason`。若成员仍在工作，先以 `confirm_active=false` 调用；确认中断后再以 `confirm_active=true` 重试。 |
| `TeamUpdate` | 更新本会话或成员的名称、角色、职责或标签。相关会话会收到系统提醒，但不会被唤醒。 |

`TeamDismiss` 是移除雇佣伙伴的正式路径。通过 `/map` 卸载只会去掉挂载关系，**不会**删除子会话。

## 会话地图（Session 挂载树）

**会话地图**是由 **`parent_session_id`** 元数据（以及可选的 `mount_role` / `mount_mandate`）连成的会话森林。支持：

- **Mount** — 将会话 B 挂到会话 A 下。
- **Unmount** — 去掉 B 的父链接（会话数据仍在）。
- **Remount** — 在 B 已有父节点时更换挂载位置（覆盖原父节点，不会增加第二份兼职）。

从**输出口** Shift+拖线创建**对等**连线，Alt+拖线创建**服务**连线：只保存在本地地图上，不调用挂载 API。点击虚线可删除。输入口拖线始终是改挂（Shift/Alt 不会改成对等/服务连线）。

### 终端：`/map`

输入 **`/map`** 浏览当前工作目录下的挂载森林：

- **Enter** — 打开高亮会话（TUI 切换到该会话）。
- **M** — 开始挂载：先选子会话行，再选父会话行；随后可填可选 role/mandate。
- **U** — 卸载高亮会话（需已有父节点）。
- 输入文字搜索；**Esc** 取消。

`/map` 与 **`/team`** 读的是**同一棵 Session 森林**。`/team` 是部门浏览器（打开伙伴会话、浏览汇报、查看本回合 Discuss 发言）；`/map` 是同一批会话的空间视图。

### Web：Map 视图

在 Nori Work / Web UI 中，打开侧栏 **Map**（会话地图）。画布是会话控制台，不是静态蓝图：平移/缩放、读取卡片运行态、打开会话进入 Chat、在父节点下创建子会话、强制停止进行中的回合、编辑名称/职责/标签、挂载或 remount 并填写 role/mandate，以及添加本地标签与注释框（仅地图装饰，不会发给模型）。

蓝图交互：

- **右键空白** — 在该处新建顶层会话；**右键拖动** — 平移画布。
- **输出口拖到卡片** — 静默挂载；拖到空白 — 打开身份草稿后 `createChild`。
- **输入口拖到另一张卡片** — 改挂。已有父节点时会确认：这是 remount，不是兼职。
- **Alt+点击卡片（或其输入口）** — 拆挂升为顶层。右键卡片结束工作，不断开挂载。忙碌会话的挂载/拆挂会排队到空闲。
- **框选** — 出现工具条，可打开、停止、设置、拆挂、删除。右键选区可执行同样的批量操作。
- **标签筛选**同时作用于左侧列表和画布。可见卡片都是真实会话，可以框选或拉线。

需要大屏地图时，可在 TUI 使用 **`/web`** 将当前会话交给浏览器工作台。

## 身份模型：`<session_self>` 与挂载变更

团队身份**不是**通过复制其他会话 transcript 或旧版摘要工具注入，而是：

- **`<session_self>`** — 根据当前挂载元数据写入各会话 system prompt：会话 id、标题、深度、父节点、role、mandate、标签及直接下属。
- **`<session_mount_changed>`** — 在 mount、unmount、remount 或父节点删除时（`event.session.mount_changed`），在下一回合向受影响会话注入变更通知。
- **`<session_identity_changed>`** — 名称、角色、职责或标签变更时注入。相关会话会收到提醒，**不会被唤醒**。

挂载元数据变更后，运行时会刷新 `<session_self>`，让每个伙伴知道自己位于树中的位置。这是身份与拓扑信息，**不是**共享聊天历史。

## 终端栏位：`/team` 与 `Ctrl-Y`

- **`/team`**（别名 **`/agents`**）— 可搜索的部门浏览器。**Enter** 打开选中伙伴的会话（消息与输入都针对该成员）。**Main** 留在当前会话。**Tab** 查看成员详情。讨论节点会打开 Discuss 栏。**`/team settings`** 设置最大部门深度。
- **`Ctrl-Y`** — 在**当前会话**显示或隐藏底部 **Discuss / Chat** 栏。部门 Chat 与 Discuss 挂在负责人会话上。Discuss 开启时为只读会议轨；否则显示部门 Chat。隐藏栏位不会离开 Discuss，也不会切换会话。若当前是没有自己部门的挂载子会话，栏位会提示 Chat 在父会话上，需用 `/map` 或 `/team` 打开父会话。

完整键位见[键盘快捷键](../reference/keyboard.md#team-栏)。

## 终端与桌面并存

当 Nori server 或 Nori Work 已占用 home 目录锁时，TUI 可能提示它以**进程内 core** 访问同一存储。请避免在终端与 Nori Work **同时编辑同一会话** —— 挂载变更与 transcript 可能互相覆盖。

## 接下来

- [斜杠命令](../reference/slash-commands.md) — `/team`、`/map`、`/discuss`、`/web`
- [内置工具](../reference/tools.md#协作工具) — `TeamCreate`、`TeamAssign`、`TeamDismiss` 等
- [会话与上下文](./sessions.md) — 存储布局与会话元数据
- GitHub [README](https://github.com/wangyuahn/nori-code/blob/master/README.zh-CN.md) — 现在的 Nori 相对 Codex / Claude Code，以及缺口清单
