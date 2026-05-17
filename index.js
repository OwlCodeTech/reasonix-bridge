import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  readFileSync, readdirSync, statSync, existsSync, realpathSync,
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { globSync } from "glob";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// =========================================================================
//  .env 加载（零依赖，读取 .env 文件设置环境变量）
// =========================================================================
const __envDir = dirname(fileURLToPath(import.meta.url));
try {
  const envRaw = readFileSync(join(__envDir, '.env'), 'utf8');
  for (const line of envRaw.split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && m[1] && m[2]) {
      // 去除可能包裹的值引号
      let val = m[2].replace(/^["']|["']$/g, '');
      if (!process.env[m[1].trim()]) process.env[m[1].trim()] = val;
    }
  }
} catch (_) { /* .env not found — use env vars only */ }

// =========================================================================
//  CONFIGURATION
// =========================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL          = process.env.DEEPSEEK_MODEL        || "deepseek-chat";
const DEFAULT_TEMPERATURE    = Number.parseFloat(process.env.DEEPSEEK_TEMPERATURE || "0.2");

var _realRoot;
try { _realRoot = realpathSync(resolve(process.env.WORKSPACE_ROOT || process.cwd())); }
catch { _realRoot = null; }
if (!_realRoot) { console.error("[FATAL] WORKSPACE_ROOT does not exist."); process.exit(1); }
if (!statSync(_realRoot).isDirectory()) { console.error("[FATAL] WORKSPACE_ROOT not a directory."); process.exit(1); }
const WORKSPACE_ROOT = _realRoot;

const MAX_TOOL_TURNS     = 50;
const FETCH_TIMEOUT_MS   = 180_000;
const MAX_RETRIES        = 3;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES   = 10 * 1024 * 1024;
const MAX_FILE_SIZE      = 5 * 1024 * 1024;
const MAX_WRITE_BYTES    = 1 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;
const MAX_GLOB_RESULTS   = 200;
const MAX_PATTERN_LENGTH = 200;
const MAX_ARG_LENGTH     = 1000;
const _maxTokensRaw = parseInt(process.env.REASONIX_MAX_TOKENS || "300000");
const MAX_TOTAL_TOKENS  = Number.isFinite(_maxTokensRaw) && _maxTokensRaw > 0 ? _maxTokensRaw : 300000;

// --- 规划模式 system prompt ---
const PLANNING_PROMPT = `你是一个严谨的软件架构师。请将用户的任务分解为**具体的、可执行的步骤**。

输出要求：返回纯 JSON 数组，不要加 markdown 包裹。
每个步骤包含："id", "file", "action", "depends_on"。

规则：
- 每个步骤只操作 1 个文件
- 先写依赖文件，再写被依赖文件
- 每个步骤完成后可以用 run_command/tsc/node --check 验证
- 步骤数量控制在 3~10 个
- 最后一步是组装/验证

示例输出：
[{"id":1,"file":"src/models/user.py","action":"创建用户模型","depends_on":[]},{"id":2,"file":"src/routes.py","action":"创建 API 路由","depends_on":[1]}]

请输出 JSON：`;

// =========================================================================
//  并行多智能体（Orchestrator）—— 科学家命名方案
// =========================================================================

// 角色 → Emoji + 科学家 映射
const SCIENTIST = {
  backend:  "🖥️ Dijkstra",
  frontend: "🎨 Hopper",
  database: "🗄️ Turing",
  api:      "🔗 Berners-Lee",
  test:     "🧪 Lovelace",
};

// 每个科学家的专属 system prompt
const SCIENTIST_PROMPT = {
  "🖥️ Dijkstra":  "你是 Dijkstra，后端算法大师。你擅长服务器的搭建、API路由和算法优化。",
  "🎨 Hopper":    "你是 Hopper，前端交互大师。你擅长 UI 的实现和用户的交互体验。",
  "🗄️ Turing":    "你是 Turing，数据库存储大师。你擅长数据的表结构设计和索引优化。",
  "🔗 Berners-Lee": "你是 Berners-Lee，接口通信大师。你擅长 Web 交互和 API 接口设计。",
  "🧪 Lovelace":   "你是 Lovelace，测试验证大师。你擅长代码的测试和部署验证。",
};

// Orchestrator 的系统提示词
const ORCHESTRATOR_PROMPT = `你是一个项目拆解专家。请将用户的任务分解为子任务，分发给不同的科学家。

## 科学家团队
- 🖥️ Dijkstra: 后端/服务器/算法
- 🎨 Hopper: 前端/UI/样式/组件
- 🗄️ Turing: 数据库/存储/数据
- 🔗 Berners-Lee: API/通信/接口
- 🧪 Lovelace: 测试/验证/部署

## 输出要求
返回纯 JSON 数组，每个元素：
- "role": 角色（backend/frontend/database/api/test）
- "action": 该子智能体做什么
- "files": 要创建/修改的文件列表
- "depends_on": 依赖的子任务序号（从0开始）

## 规则
- 即使任务只涉及一个领域（比如只有后端），如果功能模块多（>3个独立功能），
  也应该拆成多个同角色的子任务，例如 Dijkstra-A、Dijkstra-B
- 每个子任务只负责 1~2 个文件
- 无依赖的子任务可以并行执行
- 总子任务数控制在 3~6 个

## 示例（跨领域）
[{"role":"backend","action":"创建用户模型和 API 接口","files":["models/user.py","routes/user.py"],"depends_on":[]},
 {"role":"frontend","action":"创建用户列表页面","files":["pages/UserList.tsx"],"depends_on":[0]},
 {"role":"database","action":"设计用户表结构","files":["schema.sql","migrations/"],"depends_on":[0]}]

## 示例（单领域复杂）
[{"role":"backend","action":"实现用户认证模块","files":["backend/auth/login.py","backend/auth/register.py"],"depends_on":[]},
 {"role":"backend","action":"实现文章 CRUD","files":["backend/articles/models.py","backend/articles/routes.py"],"depends_on":[]},
 {"role":"backend","action":"实现文件上传模块","files":["backend/upload/handler.py"],"depends_on":[]}]

请输出 JSON：`;

// -----------------------------------------------------------------------
//  Command mode: off | readonly | static | verify | full
// -----------------------------------------------------------------------

const COMMAND_MODE = (process.env.REASONIX_COMMAND_MODE || "").toLowerCase();
const _lac = process.env.REASONIX_ALLOW_COMMANDS === "1";
const _law = process.env.REASONIX_ALLOW_WRITE === "1";

const LVL = { off: 0, readonly: 1, static: 2, verify: 3, full: 4 };
var modeLevel, allowCommands, allowWrite, allowVerify;
if (COMMAND_MODE) {
  modeLevel = LVL[COMMAND_MODE];
  if (modeLevel === undefined) {
    console.error("[FATAL] Invalid REASONIX_COMMAND_MODE=" + COMMAND_MODE);
    process.exit(1);
  }
  allowCommands = modeLevel >= 1;
  allowWrite    = modeLevel >= 4;
  allowVerify   = modeLevel >= 3;
} else {
  // Legacy fallback: if REASONIX_COMMAND_MODE is unset, check old env vars.
  // If neither is set, default to off (mode 0).
  modeLevel = _lac ? (_law ? 4 : 2) : 0;
  allowCommands = _lac;
  allowWrite    = _law;
  allowVerify   = _lac && _law;
}

// Display name: use mode name, or "off" for legacy default, or "legacy-fallback" for active legacy.
const MODE_NAME = COMMAND_MODE || (modeLevel === 0 ? "off" : "legacy-fallback");

// -----------------------------------------------------------------------
//  Command lists
// -----------------------------------------------------------------------

const READONLY_COMMANDS   = _load("REASONIX_READONLY_COMMANDS",   ["pwd","echo","which","where"]);
const STATIC_COMMANDS     = _load("REASONIX_STATIC_COMMANDS",     ["node","tsc"]);
const VERIFY_COMMANDS     = _load("REASONIX_VERIFY_COMMANDS",
                                  ["npm","npx","git","node","tsc","eslint","jest","mocha"]);
const MUTATING_COMMANDS   = _load("REASONIX_MUTATING_COMMANDS",   ["python","python3","pip"]);
const VERIFY_NPM_SCRIPTS  = _load("REASONIX_VERIFY_NPM_SCRIPTS",
                                  ["test","lint","build","typecheck","type-check","format","fmt","check"]);

function _load(k, d) {
  const r = process.env[k];
  if (r && r.trim()) return r.split(",").map(s => s.trim()).filter(Boolean);
  return [...d];
}

var _all = null;
function allCmds() {
  if (!_all) _all = [...new Set([...READONLY_COMMANDS, ...STATIC_COMMANDS, ...VERIFY_COMMANDS, ...MUTATING_COMMANDS])];
  return _all;
}

// =========================================================================
//  GIT SUBCOMMAND TEMPLATES
// =========================================================================

const GIT = {
  "status":   { f:{"--short":0,"--porcelain":0,"-s":0,"-z":0,"--branch":0,"--long":0},                        r:false },
  "diff":     { f:{"--name-only":0,"--name-status":0,"--cached":0,"--staged":0,"--stat":0,"--shortstat":0,"--numstat":0,"--no-color":0,"--diff-filter=":"R","--ignore-all-space":0,"--ignore-space-change":0,"--ignore-blank-lines":0,"-w":0}, r:true },
  "log":      { f:{"--oneline":0,"--max-count=":"R","--skip=":"R","--since=":"R","--until=":"R","--after=":"R","--before=":"R","--author=":"R","--grep=":"R","--committer=":"R","--format=":"R","--pretty=":"R","--no-merges":0,"--all":0,"--graph":0,"--decorate":0,"--branches=":"R","--remotes=":"R","--tags=":"R","--simplify-by-decoration":0,"--dense":0,"--sparse":0,"--full-history":0,"--not":0,"--no-walk":0,"--left-right":0,"--cherry-pick":0,"--ancestry-path":0,"--first-parent":0}, r:true },
  "show":     { f:{"--name-only":0,"--name-status":0,"--stat":0,"--no-color":0,"--format=":"R","--pretty=":"R"}, r:true },
  "ls-files": { f:{"--cached":0,"--modified":0,"--deleted":0,"--others":0,"--ignored":0,"--exclude-standard":0,"--directory":0,"--no-empty-directory":0,"--full-name":0,"-z":0,"-s":0,"--stage":0}, r:false },
  "describe": { f:{"--tags":0,"--all":0,"--always":0,"--dirty":0,"--long":0,"--abbrev=":"R","--exact-match":0,"--match=":"R"}, r:true },
  "rev-parse":{ f:{"--show-toplevel":0,"--show-cdup":0,"--show-prefix":0,"--git-dir":0,"--absolute-git-dir":0,"--is-inside-work-tree":0,"--is-inside-git-dir":0,"--is-bare-repository":0,"--short":0,"--symbolic":0,"--abbrev-ref":0,"--verify":0,"--sq":0,"--not":0,"--git-path=":"R"}, r:true },
  "rev-list": { f:{"--max-count=":"R","--skip=":"R","--since=":"R","--until=":"R","--after=":"R","--before=":"R","--author=":"R","--grep=":"R","--committer=":"R","--all":0,"--branches":0,"--remotes":0,"--tags":0,"--merges":0,"--no-merges":0,"--first-parent":0,"--left-right":0,"--count":0,"--not":0,"--all-match":0,"--min-parents=":"R","--max-parents=":"R"}, r:true },
  "shortlog": { f:{"-n":0,"--numbered":0,"-s":0,"--summary":0,"-e":0,"--email":0,"--format=":"R","--since=":"R","--until=":"R","--author=":"R","--all":0,"--no-merges":0}, r:true },
  "help":     { f:{}, r:false },
  "version":  { f:{}, r:false },
};

// =========================================================================
//  VERIFY FLAG TABLES
// =========================================================================

const VFY = {
  "node":   { f:{"--version":0,"-v":0,"--check":"P","--help":0},                         b:false },
  "npm":    { f:{"--version":0,"help":0,"whoami":0},                                      b:false, s:["test","run"] },
  "npx":    { f:{"--version":0,"--help":0},                                               b:false },
  "tsc":    { f:{"--noEmit":0,"--pretty":0,"--project":"P","-p":"P","--help":0,"--version":0}, b:false },
  "eslint": { f:{"--help":0,"--version":0,"--no-eslintrc":0,"--config":"P","--ext":"S","--max-warnings=":"S","--format=":"S"}, b:true },
  "jest":   { f:{"--passWithNoTests":0,"--silent":0,"--coverage":0,"--verbose":0,"--help":0,"--version":0,"--selectProjects=":"S","--runTestsByPath":"P","-t":"S","--testNamePattern=":"S"}, b:false },
};

const STATIC_VERIFY_TOOLS = ["node", "tsc"];

// =========================================================================
//  PATH UTILITIES
// =========================================================================

function sandboxPath(requestedPath) {
  const rawResolved = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(WORKSPACE_ROOT, requestedPath);

  var resolved;
  try { resolved = realpathSync(rawResolved); }
  catch (err) {
    if (err.code === "ENOENT") resolved = rawResolved;
    else throw err;
  }

  const rel = relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path escapes workspace: " + stripWS(resolved));
  }

  if (!existsSync(resolved)) {
    const ancestor = findAnc(resolved);
    if (ancestor) {
      try {
        const realAncestor = realpathSync(ancestor);
        const relAncestor = relative(WORKSPACE_ROOT, realAncestor);
        if (relAncestor.startsWith("..") || isAbsolute(relAncestor)) {
          throw new Error("Anc escapes: " + stripWS(realAncestor));
        }
      } catch (e2) { if (e2.code !== "ENOENT") throw e2; }
    }
  }

  if (existsSync(resolved)) {
    try {
      const nowReal = realpathSync(resolved);
      const nowRel = relative(WORKSPACE_ROOT, nowReal);
      if (nowRel.startsWith("..") || isAbsolute(nowRel)) {
        throw new Error("TOCTOU escape: " + stripWS(resolved));
      }
    } catch (e3) { if (e3.code !== "ENOENT") throw e3; }
  }

  return resolved;
}

