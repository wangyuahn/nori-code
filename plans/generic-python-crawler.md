# 通用 Python 爬虫框架 — 实现计划

## 目标

在 `C:\Users\sudden\Desktop\example` 创建一个轻量级、可扩展的通用 Python 爬虫框架，支持数据采集场景。

## 架构设计

```
example/
├── crawler/
│   ├── __init__.py
│   ├── engine.py          # 爬虫引擎：请求调度、并发控制、速率限制
│   ├── downloader.py      # 下载器：HTTP 请求、重试、User-Agent 轮换
│   ├── parser.py          # 解析器基类 + CSS/XPath 提取工具
│   ├── pipeline.py        # 数据管道：清洗、去重、变换
│   ├── storage.py         # 存储后端：JSON / CSV / SQLite
│   └── middleware.py       # 中间件：请求/响应钩子
├── examples/
│   └── demo_spider.py     # 示例爬虫（爬取 quotes 测试网站）
├── config.yaml             # 全局配置
├── requirements.txt        # 依赖
└── run.py                  # CLI 入口
```

## 核心模块

### 1. `engine.py` — 爬虫引擎
- 异步架构（`asyncio` + `aiohttp`）
- 并发控制：信号量限制最大并发数
- 速率限制：令牌桶 / 固定延迟
- 请求队列 + 去重集合
- 回调式结果处理

### 2. `downloader.py` — 下载器
- `aiohttp` 异步请求
- 自动重试（指数退避）
- User-Agent 池随机轮换
- Cookie 持久化
- 超时控制
- 响应状态码检查

### 3. `parser.py` — 解析器
- 抽象基类 `BaseParser`，用户继承实现 `parse(response) -> list[dict]`
- 内置 `SelectorHelper`：CSS 选择器 + XPath 便捷方法
- 基于 `parsel`（Scrapy 同款解析库）

### 4. `pipeline.py` — 数据管道
- 管道链模式：多个 processor 依次处理
- 内置处理器：`StripWhitespace`、`DropDuplicates`、`TypeCast`
- 可自定义处理器

### 5. `storage.py` — 存储
- `JsonStorage`：追加式 JSON Lines
- `CsvStorage`：自动表头
- `SqliteStorage`：自动建表 + 批量插入

### 6. `middleware.py` — 中间件
- 请求前 / 响应后钩子
- 内置：日志中间件、请求延迟中间件

## 依赖

```
aiohttp>=3.9          # 异步 HTTP
parsel>=1.9           # HTML/XML 解析 (CSS + XPath)
pyyaml>=6.0           # 配置解析
aiosqlite>=0.20       # SQLite 异步存储
loguru>=0.7           # 结构化日志
```

## 实现步骤

### Step 1: 项目骨架
- 创建 `crawler/` 包目录
- 编写 `requirements.txt`
- 编写 `config.yaml`

### Step 2: 下载器 (`downloader.py`)
- `Downloader` 类：`fetch(url, **kwargs)` 异步方法
- 重试逻辑 + UA 轮换

### Step 3: 解析器 (`parser.py`)
- `BaseParser` 抽象类
- `SelectorHelper` 工具类

### Step 4: 存储 (`storage.py`)
- `JsonStorage`、`CsvStorage`、`SqliteStorage`
- 统一接口 `save(items: list[dict])`

### Step 5: 管道 (`pipeline.py`)
- 管道链实现
- 内置处理器

### Step 6: 中间件 (`middleware.py`)
- 中间件管理器
- 内置中间件

### Step 7: 引擎 (`engine.py`)
- 整合所有模块
- 并发 + 速率控制
- 启动/停止生命周期

### Step 8: CLI 入口 + 示例
- `run.py`：命令行启动
- `examples/demo_spider.py`：完整示例

## 验收标准

1. `pip install -r requirements.txt && python run.py` 可执行
2. 示例爬虫能成功爬取 http://quotes.toscrape.com 并输出 JSON/CSV
3. 速率限制生效（不超目标站点的合理请求频率）
4. 异常重试正常工作
