# 开始使用

## Nori Code CLI 是什么

Nori Code CLI 是一个运行在终端中的 AI 编程 Agent，帮助你完成软件开发任务和日常终端操作——阅读和修改代码、执行 Shell 命令、搜索文件、抓取网页；在 2.0 中还可以协调由持久伙伴会话组成的**部门树**，并通过**会话地图**导航。

它适用于以下场景：

- **编写和修改代码**：实现新功能、修复 bug、完成重构
- **理解项目**：探索陌生的代码库，解答架构和实现层面的问题
- **团队工程**：用 `TeamCreate` 雇佣伙伴，先讨论再分配任务，并用 `/team` 与 `/map` 导航会话
- **自动化任务**：批量处理文件、运行构建与测试、串联多个脚本

整套 CLI 以 TypeScript 编写，通过 npm 以 `nori-code` 包分发，运行在 Node.js 之上。可执行命令为 `nori`。Nori Work 是配套的 Electron 桌面工作台。

## 安装

用 npm 或 pnpm 全局安装已发布的包。需要 Node.js 22.19.0 或更高版本（仓库本地开发的 engines 可能更严格）。

```sh
node --version
npm install -g nori-code
```

或用 pnpm：

```sh
pnpm add -g nori-code
```

::: tip 安装之前
Nori Code CLI 为全交互式 TUI 应用，推荐在支持真彩色与连字的现代终端中运行以获得最佳体验，例如 [Kitty](https://sw.kovidgoyal.net/kitty/) 或 [Ghostty](https://ghostty.org/)。
:::

> Windows 用户首次启动前还需要安装 [Git for Windows](https://gitforwindows.org/)，Nori Code CLI 会使用其中的 Git Bash 作为 Shell 环境。如果 Git Bash 安装在非标准路径，请把 `NORI_SHELL_PATH` 设为 `bash.exe` 的绝对路径。

## 升级与卸载

安装完成后，验证可执行文件是否就绪：

```sh
nori --version
```

**升级**：运行 `nori upgrade`，CLI 会检查最新版本并展示更新选项。选择 `Install update now` 后根据当前安装来源执行升级；也可以直接用包管理器：

```sh
npm install -g nori-code@latest
```

**卸载**：

```sh
npm uninstall -g nori-code
```

Nori Work 桌面安装包在 [GitHub Releases](https://github.com/wangyuahn/nori-code/releases) 单独分发。

## 第一次启动

进入项目目录后直接运行 `nori` 启动交互界面：

```sh
cd your-project
nori
```

只想执行一条指令而不进入交互界面时，使用 `-p`：

```sh
nori -p "帮我看一下这个项目的目录结构"
```

继续上一次会话加 `-c`：

```sh
nori -c
```

首次启动时需要配置 API 来源。在交互界面中输入 `/login` 或 `/provider` 进入流程：

```
/login
```

`/login` 会打开平台选择器。视构建而定，可能包含托管 OAuth 与/或 API 密钥选项，以及你在配置中添加的其他供应商。需要退出登录时，输入 `/logout` 清除当前凭证。

::: tip 使用其他 AI 供应商
如果你想接入 Anthropic、OpenAI、Google 等其他供应商，需要直接编辑 `~/.nori-code/config.toml` 配置 API 密钥，详见[平台与模型](../configuration/providers.md)。配置项完整说明见[配置文件](../configuration/config-files.md)、[环境变量](../configuration/env-vars.md)和[配置覆盖](../configuration/overrides.md)。
:::

## 第一个对话

登录完成后，用自然语言描述任务即可。先让它熟悉当前项目：

```
帮我看一下这个项目的目录结构，简单介绍一下每个目录是做什么的
```

Nori Code CLI 会自动调用文件读取、搜索等工具浏览相关内容后给出回答。只读操作默认自动执行无需确认。主 Agent 也可以在普通权限流程下运行有边界的 `Bash` 检查；当 Nori 只读模式开启时，直接 `Write` 和 `Edit` 会被拦截。

也可以直接描述更具体的任务：

```
在 src/utils 里新增一个函数，用来把任意字符串转成 kebab-case，并补一个单元测试
```

Nori Code CLI 会规划步骤，在需要代码改动时通过 `SubAgent` 或雇佣的团队伙伴委派实现，运行相关检查，并在每一步告诉你它做了什么。如果希望主 Agent 在审批后直接编辑文件，可使用 `/setting readonly off`。

::: tip 不知道能做什么？输入 `/help`
随时在输入框输入 `/help`，可以打开内置的命令和快捷键面板，按 `↑`/`↓` 翻看，`Esc` 关闭。退出时输入 `/exit`，或按 `Ctrl-C` 两次，或在输入框为空时按 `Ctrl-D`。
:::

## 常用命令与快捷键速查

第一次使用时，记住下面这些就够了：

**会话相关命令**

| 命令 | 说明 |
| --- | --- |
| `/new` | 开启新会话，清空当前上下文 |
| `/sessions` | 浏览历史会话，选择恢复 |
| `/team` | 打开已雇佣伙伴的会话，或浏览部门汇报 |
| `/map` | 浏览当前工作目录的会话地图（挂载关系） |
| `/model` | 切换当前使用的模型 |
| `/compact` | 手动压缩上下文，释放 token |
| `/fork` | 派生当前会话，保留历史独立继续 |

**最常用快捷键**

| 快捷键 | 说明 |
| --- | --- |
| `Esc` | 中断流式输出 / 关闭弹窗 |
| `Ctrl-C` | 中断输出；空闲时连按两次退出 |
| `Shift-Tab` | 切换 Discuss |
| `Ctrl-Y` | 显示或隐藏 Discuss / Chat 栏 |
| `Ctrl-S` | 输出中途插入消息，无需等待结束 |
| `Ctrl-O` | 折叠 / 展开工具输出 |

想看完整列表，输入 `/help` 或访问[斜杠命令参考](../reference/slash-commands.md)和[键盘快捷键](../reference/keyboard.md)。

## 数据存放在哪里

Nori Code CLI 的本地数据默认保存在 `~/.nori-code/` 下，包含配置文件、会话记录、日志和更新缓存。如需迁移到别处，通过 `NORI_CODE_HOME` 环境变量指定新路径。完整说明见[数据路径](../configuration/data-locations.md)和[环境变量](../configuration/env-vars.md)。

## 下一步

- [交互与输入](./interaction.md) — 输入框操作、审批流程、Discuss 和 YOLO 模式详解
- [团队工程](./team-engineering.md) — 部门树、会话地图、Discuss/Assign 与 `/team` / `/map`
- [从 kimi-cli 迁移](./migration.md) — 1.x → 2.0 团队工程说明与旧版 kimi-cli 数据
- [会话与上下文](./sessions.md) — 恢复会话、上下文压缩、导出会话
- [常见使用案例](./use-cases.md) — 典型任务的 prompt 示例