function sandboxPathCwd(pathVal, cmdCwd) {
  if (pathVal === ".") return;
  sandboxPath(isAbsolute(pathVal) ? pathVal : join(cmdCwd, pathVal));
}

function findAnc(fp) {
  let c = fp;
  for (;;) {
    if (existsSync(c)) return c;
    const p = dirname(c);
    if (p === c) return null;
    c = p;
  }
}

function stripWS(fp) {
  try {
    const r = relative(WORKSPACE_ROOT, fp);
    if (!r.startsWith("..") && !isAbsolute(r)) return r;
  } catch (_) {}
  return "<ow>";
}

function reqS(v, n) {
  if (typeof v !== "string" || !v.trim()) throw new Error("Missing: " + n);
  return v.trim();
}
function optS(v) {
  return (typeof v === "string" && v.trim()) ? v.trim() : undefined;
}

// =========================================================================
//  GATES
// =========================================================================

function assertWrite() {
  if (!allowWrite) throw new Error("Write disabled. Set REASONIX_COMMAND_MODE=full.");
}
function assertCmd() {
  if (!allowCommands) throw new Error("Commands disabled.");
}
function match(t, a) {
  return process.platform === "win32" ? a.toLowerCase() === t.toLowerCase() : a === t;
}

// =========================================================================
//  GIT READONLY
// =========================================================================

