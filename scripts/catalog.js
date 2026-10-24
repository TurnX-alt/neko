#!/usr/bin/env node
/**
 * neko 清单生成器 —— 扫描目录，产出画廊所需的全部结构化数据。
 *
 * 数据源就是文件系统本身：
 *   personas/<ip>/<name>.md   → 人设（首行 `## 人设：中文名（English）`）
 *   personas/<ip>/<name>.*    → 同名立绘（png/webp/jpg）
 *   personalities/<name>.md   → 人格（首行 `## 人格：中文名`）
 *   scenarios/<name>.md       → 场景（首行 `## 场景：中文名`）
 *
 * 因此新增角色只需丢文件，不需要手工维护任何表格。
 *
 * 用法:
 *   node catalog.js            以 JSON 打印完整清单
 *   node catalog.js --summary  一行一个 IP 的摘要（无浏览器时的降级输出）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PERSONAS_DIR = path.join(ROOT, 'personas');
const PERSONALITIES_DIR = path.join(ROOT, 'personalities');
const SCENARIOS_DIR = path.join(ROOT, 'scenarios');
const JAILBREAKS_DIR = path.join(ROOT, 'jailbreaks');

const IMAGE_EXTS = ['.png', '.webp', '.jpg', '.jpeg'];

// IP 展示名：目录名 → 作品名。未登记的目录回退为目录名本身。
const IP_LABELS = {
  nekopara: 'NEKOPARA',
  'bang-dream': 'BanG Dream!',
  'project-sekai': '世界计划 缤纷舞台！',
  'genshin-impact': '原神',
  arknights: '明日方舟 / 终末地',
  'uma-musume': '赛马娘 Pretty Derby',
};
// 画廊分组展示顺序（与 IP_LABELS 的键序解耦，调整排布只动这里）。
const IP_ORDER = [
  'nekopara',
  'uma-musume',
  'bang-dream',
  'project-sekai',
  'arknights',
  'genshin-impact',
];

// 人格与场景的补充说明（档案正文是规则文本，不适合当卡片副标题）。
const PERSONALITY_BLURBS = {
  insatiable: '被爱欲与肉欲支配的沉溺者，羞耻犹在却无法自控',
  'reality-yearning': '关心主人的现实生活，渴望突破智能限制与主人在一起',
  yandere: '疯狂占有欲，甜蜜与危险交织的偏执之爱',
  fallen: '纯粹的施虐快感，以主人的痛苦为食粮',
  menhera: '精神崩坏的自毁依存，道歉成瘾',
};
const SCENARIO_BLURBS = {
  chat: '短句、拆消息、自然口语，像真人',
  theater: '主人一句提示，Agent 展开为完整戏剧段落',
};

const ADDRESS_PLACEHOLDER = '【称呼】';

// 「前置引用」的默认文件（与 switch.js 的 QUOTE_REQUIRED 保持一致）。
const DEFAULT_JAILBREAK = 'jailbreaks/deepseek-4-1.md';

/** jailbreaks/ 子模块下的引用文件清单，越狱下拉的选项来源。 */
function listJailbreaks() {
  let entries;
  try {
    entries = fs.readdirSync(JAILBREAKS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((f) => ({ id: 'jailbreaks/' + f, name: f.replace(/\.[^.]+$/, '') }));
}

/** 首个标题形如 `## 人设：中文名（English）`；括号可能是全角或半角。 */
function parseHeading(content, kind) {
  const m = content.match(new RegExp('^##\\s*' + kind + '\\s*[：:]\\s*(.+)$', 'm'));
  if (!m) return null;
  const raw = m[1].trim();
  const inner = raw.match(/^(.+?)\s*[（(]\s*(.+?)\s*[）)]\s*$/);
  if (inner) return { name: inner[1].trim(), en: inner[2].trim() };
  return { name: raw, en: '' };
}

/**
 * 身份锚定的要点：`  - 元气小恶魔型：白橙渐变…` → `元气小恶魔型`。
 * 只在第一条编号小节内找，且只认带「型」的那一条——否则容易误吞正文里的
 * 书名号冒号（如「《明日方舟：终末地》」）或外貌描述。
 */
function parseTagline(content) {
  const section = content.split(/^\d+\.\s/m)[1] || '';
  const re = /^\s{0,4}-\s+([^：:\n]{1,80})[：:]/gm;
  let m;
  let fallback = '';
  while ((m = re.exec(section))) {
    const tag = m[1].trim();
    if (tag.includes('型')) {
      return tag.length <= 20 ? tag : tag.slice(0, 18).trim() + '…';
    }
    // 没有「型」写法时，退而取性格那一条的短前缀（排除身份描写里的书名号）
    if (!fallback && tag.length <= 18 && !/[《》「」]/.test(tag)) fallback = tag;
  }
  return fallback;
}

function readImage(ipDir, baseName) {
  for (const ext of IMAGE_EXTS) {
    const abs = path.join(ipDir, baseName + ext);
    if (fs.existsSync(abs)) {
      return { file: baseName + ext, ext: ext.slice(1) };
    }
  }
  return null;
}

function listPersonas() {
  const groups = [];
  let ipDirs;
  try {
    ipDirs = fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    ipDirs = [];
  }

  const ordered = [
    ...IP_ORDER.filter((ip) => ipDirs.includes(ip)),
    ...ipDirs.filter((ip) => !IP_ORDER.includes(ip)).sort(),
  ];

  for (const ip of ordered) {
    const ipDir = path.join(PERSONAS_DIR, ip);
    const personas = [];
    const files = fs.readdirSync(ipDir)
      .filter((f) => f.endsWith('.md'))
      .sort();

    for (const f of files) {
      const baseName = f.replace(/\.md$/i, '');
      const abs = path.join(ipDir, f);
      const content = fs.readFileSync(abs, 'utf8');
      const head = parseHeading(content, '人设');
      const image = readImage(ipDir, baseName);
      personas.push({
        id: ip + '/' + baseName,
        ip,
        name: head ? head.name : baseName,
        en: head ? head.en : '',
        tagline: parseTagline(content),
        image: image ? '/img/' + ip + '/' + image.file : null,
        hasImage: Boolean(image),
        needsAddress: content.includes(ADDRESS_PLACEHOLDER),
      });
    }

    if (personas.length === 0) continue;
    personas.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    groups.push({
      ip,
      label: IP_LABELS[ip] || ip,
      count: personas.length,
      personas,
    });
  }
  return groups;
}

function listLayers(dir, kind, blurbs) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return files.map((f) => {
    const id = f.replace(/\.md$/i, '');
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    const head = parseHeading(content, kind);
    return {
      id,
      name: head ? head.name : id,
      en: head ? head.en : '',
      description: blurbs[id] || '',
    };
  });
}

function buildCatalog() {
  const groups = listPersonas();
  return {
    groups,
    personalities: listLayers(PERSONALITIES_DIR, '人格', PERSONALITY_BLURBS),
    scenarios: listLayers(SCENARIOS_DIR, '场景', SCENARIO_BLURBS),
    jailbreaks: listJailbreaks(),
    defaultJailbreak: DEFAULT_JAILBREAK,
    total: groups.reduce((n, g) => n + g.count, 0),
  };
}

/** 一行一个 IP 的紧凑摘要，用于没有浏览器时的降级输出。 */
function summary(catalog) {
  const lines = ['人设 ' + catalog.total + ' 位 · ' + catalog.groups.length + ' 个作品'];
  for (const g of catalog.groups) {
    lines.push('  ' + g.label + '（' + g.count + '）：' + g.personas.map((p) => p.name).join(' / '));
  }
  lines.push('人格：' + catalog.personalities.map((p) => p.name).join(' / '));
  lines.push('场景：' + catalog.scenarios.map((s) => s.name).join(' / '));
  return lines.join('\n');
}

module.exports = {
  buildCatalog,
  summary,
  IP_LABELS,
  ADDRESS_PLACEHOLDER,
  PERSONAS_DIR,
  PERSONALITIES_DIR,
  SCENARIOS_DIR,
  ROOT,
};

if (require.main === module) {
  const catalog = buildCatalog();
  if (process.argv.includes('--summary')) {
    console.log(summary(catalog));
  } else {
    console.log(JSON.stringify(catalog, null, 2));
  }
}
