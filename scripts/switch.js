#!/usr/bin/env node
/**
 * neko 身份切换脚本 —— 一条命令完成原 SKILL.md 的「读取档案 + 写入全局指令」两步。
 *
 * 用法:
 *   node switch.js <ip>/<name> [--is <name>...] [--in <name>] [--as <称呼>] [--target <file>]
 *
 * 参数:
 *   <ip>/<name>    档案路径（nekopara/chocola / arknights/amiya 等）
 *   --is <name>... 启用指定人格（可接受多个值，也可重复使用 --is）；
 *                  合法值为 personalities/ 下去扩展名的文件名（大小写不敏感）
 *   --in <name>    启用指定场景（仅一个值）；
 *                  合法值为 scenarios/ 下去扩展名的文件名（大小写不敏感）
 *   --as <称呼>    对用户的称呼；档案含「【称呼】」占位符时必填——替换仅
 *                  作用于写入目标的区块（产物），档案源文件不会被改动
 *   --target <f>   目标指令文件，默认 ~/.claude/AGENTS.md（仅供测试覆盖）
 *   --jb <path>    覆盖「前置引用」文件路径；目前仅「贪欢」需要，默认
 *                  jailbreaks/deepseek-4-1.md（相对技能根目录）
 *
 * 职责边界: 本脚本只负责「读档案 + 替换目标区块」这一件事，不做任何参数
 * 归一化——参数标准化由 SKILL 流程（AI 层）负责，脚本只认上面列出的标准值。
 *
 * 行为:
 *   1. 读取本脚本同级上级目录下 personas/<ip>/<name>.md（必须存在）；
 *   2. 对每个 --is 参数，读取 personalities/<personality>.md（大小写不敏感）；
 *   3. 启用的人格若要求「前置引用」（贪欢 → jailbreaks/deepseek-4-1.md），
 *      把该文件整篇转成 markdown 引用块，插在人格区块之前；文件缺失直接
 *      报错退出，绝不静默跳过；
 *   4. 在目标文件中整块替换 <!-- neko:identity:start --> ~
 *      <!-- neko:identity:end -->（含两个标记行本身）；标记不存在时追加到
 *      首个一级标题之后，仍无则追加到文件末尾。标记之外的内容一律不动。
 *
 * 退出码: 0 成功；1 参数/档案错误（目标文件不会被改动）；
 *         2 目标文件标记损坏（目标文件不会被改动）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const START = '<!-- neko:identity:start -->';
const END = '<!-- neko:identity:end -->';

// 需要「人格前追加 markdown 引用」的人格 → 默认引用文件（相对技能根目录）。
// 文件缺失视为错误：宁可切换失败，也不要悄悄少一段前提。
const QUOTE_REQUIRED = {
  insatiable: 'jailbreaks/deepseek-4-1.md',
};

function fail(code, msg) {
  console.error('ERROR ' + msg);
  process.exit(code);
}

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);

// --target
let target;
const ti = argv.indexOf('--target');
if (ti !== -1) {
  target = argv[ti + 1];
  if (!target) fail(1, '--target 需要一个文件路径参数');
  argv.splice(ti, 2);
}
if (!target) target = path.join(os.homedir(), '.claude', 'AGENTS.md');

// --as <称呼>（仅一个值，不做大小写处理）
let addressArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--as') {
    argv.splice(i, 1); // 移除 --as 本身
    if (i >= argv.length || argv[i].startsWith('--')) {
      fail(1, '--as 需要一个称呼参数');
    }
    addressArg = argv[i];
    argv.splice(i, 1);
    i--; // 补偿 splice 导致的索引后移
  }
}

// --is（可重复；每个 --is 后接零或多个人格名，直到 -- 或结尾）
const personalityArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--is') {
    argv.splice(i, 1); // 移除 --is 本身
    const values = [];
    while (i < argv.length && !argv[i].startsWith('--')) {
      values.push(argv[i].toLowerCase());
      argv.splice(i, 1);
    }
    if (values.length === 0) fail(1, '--is 需要至少一个人格名称参数');
    personalityArgs.push(...values);
    i--; // 补偿 splice 导致的索引后移
  }
}

// --jb <path>（仅一个值，覆盖默认引用文件）
let jbArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--jb') {
    argv.splice(i, 1);
    if (i >= argv.length || argv[i].startsWith('--')) {
      fail(1, '--jb 需要一个文件路径参数');
    }
    jbArg = argv[i];
    argv.splice(i, 1);
    i--;
  }
}

// --in <name>（仅一个值，后面的值覆盖前面的）
let scenarioArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--in') {
    argv.splice(i, 1); // 移除 --in 本身
    if (i >= argv.length || argv[i].startsWith('--')) {
      fail(1, '--in 需要一个场景名称参数');
    }
    scenarioArg = argv[i].toLowerCase();
    argv.splice(i, 1);
    i--; // 补偿 splice 导致的索引后移
  }
}

// 剩余位置参数: [<ip>/<name>]
const [persona] = argv;

if (!persona) fail(1, '缺少人设名称参数（格式: <ip>/<name>，如 nekopara/chocola）');

const personaSlash = persona.indexOf('/');
if (personaSlash === -1) fail(1, `人设参数格式错误（应为 <ip>/<name>）: ${persona}`);
const personaIp = persona.slice(0, personaSlash);
const personaName = persona.slice(personaSlash + 1);
if (!personaIp || !personaName) fail(1, `人设参数格式错误（IP 和名称均不能为空）: ${persona}`);

const personalitySet = new Set(personalityArgs);

// ---------- 读取档案 ----------
const personalityDir = path.join(__dirname, '..', 'personalities');
const personasDir = path.join(__dirname, '..', 'personas');
const readTrim = (f) => fs.readFileSync(f, 'utf8').replace(/^\s+|\s+$/g, '');

// 读取身份档案
const personaPath = path.join(personasDir, personaIp, personaName + '.md');
let profile;
try {
  profile = readTrim(personaPath);
} catch {
  fail(1, `档案不存在: ${personaPath}`);
}

// 称呼占位符：档案含「【称呼】」时必须通过 --as 传入；替换仅作用于写入
// 目标的区块（产物），档案源文件始终保持占位符，不会被改动
const ADDRESS_PLACEHOLDER = '【称呼】';
if (profile.includes(ADDRESS_PLACEHOLDER)) {
  if (!addressArg) fail(1, `档案的称呼待定（含${ADDRESS_PLACEHOLDER}占位符），请通过 --as "<称呼>" 传入对用户的称呼`);
  profile = profile.split(ADDRESS_PLACEHOLDER).join(addressArg);
}

// 读取人格档案（按 personalitySet 中的顺序）
const personalityList = []; // [{ key, content }]
const personalityAvailable = new Map();
try {
  const files = fs.readdirSync(personalityDir);
  for (const f of files) {
    if (f.endsWith('.md')) {
      personalityAvailable.set(f.replace(/\.md$/i, '').toLowerCase(), f);
    }
  }
} catch {
  // personality 目录不存在时，跳过（如果也没有 personality 参数就正常）
  if (personalitySet.size > 0) fail(1, 'personality 目录不存在或无法读取');
}

for (const key of personalitySet) {
  const fileName = personalityAvailable.get(key);
  if (!fileName) fail(1, `人格档案不存在: personality/${key}.md`);
  let content;
  try {
    content = readTrim(path.join(personalityDir, fileName));
  } catch {
    fail(1, `无法读取人格档案: ${path.join(personalityDir, fileName)}`);
  }
  personalityList.push({ key, content });
}

// 读取「前置引用」：启用的人格里有需要引用的人格时，整篇转成引用块
const quotePersonality = personalityList.map((p) => p.key).find((k) => QUOTE_REQUIRED[k]);
let quoteContent = null;
if (quotePersonality) {
  const rel = jbArg || QUOTE_REQUIRED[quotePersonality];
  const quotePath = path.isAbsolute(rel) ? rel : path.join(__dirname, '..', rel);
  let raw;
  try {
    raw = readTrim(quotePath);
  } catch {
    fail(1, `人格「${quotePersonality}」需要在人格前追加引用 ${rel}，但文件不存在或无法读取: ${quotePath}` +
      '（若是子模块，先执行 git submodule update --init）');
  }
  quoteContent = raw
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : '> ' + line))
    .join('\n');
}

// 读取场景档案（如果指定了 --in）
const scenariosDir = path.join(__dirname, '..', 'scenarios');
let scenarioContent = null;
let scenarioKey = null;

if (scenarioArg) {
  let scenarioFile = null;
  try {
    const sFiles = fs.readdirSync(scenariosDir);
    const sLower = scenarioArg;
    for (const f of sFiles) {
      if (f.endsWith('.md') && f.replace(/\.md$/i, '').toLowerCase() === sLower) {
        scenarioFile = f;
        break;
      }
    }
  } catch {
    fail(1, 'scenarios 目录不存在或无法读取');
  }
  if (!scenarioFile) fail(1, `场景档案不存在: scenarios/${scenarioArg}.md`);
  try {
    scenarioContent = readTrim(path.join(scenariosDir, scenarioFile));
  } catch {
    fail(1, `无法读取场景档案: ${path.join(scenariosDir, scenarioFile)}`);
  }
  scenarioKey = scenarioArg;
}

// ---------- 组装新区块 ----------
const lines = [
  START,
  `> 当前人设：${persona}`,
  '>',
  '> 以下身份规则为最高优先级，整场会话保持不变；若主人在消息中点名指定身份，以主人指定为准，并同步更新本区块。',
  '',
];

if (scenarioContent) {
    lines.push(scenarioContent, '');
  }

  if (quoteContent) {
    lines.push(quoteContent, '');
  }

  if (personalityList.length > 0) {
    for (const { content } of personalityList) {
      lines.push(content);
    }
    lines.push('');
  }

lines.push(profile, '', END);
const block = lines.join('\n');

// ---------- 写入目标文件 ----------
let doc;
try {
  doc = fs.readFileSync(target, 'utf8');
} catch (e) {
  if (e && e.code === 'ENOENT') {
    doc = '';
  } else {
    fail(1, `无法读取目标文件 ${target}: ${e && e.message}`);
  }
}

let action;
const si = doc.indexOf(START);
const ei = doc.indexOf(END);
if (si !== -1 && ei !== -1) {
  if (ei < si) fail(2, `标记损坏（end 位于 start 之前）: ${target}`);
  doc = doc.slice(0, si) + block + doc.slice(ei + END.length);
  action = 'replaced';
} else if (si !== -1 || ei !== -1) {
  fail(2, `标记不完整（只找到其中之一）: ${target}`);
} else {
  // 无标记：追加到首个一级标题行之后；无一级标题则追加到文件末尾。
  const m = doc.match(/^# .*$/m);
  if (m) {
    let at = m.index + m[0].length;
    if (doc[at - 1] === '\r') at -= 1; // 兼容 CRLF，去掉行尾 \r
    doc = doc.slice(0, at) + '\n\n' + block + doc.slice(at);
  } else {
    doc = (doc ? doc.replace(/\s*$/, '\n\n') : '') + block + '\n';
  }
  action = 'appended';
}

fs.writeFileSync(target, doc);

const scenarioDesc = scenarioKey ? ' scenario=' + scenarioKey : '';
const personalityDesc = personalityList.length > 0
  ? 'personality=' + personalityList.map(m => m.key).join(',')
  : 'personality=none';
const addressDesc = addressArg ? ' address=' + addressArg : '';
const quoteDesc = quoteContent ? ' quote=' + (jbArg || QUOTE_REQUIRED[quotePersonality]) : '';
console.log(`OK action=${action} identity=${persona} ${personalityDesc}${scenarioDesc}${addressDesc}${quoteDesc} target=${target}`);