function gitRO(args, cmdCwd) {
  if (!Array.isArray(args) || !args.length) return false;
  const sc = args[0].toLowerCase();
  const tm = GIT[sc];
  if (!tm) return false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      for (let j = i + 1; j < args.length; j++) {
        if (isAbsolute(args[j]) || args[j].indexOf("..") !== -1) return false;
        if (cmdCwd) { try { sandboxPathCwd(args[j], cmdCwd); } catch { return false; } }
      }
      break;
    }
    if (!a.startsWith("-")) {
      if (isAbsolute(a)) return false;
      if (!tm.r) return false;
      continue;
    }
    if (isAbsolute(a) || a.indexOf("..") !== -1) return false;
    const eqIdx = a.indexOf("=");
    var fn = eqIdx !== -1 ? a.slice(0, eqIdx + 1) : a;
    var ft = tm.f[fn];
    if (ft === undefined && eqIdx !== -1) { fn = a.slice(0, eqIdx); ft = tm.f[fn]; }
    if (ft === undefined) return false;
  }
  return true;
}

// =========================================================================
//  VERIFY SCANNER
// =========================================================================

function verifySafe(tool, args, cmdCwd) {
  if (!Array.isArray(args) || !args.length) return false;
  const tb = VFY[tool];
  if (!tb) return false;
  var i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!a.startsWith("-")) {
      if (tool === "npm" && tb.s) {
        if (tb.s.indexOf(a) === -1) return false;
        if (a === "run") {
          i++; if (i >= args.length) return false;
          if (VERIFY_NPM_SCRIPTS.indexOf(args[i]) === -1) return false;
          i++; if (i < args.length) return false;
          break;
        }
        i++; continue;
      }
      if (!tb.b) return false;
      try { sandboxPathCwd(a, cmdCwd); } catch { return false; }
      i++; continue;
    }
    const eqIdx = a.indexOf("=");
    var fn = eqIdx !== -1 ? a.slice(0, eqIdx + 1) : a;
    var ev = eqIdx !== -1 ? a.slice(eqIdx + 1) : null;
    var ft = tb.f[fn];
    if (ft === undefined && eqIdx !== -1) { fn = a.slice(0, eqIdx); ft = tb.f[fn]; }
    if (ft === undefined) return false;
    if (ft === 0) { i++; continue; }
    if (ft === "S") {
      var val = ev; if (val === null) { i++; if (i >= args.length) return false; val = args[i]; }
      if (val.length > MAX_ARG_LENGTH) return false;
      i++; continue;
    }
    if (ft === "P") {
      var val = ev; if (val === null) { i++; if (i >= args.length) return false; val = args[i]; }
      try { sandboxPathCwd(val, cmdCwd); } catch { return false; }
      i++; continue;
    }
    i++;
  }
  return true;
}

// =========================================================================
//  AUDIT
// =========================================================================

function audit(k, m) {
  const s = {};
  for (const kk in m) {
    if (!m.hasOwnProperty(kk)) continue;
    switch (kk) { case "content": case "search": case "replace": case "pattern": case "apiKey": break; default: s[kk] = m[kk]; }
  }
  console.error("[audit] " + k + ":", JSON.stringify(s));
}

// =========================================================================
//  SYSTEM PROMPT
// =========================================================================

async function loadPrompt() { return readFile(join(__dirname, "reasonix-prompt.md"), "utf8"); }
function buildMsg(task, ctx) { const p = ["Task:\n" + task]; const c = optS(ctx); if (c) p.push("Context:\n" + c); return p.join("\n\n---\n\n"); }

// =========================================================================
//  FETCH
// =========================================================================

async function fetchR(url, opts, ret) {
  if (ret === undefined) ret = MAX_RETRIES;
  for (let a = 1; a <= ret; a++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try { return await fetch(url, { ...opts, signal: ac.signal }); }
      finally { clearTimeout(t); }
    } catch (e) {
      const ir = e.name === "AbortError" || e.type === "system" ||
        (e.cause && (e.cause.code === "ECONNRESET" || e.cause.code === "ETIMEDOUT"));
      if (ir && a < ret) { await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, a - 1), 8000))); continue; }
      throw e;
    }
  }
}

// =========================================================================
//  FILE WALKER & GREP
// =========================================================================

