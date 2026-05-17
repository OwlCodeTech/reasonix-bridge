# Codex + DeepSeek (Reasonix Bridge) 常用指令本

> 使用方式：复制模板 → 粘贴到 Codex → 替换 `{占位符}` → 发送

---

## 📖 一、文件读取类

### 1.1 读一个文件

```
使用 execute_task，读取 {路径/文件名}，帮我总结它的功能。
```

### 1.2 读文件指定范围

```
使用 execute_task，读取 {路径/文件名} 的第 {30} 到 {80} 行。
```

### 1.3 同时读多个文件做对比

```
使用 execute_task，执行以下任务：
1. 读取 {src/file-a.ts}
2. 读取 {src/file-b.ts}
3. 对比两个文件的 {某函数/某逻辑} 差异
```

---

## 🔍 二、代码搜索类

### 2.1 搜索关键字

```
使用 execute_task，搜索项目中所有出现 {关键字} 的地方。
```

### 2.2 限定目录搜索

```
使用 execute_task，搜索 {src/utils} 目录下所有出现 {关键字} 的地方。
```

### 2.3 搜索函数调用链

```
使用 execute_task，执行以下任务：
1. 搜索 {函数名} 的定义位置
2. 搜索所有调用 {函数名} 的地方
3. 按文件整理调用链
```

---

## 🛠 三、Git 操作类（static 模式）

### 3.1 查看当前改动

```
使用 execute_task，运行 git status 和 git diff --name-only。
```

### 3.2 查看最近提交

```
使用 execute_task，查看最近 {5} 条 git 提交记录（git log --oneline -5）。
```

### 3.3 查看某个文件的修改历史

```
使用 execute_task，运行 git log --oneline -- {路径/文件名}，并告诉我每次提交改了些什么。
```

---

## ✏️ 四、代码生成类（full 模式）

### 4.1 创建新文件

```
使用 execute_task。

task: 在 {src/utils/helpers.ts} 创建一个文件，实现以下功能：
{功能描述}

完成后运行 node --check 验证语法。
context: 当前项目使用 TypeScript，已有依赖 lodash。
```

### 4.2 修改已有文件

```
使用 execute_task。

task: 修改 {src/app.ts}，在 {某函数} 中增加 {某功能}。
尽量使用 edit_file 做局部修改，不要重写整个文件。
```

### 4.3 修复 bug

```
使用 execute_task。

task: 修复 {src/app.ts} 中的 bug。
context:
报错信息：{错误内容}
当前相关代码：
```
{相关代码片段}
```
```

---

## ✅ 五、代码验证类（verify / full 模式）

### 5.1 检查语法

```
使用 execute_task，对 {src/} 目录下所有 .ts 文件运行 node --check。
```

### 5.2 运行测试

```
使用 execute_task，运行 npm test 并报告结果（通过的用例数和失败的用例数）。
```

---

## 🔄 六、综合任务类

### 6.1 重构函数（稳妥做法 - 分步）

```
第 1 步：使用 execute_task，搜索 {旧函数名} 的所有调用位置。
```

```
第 2 步：使用 execute_task，将 {src/xxx.ts} 中的 {旧函数} 重构为 {新函数}。
```

```
第 3 步：使用 execute_task，运行 node --check 验证语法。
```

### 6.2 代码审查

```
使用 execute_task。

task: 审查 {src/xxx.ts} 文件，检查以下问题：
1. 是否有未使用的变量或 import
2. 是否有类型标注缺失
3. 是否有潜在的空指针风险
4. 给出改进建议
```

---

## ⚠️ 七、模式切换速查

| 你要做什么 | 需要的模式 | 环境变量设置 |
|-----------|-----------|-------------|
| 读文件、搜索代码 | 任何模式（推荐 `static`） | `REASONIX_COMMAND_MODE=static` |
| 查 git 历史、git diff | `static` 或以上 | `REASONIX_COMMAND_MODE=static` |
| 跑 npm test / eslint | `verify` 或以上 | `REASONIX_COMMAND_MODE=verify` |
| 创建文件、修改代码 | `full` | `REASONIX_COMMAND_MODE=full` |
| 安装依赖、跑脚本 | `full` | `REASONIX_COMMAND_MODE=full` |

---

## 💡 使用贴士

1. **先读后写**：改代码前先让 DeepSeek 读一遍目标文件，能大幅提高修改准确率
2. **别让 DeepSeek 做决策**：让它执行，不让它选择——比如你不会说"优化这个项目"，而是说"把 var 改成 const"
3. **小步提交**：每个 `execute_task` 只做一个任务，失败了不影响其他部分
4. **传 context 省 token**：错误日志、相关代码片段放 `context` 参数里，DeepSeek 就不用自己去读文件查
