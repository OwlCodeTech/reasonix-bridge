# Reasonix MCP Bridge — 保姆级使用指南

让你在 **Codex** 中直接调用 DeepSeek 在本地执行文件操作、代码修改和命令运行。
文件操作受工作区沙箱保护，命令执行按模式分级授权。

---

## 目录

1. [前置准备](#1-前置准备)
2. [目录结构](#2-目录结构)
3. [安装依赖](#3-安装依赖)
4. [配置 DeepSeek API](#4-配置-deepseek-api)
5. [选择命令模式](#5-选择命令模式)
6. [启动 Bridge](#6-启动-bridge)
7. [配置 Codex 连接](#7-配置-codex-连接)
8. [验证是否连通](#8-验证是否连通)
9. [实战：让 Codex 委托一个任务](#9-实战让-codex-委托一个任务)
10. [命令模式详解](#10-命令模式详解)
11. [安全边界说明](#11-安全边界说明)
12. [故障排查](#12-故障排查)

---

## 1. 前置准备

| 项目 | 要求 |
|---|---|
| Node.js | **>= 18**（推荐 20+） |
| npm | 随 Node.js 自带 |
| DeepSeek API Key | 在 [platform.deepseek.com](https://platform.deepseek.com) 注册获取 |
| Codex | 已安装并可使用 MCP 插件功能 |

检查 Node.js 版本：

```powershell
node --version   # 应输出 v18.x.x 或更高
npm --version    # 应输出 9.x.x 或更高
```

---

## 2. 目录结构

项目文件位于：

```
F:\mcp\mcp-bridge-deepseek\
├── index.js               # Bridge 主程序（v0.16.0）
├── reasonix-prompt.md     # DeepSeek 的 system prompt
├── README.md              # 英文文档
├── REASONIX-使用指南.md   # 本指南（中文）
├── package.json           # Node.js 项目配置
├── package-lock.json      # 依赖锁定
├── config.example.json    # Codex MCP 配置模板
├── .gitignore             # 忽略规则
└── node_modules/          # 已安装的依赖
```

> **注意**：所有操作都在 `F:\mcp\mcp-bridge-deepseek\` 目录下进行。
> `index.js` 需要被 Codex 的 MCP 配置引用。本指南中所有路径均基于此根目录。

---

## 3. 安装依赖

如果 `node_modules/` 还不存在，在项目目录下执行：

```powershell
cd F:\mcp\mcp-bridge-deepseek
npm install
```

成功后应看到：

```
added 105 packages ... found 0 vulnerabilities
```

---

## 4. 配置 DeepSeek API

**不要**把 API Key 写进任何 JSON 或代码文件。
每次新开终端时设置：

```powershell
# PowerShell
$env:DEEPSEEK_API_KEY = "sk-你的key"
```

```bash
# Git Bash / WSL
export DEEPSEEK_API_KEY="sk-你的key"
```

验证是否设置成功：

```powershell
echo $env:DEEPSEEK_API_KEY   # 应显示以 sk- 开头的字符串
```

---

## 5. 选择命令模式

Bridge 有 5 个安全等级。**第一次使用建议从 `static` 开始。**

| 模式 | 安全等级 | 能做什么 | 适合场景 |
|---|---|---|---|
| `off` | 🔒 最高 | 不执行任何命令 | 纯文件浏览 |
| `readonly` | 🔒 高 | pwd、echo、which、where | 检查环境 |
| **`static`** | 🔒🔒 中高 | + git、node --check、tsc --noEmit | **日常代码审查** |
| `verify` | ⚠️ 中 | + npm test、eslint、jest | 运行测试/验证 |
| `full` | ⚠️ 低 | 所有命令 + 文件写入 | 完整开发工作流 |

> **推荐**：日常用 `static`，需要跑测试时用 `verify`，需要写文件时用 `full`。

---

## 6. 启动 Bridge

设置 API Key + 命令模式，然后启动：

```powershell
$env:DEEPSEEK_API_KEY = "sk-你的key"
$env:REASONIX_COMMAND_MODE = "static"
node F:\mcp\mcp-bridge-deepseek\index.js
```

你也可以先 `cd` 到项目目录再直接 `node index.js`：

```powershell
cd F:\mcp\mcp-bridge-deepseek
$env:DEEPSEEK_API_KEY = "sk-你的key"
$env:REASONIX_COMMAND_MODE = "static"
node index.js
```

成功启动后应看到：

```
====================================================================
  mcp-bridge-reasonix v0.16.0  [structured errors + token budget]
  workspace: F:\mcp\mcp-bridge-deepseek  mode: static (lvl:2)
  cmds:true write:false verify:false

  WARNING: subprocesses bypass the file sandbox.
  static  : no package scripts -- static tools only
  verify  : static + npm test, eslint, jest (runs project scripts)
  full    : allowlisted cmds unrestricted, writes enabled
  git     : available in static+ (not in readonly)
  stream  : enabled  |  usage  : authored
====================================================================
```

> **桥接器不会返回命令行提示符。** 它进入 MCP stdio 协议监听状态。
> 这是正常的——**不要关闭这个终端窗口**，它在等待 Codex 连接。

---

## 7. 配置 Codex 连接

### 7.1 打开 Codex 的 MCP 配置

在 Codex 中找到 MCP 服务器配置入口（通常在设置 / 配置文件中）。

### 7.2 添加 Reasonix 服务

添加以下配置：

```json
{
  "mcpServers": {
    "reasonix": {
      "command": "node",
      "args": [
        "F:\\mcp\\mcp-bridge-deepseek\\index.js"
      ],
      "env": {
        "DEEPSEEK_API_KEY": "sk-你的key",
        "REASONIX_COMMAND_MODE": "static",
        "WORKSPACE_ROOT": "F:\\mcp\\mcp-bridge-deepseek"
      }
    }
  }
}
```

> ⚠️ **安全提示**：JSON 配置文件中的 API Key 可能被其他进程读取。
> 更安全的方式是**不在这里填 Key**，在系统环境变量中设置。

> 💡 **如果要管理其他项目**：把 `WORKSPACE_ROOT` 改成目标项目路径即可，Bridge 会在那个目录下进行文件操作。
> 例如 `"WORKSPACE_ROOT": "F:\\MyProject"`。

> 💡 **路径格式**：Windows JSON 中反斜杠需要转义（`\\`），或者直接用正斜杠：
> ```json
> "args": ["F:/mcp/mcp-bridge-deepseek/index.js"]
> ```

### 7.3 重启 Codex

保存配置后重启 Codex，它应该自动拉起 Reasonix 桥接器并发现 `delegate_to_reasonix` 工具。

---

## 8. 验证是否连通

### 方法 A：观察终端

如果你手动启动了 bridge（第 6 步），启动日志会显示：
```
mcp-bridge-reasonix v0.16.0  [structured errors + token budget]
```

如果你让 Codex 自动拉起，Codex 的日志/状态面板会显示已连接。

### 方法 B：发送简单测试

在 Codex 中尝试：

```
请使用 delegate_to_reasonix 工具，帮我执行 pwd 命令。
```

如果配置正确，Codex 会调用 bridge 并返回当前工作目录。

---

## 9. 实战：让 Codex 委托一个任务

连接成功后，你可以这样让 Codex 使用 Reasonix：

### 示例 1：读取文件

```text
请读取当前目录下的 index.js 文件，告诉我它的功能概要。
```

Codex 会调用 `delegate_to_reasonix` → bridge 调用 DeepSeek → DeepSeek 调 `read_file` → 返回内容。

### 示例 2：代码搜索

```text
搜索项目中所有调用 sandboxPath 函数的地方。
```

### 示例 3：Git 状态分析（static 模式）

```text
查看项目的 git 状态和最近 5 条提交记录。
```

### 示例 4：运行测试（verify 模式）

> 需要 `REASONIX_COMMAND_MODE=verify` 或更高级别

```text
运行 npm test 并告诉我测试结果。
```

### 示例 5：修改代码（full 模式）

> 需要 `REASONIX_COMMAND_MODE=full`

```text
修复 src/utils.js 中第 42 行的拼写错误，然后验证文件内容正确。
```

---

## 10. 命令模式详解

### `static` 模式下能用的命令

**git 子命令**（仅限只读子命令）：

| 子命令 | 允许的 flag 示例 |
|---|---|
| `git status` | `--short`, `--porcelain`, `--branch` |
| `git diff` | `--name-only`, `--cached`, `--stat`, `main..HEAD` |
| `git log` | `--oneline`, `--max-count=10`, `--since=` |
| `git show` | `--name-only`, `--stat`, `HEAD` |
| `git ls-files` | `--cached`, `--modified`, `--others` |
| `git describe` | `--tags`, `--always`, `--dirty` |
| `git rev-parse` | `--show-toplevel`, `--git-dir`, `--is-inside-work-tree` |

❌ **不允许**：`git push`、`git commit`、`git merge`、`git checkout`、`git add`

**node**：

```
node --version
node -v
node --check <workspace-file>
node --help
```

**tsc**：

```
tsc --noEmit
tsc --pretty --noEmit
tsc --project <workspace-path>
tsc --help
tsc --version
```

### `verify` 模式额外允许

```
npm test
npm run <test|lint|build|typecheck|format|check>
node --check <file>
tsc --noEmit --project <path>
eslint . --config <path>
jest --passWithNoTests --silent
```

❌ **verify 模式不允许**：`npm install`、`npm run 任意脚本`、`node -e`、`node script.js`

### `full` 模式额外允许

所有 allowlist 内的命令无参数限制，包括：
- `npm install`, `npm publish`
- `node script.js`
- `git push`, `git commit`
- `python`, `pip`
- 文件写入（`edit_file` / `write_file`）

---

## 11. 安全边界说明

### 哪些是安全的（文件沙箱保护）

| 操作 | 保护机制 |
|---|---|
| `read_file` | 路径经 `sandboxPath()` 校验，拒绝越界和 symlink 逃逸 |
| `search_content` | 仅在 workspace root 内遍历，跳过 node_modules、.git 等 |
| `edit_file` | 需 `REASONIX_COMMAND_MODE=full` 才可用 |
| `write_file` | 同上，创建目录后二次校验 |

### 哪些不是（子进程不受沙箱约束）

> ⚠️ **任何通过 `run_command` 执行的命令都是操作系统子进程，不受 JS 沙箱约束。**

| 模式 | 风险说明 |
|---|---|
| `static` | 风险低：git/node/tsc 都是静态操作，但 tsc --project 可能加载插件 |
| `verify` | 风险中：npm test/eslint/jest 会执行项目脚本和配置文件 |
| `full` | 风险高：node、python、npm install 可读写任何文件、访问网络、读取环境变量（包括 DEEPSEEK_API_KEY） |

### 推荐的最佳安全实践

1. **日常用 `static` 模式**，不需要跑脚本时不要升级到 `verify`
2. **只在确认项目可信时用 `full` 模式**
3. **API Key 放在系统环境变量**，不要写在 Codex 的 MCP JSON 配置里
4. **工作区目录不要包含敏感文件**（沙箱只限制 bridge 能访问的路径）

---

## 12. 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `Cannot find package 'glob'` | 依赖未安装 | 执行 `cd F:\mcp\mcp-bridge-deepseek && npm install` |
| `DEEPSEEK_API_KEY not set` | 未设置 API Key | `$env:DEEPSEEK_API_KEY = "sk-xxx"` |
| `Command not allowed: npm` | 当前模式不允许 | 升级到 `verify` 或 `full` |
| `Args not allowed in verify mode` | verify 模式限制了参数 | 检查命令是否符合 verify 模板 |
| `Path escapes workspace` | 路径超出沙箱 | 使用 workspace 内的路径 |
| `Search text appears 2 times` | edit_file 搜索不唯一 | 提供更多上下文行 |
| Codex 提示 "tool not found" | MCP 配置路径不对 | 检查 codex JSON 中的 args 路径是否指向 `F:\mcp\mcp-bridge-deepseek\index.js` |
| Bridge 启动后立即退出 | WORKSPACE_ROOT 不存在 | 检查目录是否存在：`dir F:\mcp\mcp-bridge-deepseek` |
| `Rate limited (429)` | DeepSeek API 限流 | 等待后重试 |
| `Workspace not a directory` | WORKSPACE_ROOT 指向了文件而非文件夹 | 检查 WORKSPACE_ROOT 是否写错了路径 |

---

> **遇到问题？检查第 12 节的故障排查表。如果仍未解决，确认 `node --check index.js` 通过且 `npm install` 已执行。**