const SKIP = new Set(["node_modules",".git",".cache",".npm-cache","dist","build",".next",".nuxt","target","__pycache__",".venv","venv",".reasonix"]);
function* walk(r) { let e; try { e = readdirSync(r,{withFileTypes:true}); } catch { return; } for (const n of e) { if (SKIP.has(n.name)) continue; const fp = join(r,n.name); if (n.isDirectory()) yield* walk(fp); else if (n.isFile()) yield fp; } }
const BIN = new Set([".png",".jpg",".jpeg",".gif",".ico",".svg",".woff",".woff2",".ttf",".eot",".zip",".tar",".gz",".7z",".rar",".exe",".dll",".so",".dylib",".bin",".o",".obj",".pyc",".class",".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".mp3",".mp4",".avi",".mov"]);
function isBin(fp) { const e = fp.slice(fp.lastIndexOf(".")).toLowerCase(); if (BIN.has(e)) return true; try { return readFileSync(fp,{encoding:"latin1",flag:"r"}).slice(0,8192).indexOf("\0") !== -1; } catch { return true; } }

function nGrep(dir, pat, opts) {
  opts = opts || {}; const res = []; const ctx = opts.context || 0;
  if (pat.length > MAX_PATTERN_LENGTH) return { error: "Pattern too long." };
  const fl = opts.caseSensitive === true ? "" : "i";
  let re; try { re = opts.regex === true ? new RegExp(pat, fl) : new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"), fl); } catch (e) { return { error: "Invalid pattern." }; }
  for (const fp of walk(dir)) {
    if (opts.glob) { const gs = opts.glob.replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*"); try { if (!new RegExp(gs).test(fp)) continue; } catch { continue; } }
    let st; try { st = statSync(fp); } catch { continue; }
    if (st.size > MAX_FILE_SIZE || st.size === 0) continue; if (isBin(fp)) continue;
    let c; try { c = readFileSync(fp,"utf8"); } catch { continue; }
    const ls = c.split("\n");
    for (let i = 0; i < ls.length; i++) {
      if (re.test(ls[i])) { res.push({file:stripWS(fp),line:i+1,text:ls[i],context:ctx>0?ls.slice(Math.max(0,i-ctx),Math.min(ls.length,i+ctx+1)).join("\n"):undefined}); if (res.length>=MAX_SEARCH_RESULTS) break; }
    }
    if (res.length>=MAX_SEARCH_RESULTS) break;
  }
  return { matches: res.length, results: res };
}

// =========================================================================
//  HANDLERS
// =========================================================================

async function hRead(args) {
  const fp = sandboxPath(reqS(args.path,"path")); const st = statSync(fp);
  if (st.isDirectory()) return { error: "Is dir: " + stripWS(fp) };
  if (st.size > MAX_FILE_SIZE) return { error: "Too large." };
  const c = await readFile(fp,"utf8"); const ls = c.split("\n"); let r = c;
  if (args.range) { const p = args.range.split("-").map(Number); r = ls.slice(Math.max(0,p[0]-1),p[1]||ls.length).join("\n"); }
  else if (args.head) { r = ls.slice(0,Math.max(0,args.head)).join("\n"); }
  else if (args.tail) { r = ls.slice(-Math.max(0,args.tail)).join("\n"); }
  return { file: stripWS(fp), size: st.size, lines: ls.length, content: r };
}

async function hSearch(args) {
  const pat = reqS(args.pattern,"pattern"); const sd = args.path ? sandboxPath(args.path) : WORKSPACE_ROOT;
  if (!existsSync(sd)) return { error: "Not found: " + stripWS(sd) };
  return nGrep(sd, pat, { glob: args.glob, context: args.context||0, caseSensitive: args.case_sensitive===true, regex: args.regex===true });
}

async function hList(args) {
  const dp = sandboxPath(reqS(args.path,"path"));
  if (!existsSync(dp)) return { error: "Not found: " + stripWS(dp) };
  if (!statSync(dp).isDirectory()) return { error: "Not dir: " + stripWS(dp) };
  return { path: stripWS(dp), entries: readdirSync(dp,{withFileTypes:true}).map(e => ({name:e.name,type:e.isDirectory()?"dir":"file"})) };
}

async function hRun(args) {
  assertCmd();
  const tool = reqS(args.tool,"tool");
  const ca = Array.isArray(args.args) ? args.args.filter(a => typeof a === "string") : [];
  const isR = READONLY_COMMANDS.some(c => match(tool,c));
  const isS = STATIC_COMMANDS.some(c => match(tool,c));
  const isV = VERIFY_COMMANDS.some(c => match(tool,c));
  const isM = MUTATING_COMMANDS.some(c => match(tool,c));
  if (!isR && !isS && !isV && !isM) return { error: "Not allowed: " + tool + ". Allowed: " + allCmds().join(", ") };
  const cwd = args.cwd ? sandboxPath(join(WORKSPACE_ROOT, args.cwd)) : WORKSPACE_ROOT;

  if (match(tool,"git") && gitRO(ca, cwd)) {
    if (modeLevel < LVL.static) return { error: "git requires mode=static or higher." };
    audit("run",{tool,args:ca.length,cwd:stripWS(cwd),mode:"git-ro"});
    return _sp(tool,ca,cwd);
  }

  if (isM) { if (!allowWrite) return { error: tool + " needs mode=full." }; }
  if (isR) { /* ok */ }
  else if (isS || isV) {
    if (modeLevel === LVL.full) { /* unrestricted */ }
    else if (modeLevel === LVL.verify) {
      if (!verifySafe(tool, ca, cwd)) return { error: tool + " args not allowed in verify mode." }; }
    else if (modeLevel === LVL.static) {
      if (isV && STATIC_VERIFY_TOOLS.indexOf(tool) === -1) return { error: tool + " not in static mode (try verify)." };
      if (!verifySafe(tool, ca, cwd)) return { error: tool + " args not allowed in static mode." }; }
    else return { error: tool + " needs static/verify/full mode." };
  }

  audit("run",{tool,args:ca.length,cwd:stripWS(cwd),mode:MODE_NAME});
  return _sp(tool,ca,cwd);
}

function _sp(t,a,c) {
  const r = spawnSync(t,a,{cwd:c,encoding:"utf8",maxBuffer:MAX_OUTPUT_BYTES,timeout:COMMAND_TIMEOUT_MS,windowsHide:true,shell:false});
  if (r.error) return {error:"Failed: "+t+" -- "+r.error.message};
  return {stdout:(r.stdout||"").trim(),stderr:(r.stderr||"").trim(),exitCode:r.status,truncated:(r.stdout||"").length+(r.stderr||"").length>MAX_OUTPUT_BYTES};
}

async function hGlob(args) {
  const p = reqS(args.pattern,"pattern"); if (p.indexOf("..") !== -1) return {error:"No '..' in glob."};
  const sp = args.path ? sandboxPath(args.path) : WORKSPACE_ROOT; const lim = Math.min(args.limit||100,MAX_GLOB_RESULTS);
  if (!existsSync(sp)) return {error:"Not found: "+stripWS(sp)};
  const raw = globSync(p,{cwd:sp,dot:false}); const sf = [];
  for (let fi=0; fi<raw.length; fi++) { try { sandboxPath(join(sp,raw[fi])); sf.push(raw[fi]); if (sf.length>=lim) break; } catch {} }
  return {matches:sf.length,files:sf};
}

async function hInfo(args) {
  const fp = sandboxPath(reqS(args.path,"path")); if (!existsSync(fp)) return {error:"Not found: "+stripWS(fp)};
  const st = statSync(fp); return {type:st.isDirectory()?"dir":"file",size:st.size,mtime:st.mtime.toISOString(),path:stripWS(fp)};
}

async function hEdit(args) {
  assertWrite(); const fp = sandboxPath(reqS(args.path,"path")); const sr = reqS(args.search,"search"); const rp = typeof args.replace==="string"?args.replace:"";
  if (!existsSync(fp)) return {error:"Not found: "+stripWS(fp)};
  const cur = await readFile(fp,"utf8"); const cnt = cur.split(sr).length-1;
  if (cnt===0) return {error:"Text not found."}; if (cnt>1) return {error:"Text appears "+cnt+" times."};
  await writeFile(fp,cur.replace(sr,rp),"utf8"); return {success:true,path:stripWS(fp)};
}

async function hWrite(args) {
  assertWrite(); const fp = sandboxPath(reqS(args.path,"path")); const c = typeof args.content==="string"?args.content:"";
  if (c.length>MAX_WRITE_BYTES) return {error:"Too large."};
  const p = dirname(fp); if (!existsSync(p)) await mkdir(p,{recursive:true});
  try { if (relative(WORKSPACE_ROOT,realpathSync(fp)).startsWith("..")) return {error:"Escaped after mkdir."}; }
  catch(e4) { if (e4.code==="ENOENT") { if (relative(WORKSPACE_ROOT,realpathSync(p)).startsWith("..")) return {error:"Parent escaped."}; } else throw e4; }
  await writeFile(fp,c,"utf8"); return {success:true,path:stripWS(fp),bytes:c.length};
}

// =========================================================================
//  DISPATCHER
// =========================================================================

const H = { read_file:hRead,search_content:hSearch,list_directory:hList,run_command:hRun,glob:hGlob,get_file_info:hInfo,edit_file:hEdit,write_file:hWrite };
async function execTC(tc) { const n=tc.function.name; let a; try { a=JSON.parse(tc.function.arguments); } catch { return {ok:false,error:"Invalid JSON arguments.",tool:n}; } const h=H[n]; if (!h) return {ok:false,error:"Unknown tool: "+n,tool:n}; try { const r=await h(a); return r&&r.error?{...r,ok:false,tool:n}:{ok:true,...r,tool:n}; } catch(e) { return {ok:false,error:e.message,tool:n}; } }

// =========================================================================
//  TOOL DEFS
// =========================================================================

function ss(d) { return {type:"string",description:d}; }
function nn(d) { return {type:"number",description:d}; }
function bb(d) { return {type:"boolean",description:d}; }
function sa(d) { return {type:"array",items:{type:"string"},description:d}; }

var TOOLS = [
  {type:"function",function:{name:"read_file",description:"Read file within sandboxed workspace.",parameters:{type:"object",properties:{path:ss("Path"),head:nn("First N"),tail:nn("Last N"),range:ss("Range")},required:["path"]}}},
  {type:"function",function:{name:"search_content",description:"Search files. Literal default, regex opt-in. Sandboxed.",parameters:{type:"object",properties:{pattern:ss("Pattern"),path:ss("Dir"),glob:ss("Filter"),context:nn("Ctx"),regex:bb("Regex"),case_sensitive:bb("CS")},required:["pattern"]}}},
  {type:"function",function:{name:"list_directory",description:"List files in workspace folder.",parameters:{type:"object",properties:{path:ss("Path")},required:["path"]}}},
  {type:"function",function:{name:"run_command",description:"Run command. Mode: "+MODE_NAME+". WARNING: subprocess bypasses sandbox.",parameters:{type:"object",properties:{tool:ss("Tool: "+allCmds().join(", ")),args:sa("Args array"),cwd:ss("Subdir")},required:["tool","args"]}}},
  {type:"function",function:{name:"glob",description:"Find files by glob. No '..'. Sandboxed.",parameters:{type:"object",properties:{pattern:ss("Glob"),path:ss("Dir"),limit:nn("Max")},required:["pattern"]}}},
  {type:"function",function:{name:"get_file_info",description:"Get file/dir metadata.",parameters:{type:"object",properties:{path:ss("Path")},required:["path"]}}},
  {type:"function",function:{name:"edit_file",description:"SEARCH/REPLACE edit. Needs mode=full.",parameters:{type:"object",properties:{path:ss("File"),search:ss("Text"),replace:ss("Repl")},required:["path","search","replace"]}}},
  {type:"function",function:{name:"write_file",description:"Create/overwrite file. Needs mode=full.",parameters:{type:"object",properties:{path:ss("Path"),content:ss("Content")},required:["path","content"]}}},
];

// =========================================================================
//  STREAMING AGENT LOOP
// =========================================================================

function parseSSE(line) {
  if (!line || !line.startsWith("data: ")) return null;
  const d = line.slice(6).trim();
  if (d === "[DONE]") return { _done: true };
  try { return JSON.parse(d); } catch { return null; }
}

function accTC(base, delta) {
  if (!delta.tool_calls) return base;
  for (const tc of delta.tool_calls) {
    const idx = tc.index;
    if (!base[idx]) base[idx] = { id: "", name: "", arguments: "" };
    if (tc.id) base[idx].id = tc.id;
    if (tc.function?.name) base[idx].name += tc.function.name;
    if (tc.function?.arguments) base[idx].arguments += tc.function.arguments;
  }
  return base;
}

function deltasToTC(deltas) {
  return Object.values(deltas).filter(d => d.name).map(d => ({
    id: d.id, type: "function", function: { name: d.name, arguments: d.arguments }
  }));
}

// Extract a human-readable label from a tool call for the structured report.
function toolCallLabel(tc) {
  try {
    const a = JSON.parse(tc.function.arguments);
    switch (tc.function.name) {
      case "read_file":       return "read " + stripWS(sandboxPath(reqS(a.path,"path")));
      case "edit_file":       return "edit " + stripWS(sandboxPath(reqS(a.path,"path")));
      case "write_file":      return "write " + stripWS(sandboxPath(reqS(a.path,"path")));
      case "run_command":     return a.tool + " " + (a.args||[]).slice(0,6).join(" ");
      case "search_content":  return "search " + a.pattern.slice(0,40);
      case "list_directory":  return "ls " + stripWS(sandboxPath(reqS(a.path,"path")));
      case "glob":            return "glob " + a.pattern;
      case "get_file_info":   return "stat " + stripWS(sandboxPath(reqS(a.path,"path")));
    }
  } catch {}
  return tc.function.name;
}

// =========================================================================
//  二阶段执行引擎：Plan → Execute → Summary
// =========================================================================

// 非流式调用 DeepSeek（规划阶段使用，不开放工具）
async function callDeepSeekText(systemPrompt, userMsg, budget) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set.");
  const res = await fetchR(DEEPSEEK_API_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_MODEL, temperature: 0.2,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
      max_tokens: Math.min(budget || 10000, 16000),
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error("Plan API: " + res.status + " " + t.slice(0, 200)); }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// 单步执行（独立上下文、独立预算）
async function executeOneStep(taskMsg, step, budget) {
  const sysPrompt = await loadPrompt();
  var msgs = [{ role: "system", content: sysPrompt }, { role: "user", content: taskMsg }];
  var log = [];

  for (var turn = 0; turn < 15; turn++) {
    console.error("[step " + step.id + "] turn " + (turn + 1) + "/15");
    const response = await fetchR(DEEPSEEK_API_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_MODEL, temperature: 0.2,
        messages: msgs, tools: TOOLS, tool_choice: "auto",
        stream: true, stream_options: { include_usage: true },
      }),
    });
    if (!response.ok) { const st = response.status; const b = await response.text(); if (st === 401 || st === 403) throw new Error("Auth failed."); if (st === 429) throw new Error("Rate limited."); throw new Error("API error: " + st + " " + b.slice(0,100)); }

    const reader = response.body.getReader();
    var decoder = new TextDecoder(); var buffer = ""; var content = ""; var tcAccum = {}; var doneSeen = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done || doneSeen) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        const parsed = parseSSE(line); if (!parsed) continue;
        if (parsed._done) { doneSeen = true; break; }
        const delta = parsed.choices?.[0]?.delta; if (!delta) continue;
        if (delta.content) content += delta.content;
        if (delta.tool_calls) accTC(tcAccum, delta);
      }
    }
    if (buffer.trim()) { const parsed = parseSSE(buffer.trim()); if (parsed && parsed.choices?.[0]?.delta) { const d = parsed.choices[0].delta; if (d.content) content += d.content; if (d.tool_calls) accTC(tcAccum, d); } }

    const toolCalls = deltasToTC(tcAccum);
    if (!toolCalls.length) { log.push("[done]"); console.error("[step " + step.id + "] done in " + (turn + 1) + " turns"); return { ok: true, content: (content || "").slice(0, 300), log: log, turns: turn + 1 }; }

    msgs.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const label = toolCallLabel(tc); log.push(label);
      const result = await execTC(tc);
      msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  log.push("[max turns]"); return { ok: true, content: "", log: log, turns: 15 };
}

