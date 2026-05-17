# Reasonix Bridge

**Codex ↔ DeepSeek MCP Bridge — 在本地执行复杂任务的多智能体引擎**

Codex 通过 MCP 协议将任务委托给 DeepSeek，文件工具受 WORKSPACE_ROOT 限制；命令工具按模式限制，但不是强隔离沙箱。支持二阶段执行、多智能体并行、增量模式、动态预算。

---

## 🚀 快速开始

### 1. 安装

```bash
npm install
cp .env.example .env
```

### 2. 配置

编辑 `.env`，填入你的 Key：

```env
DEEPSEEK_API_KEY=sk-your-key-here
REASONIX_COMMAND_MODE=static
```

> `.env` 已被 `.gitignore` 排除，不会泄露密钥。

### 3. 启动

```bash
node index.js
```

### 4. Codex 侧配置

在 Codex 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "reasonix": {
      "command": "node",
      "args": ["/path/to/index.js"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-key-here",
        "REASONIX_COMMAND_MODE": "static"
      }
    }
  }
}
```

---

## 🔧 工具

| 工具 | 用途 | 推荐场景 |
|:-----|:-----|:---------|
| **`execute_task`** ⭐ | **自动判别模式：单智能体 / 多智能体** | **日常使用** |
| `plan_task` | 只出计划，不执行 | 先看方案再动手 |
| `execute_step` | 执行指定的一步 | 配合 plan_task |
| `orchestrate_task` | 强制多智能体并行 | 明确需要分工时 |
| `improve_file` | **DeepSeek 定向修复工具；Codex/Bridge 保留接管权** | Codex 发现需要改的地方时 |
| `delegate_to_reasonix` | 旧版一键执行 | 兼容旧用法 |

### 使用示例

```
execute_task("在 ./demo 下创建博客系统，包含后端 API、前端页面和数据库")
```

Bridge 自动判断复杂度：
- **简单任务**（1~2 文件） → 单智能体直行
- **复杂任务**（多模块/多领域） → 多智能体并行

### 推荐使用方式

日常优先使用 `execute_task`。它会先判断任务复杂度，简单任务走单智能体，复杂任务自动拆分给多个子智能体。适合代码审查、跨文件搜索、局部修改、运行验证命令和多模块任务。

只想看方案时使用 `plan_task`，确认计划后再用 `execute_step` 分步执行。明确需要多角色并行时使用 `orchestrate_task`。旧的 `delegate_to_reasonix` 仅用于兼容旧指令，新用法不建议继续依赖。

只读审查任务建议在 prompt 中明确写出“只读 / 不要修改文件 / 不要写入文件”。Bridge 会自动移除 `edit_file` 和 `write_file`，但仍允许读取、搜索和运行验证命令。

---

## 🧪 科学家团队

当任务需要多智能体时，按角色分配：

| Emoji | 科学家 | 角色 | 领域 |
|:-----:|:------|:----|:------|
| 🖥️ | **Dijkstra** | 后端工程师 | 服务器、API、算法 |
| 🎨 | **Hopper** | 前端开发者 | UI、交互、组件 |
| 🗄️ | **Turing** | 数据工程师 | 数据库、存储 |
| 🔗 | **Berners-Lee** | 接口工程师 | API 通信 |
| 🧪 | **Lovelace** | 测试工程师 | 验证、部署 |

**单领域复杂任务** 会自动拆分子智能体：

```
🖥️ Dijkstra
  ├─ Dijkstra-A 用户认证模块
  ├─ Dijkstra-B 文章 CRUD
  └─ Dijkstra-C 文件上传
```

---

## 🏗️ 架构

```
Codex（MCP Client）
  │  stdio 管道
  ▼
index.js（MCP Server）
  │
  ├─ 6 个 MCP 工具
  │
  ├─ 8 个本地沙箱工具（read_file / write_file / run_command / ...）
  │
  └─ DeepSeek API（streaming）
       ├─ 规划模式（无工具，出计划）
       └─ 执行模式（8 工具，agent loop）
