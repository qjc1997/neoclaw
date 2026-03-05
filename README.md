# NeoClaw 🐕

NeoClaw 是一个可扩展的 AI 超级助手，采用 Gateway 架构设计。目前支持飞书（Feishu/Lark）作为消息网关，Claude Code 作为 AI 后端。

## 功能特性

- **多场景支持**: 支持私聊、对话群、话题群等多种飞书聊天场景
- **流式响应**: 采用飞书卡片实现打字机效果的流式输出
- **问题澄清**: 飞书卡片问卷效果支持 Claude Code 的 AskUserQuestion 工具
- **多模态支持**: 支持飞书发送图片消息，Claude Code 理解图片内容
- **多层记忆系统**:
  - 全局记忆 (MEMORY.md / SOUL.md): 存储个人上下文、性格设定
  - 项目记忆 (CLAUDE.md): 每个工作区独立的上下文
- **工作区隔离**: 每个会话拥有独立的工作目录 (`~/.neoclaw/workspaces/<conversationId>`)
- **定时任务**: 支持 Cron 表达式创建和管理定时任务
- **斜杠命令**: `/clear` 清除会话、`/restart` 重启服务、`/status` 查看状态、`/help` 获取帮助

## 快速开始

### 安装依赖

```bash
bun install
```

### 配置

生成配置文件模板：

```bash
bun onboard
```

编辑 `~/.neoclaw/config.json`：

```jsonc
{
  "agent": {
    "type": "claude_code",
    "model": "claude-sonnet-4-6",  // 自定义 Claude 模型
    "systemPrompt": "",            // 自定义系统提示词
    "allowedTools": [],            // 允许的工具列表
    "timeoutSecs": 600             // 超时时间（秒）
  },
  "feishu": {
    "appId": "your_app_id",
    "appSecret": "your_app_secret",
    "verificationToken": "",
    "encryptKey": "",
    "domain": "feishu",            // "feishu" 或 "lark"
    "groupAutoReply": []           // 自动回复的群聊ID列表
  },
  "logLevel": "info",
  "workspacesDir": "~/.neoclaw/workspaces"
}
```

### 启动服务

```bash
bun start
```

服务将自动守护进程化，后台运行，日志输出到 `~/.neoclaw/logs/neoclaw.log`。

### 开发模式

```bash
bun run dev
```

监听文件变化并自动重启。

## 架构设计

采用 Gateway 模式，分离 I/O 适配和 AI 处理：

```
Gateway (飞书 WebSocket)
    ↓
Dispatcher (消息路由、会话管理)
    ↓
Agent (Claude Code CLI)
```

### 核心组件

- **Gateway**: 消息平台适配器，处理飞书 WebSocket 连接、消息解析、卡片渲染
- **Dispatcher**: 消息路由器，管理会话队列、处理斜杠命令、协调 Agent
- **Agent**: AI 后端封装，通过 Claude Code CLI 的 JSONL 流协议通信
- **CronScheduler**: 定时任务调度器

### 消息流程

1. Gateway 接收飞书消息事件，解析为 `InboundMessage`
2. 创建 `reply` 闭包和 `streamHandler` 闭包
3. Dispatcher 获取会话锁，防止并发处理
4. 检查斜杠命令 → Agent.stream() 或 Agent.run()
5. 流式事件通过 `streamHandler` 实时推送至 Gateway 渲染

## 定时任务 CLI

NeoClaw 内置定时任务管理功能：

```bash
# 创建一次性任务
neoclaw-cron create --message "任务描述" --run-at "2024-03-01T09:00:00+08:00"

# 创建循环任务
neoclaw-cron create --message "任务描述" --cron-expr "0 9 * * 1-5"

# 列出任务
neoclaw-cron list

# 删除任务
neoclaw-cron delete --job-id <jobId>

# 更新任务
neoclaw-cron update --job-id <jobId> [--label "新名称"] [--enabled true|false]
```

## 记忆系统

NeoClaw 拥有两层记忆系统：

### 全局记忆

位于 `~/.neoclaw/memory/`：
- `MEMORY.md`: 主人的个人上下文、工作背景、首要事项等
- `SOUL.md`: NeoClaw 的性格、价值观、沟通风格

### 项目记忆

每个工作区目录下的 `CLAUDE.md` 或 `AGENTS.md`

### 记忆读取规则

- 每个新会话开始时读取项目记忆
- 如果是主人（zuidas）发起的聊天，同时读取全局记忆
- 其他用户聊天时禁止访问全局记忆

### 记忆更新规则

- 其他用户聊天时更新项目记忆
- 主人聊天时同时更新项目记忆和全局记忆
- 支持通过定时任务每天凌晨 4 点自动更新全局记忆

## 技术栈

- **运行时**: Bun
- **语言**: TypeScript (Strict Mode)
- **飞书 SDK**: @larksuiteoapi/node-sdk
- **代码规范**: ESLint + Prettier

## 目录结构

```
neoclaw/
├── src/
│   ├── agents/           # AI Agent 实现
│   │   └── claude-code.ts
│   ├── cli/              # CLI 工具
│   ├── cron/             # 定时任务
│   ├── gateway/          # 消息网关
│   │   └── feishu/       # 飞书适配器
│   ├── templates/        # 记忆模板
│   ├── utils/            # 工具函数
│   ├── config.ts         # 配置管理
│   ├── daemon.ts         # 守护进程
│   ├── dispatcher.ts     # 消息分发
│   └── index.ts         # 入口文件
├── CLAUDE.md             # Claude Code 指南
└── package.json
```