// 主入口
async function executeTask(task, context) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not set.");
  const taskMsg = buildMsg(task, context);
  var timeline = [];

  // ════════════════════════════════════════════
  // Phase 1: 规划
  // ════════════════════════════════════════════
  console.error("[plan] generating plan...");
  var planRaw;
  try { planRaw = await callDeepSeekText(PLANNING_PROMPT, taskMsg, 8000); planRaw = planRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim(); }
  catch (e) { console.error("[plan] failed: " + e.message + " — falling back"); planRaw = ""; }

  var plan;
  try { plan = JSON.parse(planRaw); if (!Array.isArray(plan) || plan.length < 1) throw new Error("not array"); }
  catch (e) { console.error("[plan] parse failed, using single-pass"); return { type: "text", text: "[plan phase failed — executing task directly]\n\n" + (await executeLegacy(taskMsg)).text }; }

  console.error("[plan] " + plan.length + " steps");
  for (const s of plan) console.error("  " + s.id + ". " + s.file + " — " + s.action);

  // ════════════════════════════════════════════
  // Phase 2: 逐步骤执行
  // ════════════════════════════════════════════
  const budgetPerStep = Math.max(10000, Math.floor(MAX_TOTAL_TOKENS / plan.length));

  for (const step of plan) {
    console.error("\n══════════ Step " + step.id + "/" + plan.length + ": " + step.file + " ══════════");
    var stepMsg = "## 任务\n" + task + "\n\n## 当前步骤\n- 文件: " + step.file + "\n- 做什么: " + step.action + "\n\n";
    if (timeline.length > 0) {
      stepMsg += "## 已完成的前置步骤\n";
      for (const t of timeline) stepMsg += "- " + t.file + " (" + t.action + ") — " + (t.ok ? "✅" : "⚠️") + "\n";
      stepMsg += "\n";
    }
    stepMsg += "请完成当前步骤，创建或修改 `" + step.file + "`，然后运行验证命令确认无误。";

    const result = await executeOneStep(stepMsg, step, budgetPerStep);
    timeline.push({ id: step.id, file: step.file, action: step.action, ok: true, turns: result.turns, actions: result.log.slice(0, -1).join("; ") });
  }

  // ════════════════════════════════════════════
  // Phase 3: 汇总报告
  // ════════════════════════════════════════════
  var report = "# 📋 二阶段执行报告\n\n## 计划\n共 " + plan.length + " 个步骤。\n\n| 步骤 | 文件 | 状态 |\n|------|------|------|\n";
  for (const t of timeline) report += "| " + t.id + " | `" + t.file + "` | " + (t.ok ? "✅" : "❌") + " |\n";
  report += "\n**总计**: " + timeline.length + "/" + plan.length + " 步骤 · " + timeline.reduce((s, t) => s + t.turns, 0) + " 轮次 · 预算 " + Math.round(MAX_TOTAL_TOKENS/1000) + "k tokens\n";
  return { type: "text", text: report };
}

