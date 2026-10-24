#!/usr/bin/env node
/**
 * neko 画廊 —— 本地 Web 选择器。零依赖（只用 Node 内置模块）。
 *
 * 用法:
 *   node picker.js [--port <n>] [--no-open] [--target <file>] [--timeout <sec>]
 *
 * 行为:
 *   1. 扫描 personas/ personalities/ scenarios/ 生成清单（见 catalog.js）；
 *   2. 在 127.0.0.1 上起一个只读画廊，浏览器里按作品分组展示全部身份；
 *   3. 主人点选身份、勾选人格与场景后按下「确认切换」；
 *   4. 由本脚本调用 switch.js 写入目标区块，然后自行退出。
 *
 * 输出: 成功时转发 switch.js 的 `OK ...` 行；失败输出 `ERROR ...`。
 * 退出码: 0 已切换；1 运行错误；3 超时未选择。
 *
 * 安全: 仅监听回环地址；写接口要求页面注入的随机 token（防跨站表单提交）；
 *       图片路径只允许 personas/ 下的合法文件名。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const catalogLib = require('./catalog');
const { buildBlock } = require('./switch');

const SWITCH_JS = path.join(__dirname, 'switch.js');
const GALLERY_HTML = path.join(__dirname, 'gallery.html');
const BODY_LIMIT = 64 * 1024;

function parseArgs(argv) {
  const opts = {
    port: 5173,
    open: true,
    target: null,
    timeoutSec: 900,
    prefill: { persona: null, personalities: [], scenario: null },
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--timeout') opts.timeoutSec = Number(argv[++i]);
    else if (a === '--prefill-persona') opts.prefill.persona = argv[++i];
    else if (a === '--prefill-personality') opts.prefill.personalities.push(argv[++i]);
    else if (a === '--prefill-scenario') opts.prefill.scenario = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('用法: node picker.js [--port <n>] [--no-open] [--target <file>] [--timeout <sec>]');
      console.log('       [--prefill-persona <id>] [--prefill-personality <id> ...] [--prefill-scenario <id>]');
      process.exit(0);
    } else {
      console.error('ERROR 未知参数: ' + a);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error('ERROR --port 需要 0-65535 的整数');
    process.exit(1);
  }
  if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0) {
    console.error('ERROR --timeout 需要正数秒');
    process.exit(1);
  }
  return opts;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 打不开浏览器不是致命错误：URL 已经打印在终端里。
  }
}

/** 立绘文件名白名单：只允许 <ip>/<name>.<ext>，且必须真实存在于 personas/ 下。 */
function resolveImage(rel) {
  const m = rel.match(/^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\.(png|webp|jpg|jpeg)$/i);
  if (!m) return null;
  const abs = path.join(catalogLib.PERSONAS_DIR, m[1], m[2] + '.' + m[3].toLowerCase());
  const root = catalogLib.PERSONAS_DIR + path.sep;
  if (!path.resolve(abs).startsWith(root)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

const MIME = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/**
 * 启动画廊服务。
 * @returns {Promise<{port:number,url:string,token:string,close:()=>void,done:Promise<any>}>}
 */
function createGallery(options = {}) {
  const opts = {
    port: 5173,
    open: false,
    target: null,
    timeoutSec: 900,
    prefill: {},
    ...options,
  };

  const catalog = catalogLib.buildCatalog();
  const personaIndex = new Map();
  for (const g of catalog.groups) {
    for (const p of g.personas) personaIndex.set(p.id, p);
  }
  const personalityIds = new Set(catalog.personalities.map((p) => p.id));
  const scenarioIds = new Set(catalog.scenarios.map((s) => s.id));
  const jailbreakIds = new Set(catalog.jailbreaks.map((j) => j.id));

  // 预填：把已经识别出来的人格/场景/人设带进画廊（非法值静默丢弃）
  const wanted = opts.prefill || {};
  catalog.prefill = {
    persona: wanted.persona && personaIndex.has(wanted.persona) ? wanted.persona : null,
    personalities: (wanted.personalities || []).filter((id) => personalityIds.has(id)),
    scenario: wanted.scenario && scenarioIds.has(wanted.scenario) ? wanted.scenario : null,
  };

  const token = crypto.randomBytes(16).toString('hex');
  let settled = false;
  let timer = null;
  let server = null;

  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  function finish(result) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveDone(result);
    setTimeout(() => {
      try { server && server.close(); } catch {}
    }, 400);
  }

  /** 校验选人请求体，返回 { status, body }；通过时 body 含 persona/personalities/scenario/jb/address。 */
  function validateSelection(body) {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return { status: 400, body: { error: '请求体不是合法 JSON' } };
    }
    const persona = personaIndex.get(payload.persona);
    if (!persona) return { status: 400, body: { error: '未知的人设: ' + payload.persona } };

    const personalities = Array.isArray(payload.personalities) ? payload.personalities : [];
    for (const p of personalities) {
      if (!personalityIds.has(p)) return { status: 400, body: { error: '未知的人格: ' + p } };
    }
    const scenario = payload.scenario || null;
    if (scenario && !scenarioIds.has(scenario)) {
      return { status: 400, body: { error: '未知的场景: ' + scenario } };
    }
    // 「不启用」（off）与未选择等价：不向 switch.js 传任何 --jb
    const jb = payload.jb && payload.jb !== 'off' ? String(payload.jb) : null;
    if (jb && !jailbreakIds.has(jb)) {
      return { status: 400, body: { error: '未知的越狱引用: ' + jb } };
    }
    const address = typeof payload.address === 'string' ? payload.address.trim() : '';
    return { status: 200, body: { persona, personalities, scenario, jb, address } };
  }

  function handleSelect(body) {
    const checked = validateSelection(body);
    if (checked.status !== 200) return checked;
    const sel = checked.body;
    if (sel.persona.needsAddress && !sel.address) {
      return { status: 400, body: { error: '该人设的称呼待定，请先填写称呼', code: 'ADDRESS_REQUIRED' } };
    }
    return { status: 200, body: { ok: true, persona: sel.persona, personalities: sel.personalities, scenario: sel.scenario, jb: sel.jb, address: sel.address } };
  }

  function runSwitch(selection) {
    return new Promise((resolve) => {
      const args = [SWITCH_JS, selection.persona.id];
      if (selection.personalities.length > 0) {
        args.push('--is', ...selection.personalities);
      }
      if (selection.scenario) args.push('--in', selection.scenario);
      if (selection.jb) args.push('--jb', selection.jb);
      if (selection.address) args.push('--as', selection.address);
      if (opts.target) args.push('--target', opts.target);

      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => resolve({ code: 1, stdout, stderr: String(e && e.message) }));
      child.on('close', (code) => resolve({ code: code == null ? 1 : code, stdout, stderr }));
    });
  }

  function buildServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        let html;
        try {
          html = fs.readFileSync(GALLERY_HTML, 'utf8');
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('gallery.html 缺失: ' + e.message);
        }
        html = html.replace('__NEKO_TOKEN__', token);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
        });
        return res.end(html);
      }

      if (req.method === 'GET' && pathname === '/api/catalog') {
        return sendJson(res, 200, catalog);
      }

      // 预览：与 /api/select 同一套校验，但不要求称呼、不落盘，
      // 返回 switch.js 将写入的区块全文（buildBlock 共用实现）
      if (req.method === 'POST' && pathname === '/api/preview') {
        if (req.headers['x-neko-token'] !== token) {
          return sendJson(res, 403, { error: 'token 校验失败' });
        }
        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          return sendJson(res, 413, { error: e.message });
        }
        const checked = validateSelection(body);
        if (checked.status !== 200) return sendJson(res, checked.status, checked.body);
        const sel = checked.body;
        try {
          const preview = buildBlock({
            persona: sel.persona.id,
            personalities: sel.personalities,
            scenario: sel.scenario,
            address: sel.address || null,
            allowMissingAddress: true,
            jb: sel.jb,
          }).block;
          return sendJson(res, 200, { ok: true, preview });
        } catch (e) {
          return sendJson(res, 422, { error: e.message });
        }
      }

      if (req.method === 'GET' && pathname.startsWith('/img/')) {
        const abs = resolveImage(pathname.slice('/img/'.length));
        if (!abs) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('not found');
        }
        const ext = abs.split('.').pop().toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
        });
        return fs.createReadStream(abs).pipe(res);
      }

      if (req.method === 'POST' && pathname === '/api/select') {
        if (req.headers['x-neko-token'] !== token) {
          return sendJson(res, 403, { error: 'token 校验失败' });
        }
        if (settled) return sendJson(res, 409, { error: '本次画廊已结束' });

        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          return sendJson(res, 413, { error: e.message });
        }
        const checked = handleSelect(body);
        if (checked.status !== 200) return sendJson(res, checked.status, checked.body);

        const result = await runSwitch(checked.body);
        if (result.code !== 0) {
          return sendJson(res, 422, {
            error: (result.stderr || 'switch.js 执行失败').trim(),
            output: result.stdout.trim(),
          });
        }
        const line = result.stdout.trim();
        console.log(line);
        sendJson(res, 200, { ok: true, output: line, persona: checked.body.persona.id });
        finish({ ok: true, output: line, persona: checked.body.persona.id });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
  }

  return new Promise((resolve, reject) => {
    server = buildServer();

    server.on('error', (err) => {
      // 端口被占用时回退到随机端口，不打断流程。
      if (err.code === 'EADDRINUSE' && opts.port !== 0) {
        server.close();
        server = buildServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ ...handleListen(), fellBack: true }));
        return;
      }
      reject(err);
    });

    server.listen(opts.port, '127.0.0.1', () => resolve(handleListen()));
  });

  function handleListen() {
    const port = server.address().port;
    const url = 'http://127.0.0.1:' + port + '/';
    timer = setTimeout(() => {
      if (settled) return;
      console.error('ERROR timeout 画廊在 ' + opts.timeoutSec + ' 秒内没有被选择，已关闭');
      finish({ ok: false, timeout: true });
    }, opts.timeoutSec * 1000);
    if (opts.open) openBrowser(url);
    return {
      port,
      url,
      token,
      close: () => { finish({ ok: false, closed: true }); },
      done,
      catalog,
    };
  }
}

module.exports = { createGallery, parseArgs };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  createGallery({
    port: opts.port,
    open: opts.open,
    target: opts.target,
    timeoutSec: opts.timeoutSec,
    prefill: opts.prefill,
  }).then((g) => {
    console.log('画廊已启动: ' + g.url);
    console.log('在浏览器里点选身份，确认后本进程会自动退出；' + opts.timeoutSec + ' 秒不操作则超时关闭。');
    // 留出一点点时间把响应刷回浏览器，再退出进程。
    g.done.then((r) => {
      if (r && r.timeout) {
        setTimeout(() => process.exit(3), 500);
        return;
      }
      setTimeout(() => process.exit(0), 700);
    });
  }).catch((e) => {
    console.error('ERROR ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
}
