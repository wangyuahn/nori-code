# Nori Code — 待办日程 (Roadmap)

## P0 (近期)

### 1. 内置 LSP（Language Server Protocol）
**目标：** Agent 不再依赖 grep 字符串猜测代码语义，通过 LSP 获取精确的符号定义、类型、引用和诊断。

**子任务：**
- [ ] 确定 LSP 管理架构（进程池 / 按需启动 / 缓存策略）
- [ ] typescript-language-server 集成（代理 tsserver 协议）
- [ ] IDE LSP（rust-analyzer、pyright、gopls 等）通用适配层
- [ ] Agent 工具层：新增 `nori_lsp_definition`、`nori_lsp_references`、`nori_lsp_hover`、`nori_lsp_diagnostics`
- [ ] LSP 结果与 Agent context 的智能拼接（避免把整个 AST dump 给模型）
- [ ] 多项目/多语言同时打开时的 LSP 生命周期管理
- [ ] 性能：LSP init 预热、诊断变更 delta 推送、session 切换复用

### 2. 自定义 Agent
**目标：** 用户可定义自己的专用 Agent（定制 prompt + tools + profile），类似插件但更轻量。

**子任务：**
- [ ] Agent profile schema（name、description、systemPrompt、allowedTools、model override）
- [ ] 用户定义文件格式（`nori.yaml` 内联 / `.nori/agents/*.yaml` / 双层都支持）
- [ ] Agent registry：注册→校验→运行时加载
- [ ] Tool 权限控制：定义 Agent 可用/不可用的工具列表
- [ ] UI：Nori Work 中的 Agent 管理面板
- [ ] 自定义 Agent 可通过 `/agent <name>` 或 TUI 切换调用
- [ ] 支持从社区/仓库导入 Agent 定义

---

## P1 (中期)

### 3. 内置浏览器（Agent Browser Tool）
**目标：** Agent 具备内嵌浏览器能力，能渲染页面、截图、执行 JS、与页面交互 —— 对标 Codex 的 browser feature 但融入 Nori 的 Agent 编排体系。

**子任务：**
- [ ] 无头浏览器内核选择（Chromium CDP / Playwright / Electron WebContentsView）
- [ ] Agent 工具层：`nori_browser_navigate`、`nori_browser_screenshot`、`nori_browser_click`、`nori_browser_evaluate`、`nori_browser_html`
- [ ] 渲染输出：截图读回、HTML 结构化摘要、可访问性树
- [ ] 交互：表单填写、点击链接、等待加载
- [ ] Nori Work 集成：用户可实时看到浏览器在干嘛（与已有 BrowserViewManager 整合）
- [ ] headless 模式：CLI 使用时的隐藏浏览器进程
- [ ] 安全沙箱：限制同源、阻止非预期导航、cookie 隔离
- [ ] 场景覆盖：前端代码预览、文档截图、页面调试、端到端验证

---

## 长期方向 (P2+)

- 自托管 Agent 市场（社区自定义 Agent 分发）
- LSP 驱动的自动重构（跨文件重命名、提取函数）
- 浏览器 Agent 的自发调试循环（截图→分析→修改→刷新验证）
- 多模态：截图直接进入 LSP/浏览器工具的反馈回路