// 原始单循环执行（规划失败时的降级方案）
async function executeLegacy(taskMsg) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not set.");
  const sysPrompt = await loadPrompt();
  var messages = [{ role: "system", content: sysPrompt }, { role: "user", content: taskMsg }];
  var toolCallLog = [];

  for (var turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    console.error("[bridge] turn " + (turn + 1) + "/" + MAX_TOOL_TURNS);

    const response = await fetchR(DEEPSEEK_API_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        temperature: Number.isFinite(DEFAULT_TEMPERATURE) ? DEFAULT_TEMPERATURE : 0.2,
        messages: messages,
        tools: TOOLS,
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!response.ok) {
      const st = response.status;
      const body = await response.text();
      if (st === 401 || st === 403) throw new Error("Auth failed.");
      if (st === 429) throw new Error("Rate limited.");
      if (st >= 500) throw new Error("Server error.");
      throw new Error("API error: " + st);
    }

    // ---- SSE stream reader ----
    const reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var content = "";
    var tcAccum = {};
    var doneSeen = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done || doneSeen) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const parsed = parseSSE(line);
        if (!parsed) continue;
        if (parsed._done) { doneSeen = true; break; }
        if (parsed.usage) {
          usage = parsed.usage;
        }

        const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
        if (!delta) continue;
        if (delta.content) content += delta.content;
        if (delta.tool_calls) accTC(tcAccum, delta);
      }
    }

    // Flush buffer
    if (buffer.trim()) {
      const parsed = parseSSE(buffer.trim());
      if (parsed && !parsed._done && parsed.choices && parsed.choices[0] && parsed.choices[0].delta) {
        const d = parsed.choices[0].delta;
        if (d.content) content += d.content;
        if (d.tool_calls) accTC(tcAccum, d);
        if (parsed.usage) usage = parsed.usage;
      }
    }

    const toolCalls = deltasToTC(tcAccum);

    // Budget check: if cumulative tokens exceed limit, stop gracefully
    if (usage) {
      totalTokensIn += usage.prompt_tokens || 0;
      totalTokensOut += usage.completion_tokens || 0;
      const spent = totalTokensIn + totalTokensOut;
      if (spent > MAX_TOTAL_TOKENS) {
        var limitReport = content ? content.slice(0, 500) + "\n\n[budget: " + spent + " tokens exceeded " + MAX_TOTAL_TOKENS + "]" : "Budget exceeded.";
        limitReport += "\n\n---\n";
        if (toolCallLog.length) limitReport += "Actions: " + toolCallLog.join("; ") + "\n";
        limitReport += "Tokens: " + JSON.stringify({ prompt: totalTokensIn, completion: totalTokensOut, total: spent }) + "\n";
        limitReport += "Turns: " + (turn + 1) + " (budget stop)\n";
        return { type: "text", text: limitReport };
      }
    }

    if (!toolCalls.length) {
      // No tool calls -- task complete
      var report = content || "Task completed.";
      report += "\n\n---\n";
      if (toolCallLog.length) report += "Actions: " + toolCallLog.join("; ") + "\n";
      report += "Tokens: " + JSON.stringify({ prompt: totalTokensIn, completion: totalTokensOut, total: totalTokensIn + totalTokensOut }) + "\n";
      report += "Turns: " + (turn + 1) + "\n";
      console.error("[bridge] done in " + (turn + 1) + " turns");
      return { type: "text", text: report };
    }

    // Push assistant message
    messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });

    // Execute each tool call
    for (const tc of toolCalls) {
      const label = toolCallLabel(tc);
      console.error("[bridge] call: " + label);
      toolCallLog.push(label);
      const result = await execTC(tc);
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  throw new Error("Exceeded max turns (" + MAX_TOOL_TURNS + ").");
}

// =========================================================================
//  MCP SERVER
// =========================================================================