```

### 二阶段执行

```
Phase 1：DeepSeek 拆解任务 → JSON 步骤列表（5~10秒）
Phase 2：逐步骤执行 / 多智能体并行（每步独立上下文）
         → 前序成果已落盘，不受后续预算影响
```

### 并行调度

```
无依赖的子任务 → Promise.all 并行执行
有依赖的子任务 → 等依赖完成后执行
每步完成后 → 提取接口契约 → 传递给后续科学家
已完成释放的预算 → 动态分配给未完成的
```

---

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|:-----|:------:|:-----|
| `DEEPSEEK_API_KEY` | — | **必填** | DeepSeek API 密钥 |
| `REASONIX_COMMAND_MODE` | `static` | 命令模式分级 |
| `WORKSPACE_ROOT` | `cwd` | 沙箱根目录 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型 |
| `DEEPSEEK_TEMPERATURE` | `0.2` | 温度参数 |
| `REASONIX_MAX_TOKENS` | `64000` | 累计 Token 预算 |
| `HTTP_PROXY` | — | 代理（仅国外 API） |
| `GITHUB_TOKEN` | — | GitHub API 限速提升 |

### 命令模式

| 模式 | 权限 |
|:----|:-----|
| `off` | 无命令，仅文件读 |
| `readonly` | pwd / echo / which |
| `static` | + git(ro) / node --check / tsc |
| `verify` | + npm test / eslint / jest |
| `full` | 全开放 + 写文件 |

### 安全模式建议

| 场景 | 推荐模式 | 说明 |
|:-----|:--------|:-----|
| 只读审查、搜索、总结 | `static` | 默认推荐，可读文件，可运行安全验证类命令 |
| 跑测试、lint、构建验证 | `verify` | 允许更多验证命令，适合 CI 前检查 |
| 需要改文件 | `full` | 仅在明确需要写入时使用，写已有文件默认要求 `expected_hash` |
| 高风险/不信任项目 | `off` 或 `readonly` | 尽量不开放命令执行 |

---

## 🛡️ 安全

| 机制 | 说明 |
|:-----|:------|
| **文件沙箱** | `sandboxPath()` 校验所有路径，拒绝越界/symlink逃逸 |
| **命令分级** | 5 级授权，`full` 模式才允许写操作 |
| **只读保护** | 任务明确要求只读时，自动禁用 `edit_file` / `write_file` |
| **Hash 防覆盖** | 覆盖已有文件默认要求 `expected_hash`，避免并发或误覆盖 |
| **强制写审计** | `force:true` 会记录工具、路径、模式、新旧 hash |
| **预算控制** | `REASONIX_MAX_TOKENS` 硬上限，超限优雅停止 |
| **Token 隔离** | `.gitignore` 已排除 `.env` 和 API Key 文件 |
| **`improve_file`** | DeepSeek 定向修复工具；失败或不满足要求时 Codex 可直接接管 |

> ⚠️ `run_command` 子进程不受 JS 沙箱约束，可读任意文件和环境变量。
> ⚠️ `force:true` 跳过 hash 检查直接覆盖已存在文件，仅用户明确要求时使用，不建议模型自动触发。
> ⚠️ `full` 模式适合受信任项目的开发阶段，不建议对不可信仓库长期启用。

---

## 📂 项目结构

```
├── index.js               # MCP Server 主程序
├── reasonix-prompt.md     # DeepSeek System Prompt
├── package.json           # 项目定义
├── .env.example           # 环境变量模板
├── LICENSE                # MIT License
├── README.md              # 本文档
├── config.example.json    # Codex MCP 配置模板
```

---

## 📄 License

MIT

---

## 📊 技术指标

| 指标 | 值 |
|:-----|:----:|
| 代码行数 | ~1500 行（单文件） |
| 运行时依赖 | `@modelcontextprotocol/sdk` + `glob` |
| Node 版本 | >= 18 |
| 最大子智能体 | 12 个 |
| Token 预算 | 默认 64k |