var server = new Server(
  { name: "mcp-bridge-reasonix", version: "0.16.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async function () {
  return {
    tools: [
      {
        name: "plan_task",
        description: "Phase 1: Generate a step-by-step plan for a task. " +
          "Returns JSON array of steps (id, file, action, depends_on). " +
          "Fast response (<10s). Mode: " + MODE_NAME + ".",
        inputSchema: {
          type: "object",
          properties: {
            task:    ss("Task description for planning."),
            context: ss("Optional: project context, constraints, or file excerpts."),
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
      {
        name: "execute_step",
        description: "Phase 2: Execute one step of a plan. " +
          "Creates/modifies files, runs verification. " +
          "Each call is independent and completes within timeout. " +
          "Mode: " + MODE_NAME + ".",
        inputSchema: {
          type: "object",
          properties: {
            task:    ss("Original full task description."),
            step_id: ss("Step ID (e.g. '1')."),
            file:    ss("File path to create or modify."),
            action:  ss("What to do in this step."),
            done:    ss("Comma-separated list of previously completed steps (e.g. '1,2')."),
            context: ss("Optional: additional context."),
          },
          required: ["task", "step_id", "file", "action"],
          additionalProperties: false,
        },
      },
      {
        name: "execute_task",
        description: "[推荐] 统一执行入口。自动判断任务复杂度：简单任务用单智能体，" +
          "复杂任务自动拆解为多智能体并行执行。你只需要描述需求，不用关心用哪个模式。" +
          "Mode: " + MODE_NAME + ". Budget: " + Math.round(MAX_TOTAL_TOKENS/1000) + "k tokens.",
        inputSchema: {
          type: "object",
          properties: {
            task:    ss("任务描述。自然语言即可，不需要指定用单智能体还是多智能体。"),
            context: ss("可选：约束条件、参考文件路径等。"),
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
      {
        name: "orchestrate_task",
        description: "[高级] 多智能体并行执行。强制使用多个科学家并行协作，适合明确需要多角色分工的项目。",
        inputSchema: {
          type: "object",
          properties: {
            task:    ss("Full project description."),
            context: ss("Optional: additional context or constraints."),
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
      {
        name: "improve_file",
        description: "委托 DeepSeek 修改代码。Codex 只需要描述想改什么（目标/想法），" +
          "DeepSeek 会读取文件并完成修改。不要自己直接改代码——" +
          "有任何修改意见都通过这个工具交给 DeepSeek 处理。Mode: " + MODE_NAME + ".",
        inputSchema: {
          type: "object",
          properties: {
            file:    ss("Path to the file to improve."),
            idea:    ss("What to improve or change. Describe the goal, not the implementation."),
            context: ss("Optional: additional context, constraints, or examples."),
          },
          required: ["file", "idea"],
          additionalProperties: false,
        },
      },
      {
        name: "delegate_to_reasonix",
        description: "[Legacy] Full task execution in one call. " +
          "Auto plan + execute. May timeout on large tasks. " +
          "Mode: " + MODE_NAME + ". Budget: " + Math.round(MAX_TOTAL_TOKENS/1000) + "k tokens.",
        inputSchema: {
          type: "object",
          properties: {
            task:    ss("Task for Reasonix to execute."),
            context: ss("Optional: project context."),
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async function (req) {
  const a = req.params.arguments || {};
  const task = reqS(a.task, "task");

  switch (req.params.name) {
    case "plan_task": {
      const ctx = optS(a.context);
      console.error("[plan] planning: " + task.slice(0, 80) + "...");
      try {
        const planText = await callDeepSeekText(PLANNING_PROMPT, buildMsg(task, ctx), 8000);
        const clean = planText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        JSON.parse(clean); // validate
        return { content: [{ type: "text", text: clean }] };
      } catch (e) {
        return { content: [{ type: "text", text: "Planning failed: " + e.message }], isError: true };
      }
    }

    case "execute_step": {
      const stepId = reqS(a.step_id, "step_id");
      const file = reqS(a.file, "file");
      const action = reqS(a.action, "action");
      const doneList = optS(a.done) || "";
      const ctx = optS(a.context);

      var stepMsg = "## 任务\n" + task + "\n\n## 当前步骤\n- 步骤 " + stepId + "\n- 文件: " + file + "\n- 做什么: " + action + "\n\n";
      if (doneList) {
        stepMsg += "## 已完成的前置步骤\n" + doneList.split(",").map(s => "- Step " + s.trim()).join("\n") + "\n\n";
      }
      stepMsg += "请完成当前步骤，创建或修改 `" + file + "`，然后运行验证命令确认无误。";

      console.error("[execute] step " + stepId + ": " + file);
      try {
        const result = await executeOneStep(stepMsg, { id: parseInt(stepId), file: file, action: action }, Math.floor(MAX_TOTAL_TOKENS / 10));
        var report = "## Step " + stepId + " 结果\n\n";
        report += "- 文件: `" + file + "`\n";
        report += "- 状态: " + (result.ok ? "✅" : "❌") + "\n";
        report += "- 轮次: " + result.turns + "\n";
        if (result.content) report += "- 输出: " + result.content + "\n";
        if (result.log.length) report += "- 操作: " + result.log.join("; ") + "\n";
        return { content: [{ type: "text", text: report }] };
      } catch (e) {
        return { content: [{ type: "text", text: "Step " + stepId + " failed: " + e.message }], isError: true };
      }
    }

    case "execute_task": {
      // 统一入口：自动判断复杂度，选择合适的执行模式
      const execCtx = optS(a.context) || "";
      console.error("[exec] auto-detect: " + task.slice(0, 80) + "...");

      // 先尝试拆解看任务复杂度
      var complexityPlan;
      try {
        var raw = await callDeepSeekText(
          "分析下面的任务复杂度。考虑两个维度：\n" +
          "1. 跨领域：是否涉及多个专业领域（后端+前端、程序+数据库、开发+测试等）\n" +
          "2. 单领域深度：是否在一个领域内有多个独立功能模块（比如后端包含：认证 + CRUD + 文件上传 + 日志，每个都可拆成独立子任务）\n\n" +
          "返回 JSON：\n" +
          "- {\"mode\":\"single\"} = 简单任务：1~2个小文件，单一功能点\n" +
          "- {\"mode\":\"multi\"} = 复杂任务：涉及跨领域合作，或单领域内包含3个以上独立模块\n\n" +
          "只返回 JSON，不要其他文字。\n\n任务：" + task,
          execCtx || "分析任务复杂度", 2000
        );
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        complexityPlan = JSON.parse(raw);
      } catch (_) { complexityPlan = { mode: "multi" }; } // 解析失败就走多智能体，更稳妥

      console.error("[exec] 判定: " + complexityPlan.mode);

      if (complexityPlan.mode === "single") {
        // 简单任务 → 单智能体直行
        console.error("[exec] 单智能体模式");
        const stepMsg = "## 任务\n" + task + "\n\n请完成上述任务，创建或修改必要的文件，然后运行验证命令确认无误。\n";
        const result = await executeOneStep(stepMsg, { id: 1, file: "项目", action: task }, MAX_TOTAL_TOKENS);
        return {
          content: [{
            type: "text",
            text: "## ✅ 执行完成\n\n- 模式：单智能体\n- 轮次：" + result.turns + "\n- 摘要：" + (result.content || "").slice(0, 500) + "\n"
          }]
        };
      } else {
        // 复杂任务 → 多智能体并行
        console.error("[exec] 多智能体模式");
        return await handleOrchestrate(task, execCtx);
      }
    }

    case "orchestrate_task": {
      const ctx = optS(a.context) || "";
      return await handleOrchestrate(task, ctx);
    }

    // ═══════════════════════════════════════════════════════════════
    //  handleOrchestrate v2 — ①进度 ②增量 ③动态预算 ④智能体通信
    // ═══════════════════════════════════════════════════════════════
    async function handleOrchestrate(task, ctx) {
      const startTime = Date.now();
      console.error("[progress] 🚀 开始:" + task.slice(0, 60) + "...");

      // ── Step 1：拆解 + 进度 ──
      console.error("[progress] 📋 拆解任务...");
      var planText;
      try {
        planText = await callDeepSeekText(ORCHESTRATOR_PROMPT, buildMsg(task, ctx), 8000);
        planText = planText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      } catch (e) { return { content: [{ type: "text", text: "Planning: " + e.message }], isError: true }; }

      var subTasks;
      try { subTasks = JSON.parse(planText); if (!Array.isArray(subTasks)) throw new Error(""); }
      catch (e) { return { content: [{ type: "text", text: "Bad plan JSON:\n" + planText.slice(0, 300) }], isError: true }; }

      if (subTasks.length > 12) subTasks = subTasks.slice(0, 12);

      // 深度拆解
      var allSubTasks = [];
      for (var si = 0; si < subTasks.length; si++) {
        const st = subTasks[si];
        if ((st.files || []).length > 3) {
          console.error("[progress] 🔄 " + (SCIENTIST[st.role] || "") + " 再拆...");
          try {
            var sp = await callDeepSeekText(ORCHESTRATOR_PROMPT, "作为" + (SCIENTIST[st.role] || "") + ":" + st.action + "\n文件:" + (st.files||[]).join(", "), 5000);
            var st2 = JSON.parse(sp.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim());
            if (Array.isArray(st2) && st2.length > 0) {
              var room = 12 - allSubTasks.length - (subTasks.length - si - 1);
              for (var j = 0; j < Math.min(st2.length, room, 4); j++) {
                allSubTasks.push({ role: st.role, action: st2[j].action||"", files: st2[j].files||[], depends_on: [], parentRole: st.role, suffix: String.fromCharCode(65+j), label: (SCIENTIST[st.role]||"") + "-" + String.fromCharCode(65+j) });
              }
              continue;
            }
          } catch (_) {}
        }
        allSubTasks.push({ ...st, parentRole: null, suffix: "", label: SCIENTIST[st.role] || "" });
      }
      subTasks = allSubTasks;

      // 报告表头
      var done = 0, failed = 0;
      var report = "## 🔬 多智能体执行报告\n\n### 🧩 拆解\n\n";
      for (var i = 0; i < subTasks.length; i++) report += (i+1) + ". " + subTasks[i].label + " → " + (subTasks[i].action||"").slice(0,60) + "\n";
      report += "\n### 📊 执行\n\n| 科学家 | 状态 | 文件 | 轮次 | 耗时 |\n|:------:|:----:|:----:|:----:|:----:|\n";

      // 增量模式检测
      console.error("[progress] 🔍 增量检测...");
      var existingFiles = [];
      for (const st of subTasks) for (const f of (st.files||[])) { try { if (existsSync(sandboxPath(f))) existingFiles.push(f); } catch (_) {} }
      if (existingFiles.length > 0) console.error("[progress] 📁 " + existingFiles.length + " 个已存在");

      // 执行循环（含动态预算 + 智能体通信）
      var pending = subTasks.map((st,idx) => ({...st, idx}));
      var completed = [], allResults = {}, usedBudget = 0, agentContracts = [], agentStarts = {};

      while (pending.length > 0) {
        var ready = pending.filter(st => !st.depends_on || st.depends_on.length === 0 || st.depends_on.every(d => allResults[d] !== undefined));
        if (ready.length === 0) { report += "⚠️ 死锁\n\n"; break; }

        // 动态预算
        var surplus = Math.max(0, MAX_TOTAL_TOKENS - usedBudget - (pending.length - ready.length) * 50000);
        var batchBudget = Math.max(30000, Math.floor(Math.min(surplus / ready.length, MAX_TOTAL_TOKENS / subTasks.length * 1.5)));

        console.error("[progress] ▶️ " + ready.length + "/" + subTasks.length + " · " + Math.round(batchBudget/1000) + "k/个");
        for (const r of ready) { agentStarts[r.idx] = Date.now(); console.error("[progress]   ├─ " + r.label + " 开始..."); }

        var res = await Promise.all(ready.map(async (st) => {
          var scientist = SCIENTIST[st.role] || st.label;

          // 构建 prompt（增量 + 智能体通信）
          var p = "## 团队协作\n\n你的身份：" + (SCIENTIST_PROMPT[scientist] || "你是" + scientist + "。") + "\n\n## 任务\n" + (st.action||"") + "\n\n## 文件\n";
          for (const f of (st.files||[])) {
            var ex = false; try { ex = existsSync(sandboxPath(f)); } catch(_) {}
            p += "  - " + f + (ex ? " ⚠️ 已存在" : "") + "\n";
          }
          if (agentContracts.length > 0) { p += "\n## 已完成成员接口\n"; for (const c of agentContracts) p += "- " + c.agent + ": " + c.summary + "\n"; p += "请对接。\n"; }
          if (existingFiles.length > 0) p += "\n## 增量模式\n以下文件已存在，请先 read_file 再编辑，不要盲目覆盖：" + existingFiles.join(", ") + "\n";
          p += "\n完成后验证。";

          const sp = await loadPrompt();
          var msgs = [{role:"system",content:sp},{role:"user",content:p}], log = [];
          for (var t = 0; t < 10; t++) {
            const r2 = await fetchR(DEEPSEEK_API_URL, {method:"POST", headers:{Authorization:"Bearer "+process.env.DEEPSEEK_API_KEY,"Content-Type":"application/json"}, body:JSON.stringify({model:DEFAULT_MODEL,temperature:0.2,messages:msgs,tools:TOOLS,tool_choice:"auto",stream:true,stream_options:{include_usage:true}})});
            const reader = r2.body.getReader(); var dec = new TextDecoder(), buf = "", con = "", tcA = {}, ds = false;
            while (true) { const {done,value} = await reader.read(); if(done||ds) break; buf += dec.decode(value,{stream:true}); const ls = buf.split("\n"); buf = ls.pop()||""; for(const l of ls) { const p2 = parseSSE(l); if(!p2) continue; if(p2._done){ds=true;break} const d=p2.choices?.[0]?.delta; if(!d) continue; if(d.content) con+=d.content; if(d.tool_calls) accTC(tcA,d); } }
            const tcs = deltasToTC(tcA);
            if (!tcs.length) { var contract = (con||"").slice(0,200); var el = Math.round((Date.now()-(agentStarts[st.idx]||Date.now()))/1000); console.error("[progress]   └─ " + scientist + " ✅ "+(t+1)+"轮 "+el+"s"); return {ok:true,agent:scientist,idx:st.idx,files:st.files||[],turns:t+1,contract:contract,log}; }
            msgs.push({role:"assistant",content:con||null,tool_calls:tcs}); for(const tc of tcs) { const lb = toolCallLabel(tc); log.push(lb); const r3 = await execTC(tc); msgs.push({role:"tool",tool_call_id:tc.id,content:JSON.stringify(r3)}); }
          }
          console.error("[progress]   └─ " + scientist + " ⚠️ 超时"); return {ok:false,agent:scientist,idx:st.idx,files:st.files||[],contract:"",log:[]};
        }));

        for (const r of res) {
          if (r.ok) done++; else failed++;
          if (r.contract && r.contract.length > 10) agentContracts.push({agent:r.agent, summary:r.contract});
          allResults[r.idx] = r; pending = pending.filter(st => st.idx !== r.idx); completed.push(subTasks[r.idx]);
          usedBudget += batchBudget;
          var el = Math.round((Date.now()-(agentStarts[r.idx]||Date.now()))/1000);
          report += "| " + r.agent + " | " + (r.ok?"✅":"⚠️") + " | " + (r.files||[]).length + " | " + (r.turns||0) + " | " + el + "s |\n";
          console.error("[progress] 📊 " + done + "/" + subTasks.length + " · " + Math.round((Date.now()-startTime)/1000) + "s");
        }
      }

      var totalTime = Math.round((Date.now()-startTime)/1000);
      report += "\n**总计**: " + subTasks.length + " · " + done + "✅" + (failed>0?" "+failed+"⚠️":"") + " · " + totalTime + "s\n";
      console.error("[progress] ✅ " + totalTime + "s");
      return { content: [{ type: "text", text: report }] };
    }

    case "improve_file": {
      const file = reqS(a.file, "file");
      const idea = reqS(a.idea, "idea");
      const ctx = optS(a.context) || "";
      console.error("[improve] " + file + ": " + idea.slice(0, 80));

      try {
        // 读取当前文件内容
        var fileContent = "(file does not exist yet)";
        try {
          const fp = sandboxPath(file);
          fileContent = await readFile(fp, "utf8").slice(0, MAX_FILE_SIZE);
        } catch (_) {}

        // CodeX 提目标/想法，DeepSeek 负责实现
        var fixMsg = "## 改进任务\n\n";
        fixMsg += "**文件**: `" + file + "`\n\n";
        fixMsg += "**改进思路**: " + idea + "\n\n";
        if (ctx) fixMsg += "**附加上下文**: " + ctx + "\n\n";
        fixMsg += "**当前文件内容**:\n```\n" + fileContent + "\n```\n\n";
        fixMsg += "请根据上述改进思路修改文件。可以使用 edit_file 做局部修改，或 write_file 重写。修改后运行验证命令确认无误。";

        const sysPrompt = await loadPrompt();
        var msgs = [
          { role: "system", content: sysPrompt },
          { role: "user", content: fixMsg },
        ];

        // 最多 8 轮修复循环
        var log = [];
        for (var turn = 0; turn < 8; turn++) {
          console.error("[fix] turn " + (turn + 1));
          const response = await fetchR(DEEPSEEK_API_URL, {
            method: "POST",
            headers: { Authorization: "Bearer " + process.env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_MODEL, temperature: 0.2,
              messages: msgs, tools: TOOLS, tool_choice: "auto",
              stream: true, stream_options: { include_usage: true },
            }),
          });

          if (!response.ok) {
            const st = response.status;
            const b = await response.text();
            if (st === 401 || st === 403) throw new Error("Auth failed.");
            if (st === 429) throw new Error("Rate limited.");
            throw new Error("API error: " + st + " " + b.slice(0, 100));
          }

          const reader = response.body.getReader();
          var decoder = new TextDecoder();
          var buffer = "";
          var content = "";
          var tcAccum = {};
          var doneSeen = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done || doneSeen) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const parsed = parseSSE(line);
              if (!parsed) continue;
              if (parsed._done) { doneSeen = true; break; }
              const delta = parsed.choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.content) content += delta.content;
              if (delta.tool_calls) accTC(tcAccum, delta);
            }
          }
          if (buffer.trim()) {
            const parsed = parseSSE(buffer.trim());
            if (parsed && parsed.choices?.[0]?.delta) {
              const d = parsed.choices[0].delta;
              if (d.content) content += d.content;
              if (d.tool_calls) accTC(tcAccum, d);
            }
          }

          const toolCalls = deltasToTC(tcAccum);
          if (!toolCalls.length) {
            console.error("[fix] done in " + (turn + 1) + " turns");
            return { content: [{ type: "text", text: "## 修复完成\n\n文件: `" + file + "`\n问题: " + issue + "\n操作: " + log.join("; ") + "\n\n" + (content || "").slice(0, 500) }] };
          }

          msgs.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
          for (const tc of toolCalls) {
            const label = toolCallLabel(tc);
            console.error("[fix] call: " + label);
            log.push(label);
            const result = await execTC(tc);
            msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
          }
        }
        return { content: [{ type: "text", text: "## 修复超时\n\n" + log.join("; ") }], isError: true };
      } catch (e) {
        return { content: [{ type: "text", text: "Fix failed: " + e.message }], isError: true };
      }
    }

    case "delegate_to_reasonix": {
      const ctx = optS(a.context);
      console.error("[bridge] legacy task: " + task.slice(0, 80) + "...");
      try { return { content: [await executeTask(task, ctx)] }; }
      catch (e) { return { content: [{ type: "text", text: "Failed: " + e.message }], isError: true }; }
    }

    default:
      throw new Error("Unknown tool: " + req.params.name);
  }
});

// =========================================================================
//  STARTUP
// =========================================================================

await server.connect(new StdioServerTransport());
console.error("");
console.error("====================================================================");
console.error("  mcp-bridge-reasonix v0.16.0  [2-phase execution + plan/execute/summary]");
console.error("  workspace: " + WORKSPACE_ROOT + "  mode: " + MODE_NAME + " (lvl:" + modeLevel + ")");
console.error("  cmds:" + allowCommands + " write:" + allowWrite + " verify:" + allowVerify);
console.error("");
console.error("  WARNING: subprocesses bypass the file sandbox.");
console.error("  static  : no package scripts -- static tools only");
console.error("  verify  : static + npm test, eslint, jest (runs project scripts)");
console.error("  full    : allowlisted cmds unrestricted, writes enabled");
console.error("  git     : available in static+ (not in readonly)");
console.error("  budget  : " + Math.round(MAX_TOTAL_TOKENS/1000) + "k tokens  |  plan: auto");
console.error("====================================================================");
console.error("");
