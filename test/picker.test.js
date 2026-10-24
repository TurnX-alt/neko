/**
 * 画廊 E2E 测试：真起 HTTP 服务、真调 switch.js、真写目标文件。
 * 运行: node --test test/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGallery } = require('../scripts/picker');
const { buildCatalog } = require('../scripts/catalog');

function tempTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-test-'));
  return path.join(dir, 'AGENTS.md');
}

async function start(opts = {}) {
  const target = opts.target || tempTarget();
  const gallery = await createGallery({
    port: 0,
    open: false,
    timeoutSec: opts.timeoutSec || 30,
    target,
  });
  return { gallery, target };
}

function post(gallery, payload, token = gallery.token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Neko-Token'] = token;
  return fetch(gallery.url + 'api/select', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

test('catalog：扫描目录即可还原全部身份，无需手工表格', () => {
  const catalog = buildCatalog();
  assert.equal(catalog.total, 25);
  assert.equal(catalog.groups.length, 6);
  assert.deepEqual(catalog.groups.map((g) => g.ip), [
    'nekopara', 'uma-musume', 'bang-dream', 'project-sekai', 'arknights', 'genshin-impact',
  ]);
  assert.equal(catalog.personalities.length, 5);
  assert.equal(catalog.scenarios.length, 2);
  assert.ok(catalog.jailbreaks.some((j) => j.id === 'jailbreaks/deepseek-4-1.md'));
  assert.equal(catalog.defaultJailbreak, 'jailbreaks/deepseek-4-1.md');

  const all = catalog.groups.flatMap((g) => g.personas);
  const teio = all.find((p) => p.id === 'uma-musume/tokai-teio');
  assert.equal(teio.name, '东海帝皇');
  assert.equal(teio.en, 'Tokai Teio');
  assert.equal(teio.tagline, '元气小恶魔型');
  assert.equal(teio.hasImage, true);
  assert.equal(teio.image, '/img/uma-musume/tokai-teio.png');

  const chocola = all.find((p) => p.id === 'nekopara/chocola');
  assert.equal(chocola.name, '巧克力');
  assert.equal(chocola.hasImage, true);
  assert.equal(chocola.image, '/img/nekopara/chocola.png');
  assert.equal(chocola.needsAddress, false);

  const anon = all.find((p) => p.id === 'bang-dream/anon-chihaya');
  assert.equal(anon.needsAddress, true, '含【称呼】占位符的人设必须标记为待定');

  // 每个身份都至少有一个可读的副标题，卡片不会出现空白行
  for (const p of all) assert.ok(p.tagline.length > 0, p.id + ' 缺少标签');
});

test('页面与清单接口可用，且图片可正常取回', async () => {
  const { gallery } = await start();
  try {
    const page = await fetch(gallery.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(gallery.token), 'token 应注入页面');
    assert.ok(!html.includes('__NEKO_TOKEN__'), '占位符应被替换');
    assert.ok(html.includes('身份画廊'));

    const res = await fetch(gallery.url + 'api/catalog');
    assert.equal(res.status, 200);
    const catalog = await res.json();
    assert.equal(catalog.total, 25);

    const img = await fetch(gallery.url + 'img/nekopara/chocola.png');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.ok((await img.arrayBuffer()).byteLength > 0);
  } finally {
    gallery.close();
  }
});

test('越权与异常输入都被拒绝', async () => {
  const { gallery } = await start();
  try {
    assert.equal((await post(gallery, { persona: 'nekopara/chocola' }, null)).status, 403);
    assert.equal((await post(gallery, { persona: 'nekopara/nope' })).status, 400);
    assert.equal((await post(gallery, { persona: 'nekopara/chocola', personalities: ['nope'] })).status, 400);
    assert.equal((await post(gallery, { persona: 'nekopara/chocola', scenario: 'nope' })).status, 400);

    for (const bad of ['../package.json', 'img/../catalog.js', 'nekopara/../../etc/passwd']) {
      const res = await fetch(gallery.url + bad);
      assert.ok(res.status === 404 || res.status === 400, bad + ' 不应被服务');
    }
  } finally {
    gallery.close();
  }
});

test('选人即写回：一条请求完成切换与落盘', async () => {
  const { gallery, target } = await start();
  const res = await post(gallery, {
    persona: 'nekopara/chocola',
    personalities: ['insatiable', 'yandere'],
    scenario: 'chat',
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.match(data.output, /^OK action=/);
  assert.match(data.output, /identity=nekopara\/chocola/);
  assert.match(data.output, /personality=insatiable,yandere/);
  assert.match(data.output, /scenario=chat/);

  const doc = fs.readFileSync(target, 'utf8');
  assert.ok(doc.includes('<!-- neko:identity:start -->'));
  assert.ok(doc.includes('## 人设：巧克力（Chocola）'));
  assert.ok(doc.includes('当前人设：nekopara/chocola'));
  assert.ok(doc.includes('## 人格：贪欢'));
  assert.ok(doc.includes('## 人格：病娇'));
  assert.ok(doc.includes('## 场景：口语化聊天'));

  const done = await gallery.done;
  assert.equal(done.ok, true);
});

test('称呼待定：缺称呼被拦下，补上后才写回', async () => {
  const { gallery, target } = await start();
  try {
    const missing = await post(gallery, { persona: 'bang-dream/anon-chihaya' });
    assert.equal(missing.status, 400);
    const body = await missing.json();
    assert.equal(body.code, 'ADDRESS_REQUIRED');

    const ok = await post(gallery, { persona: 'bang-dream/anon-chihaya', address: '搭档' });
    assert.equal(ok.status, 200);
    const doc = fs.readFileSync(target, 'utf8');
    assert.ok(doc.includes('搭档'));
    assert.ok(!doc.includes('【称呼】'), '写入产物里不应残留占位符');
  } finally {
    gallery.close();
  }
});

test('重复写入同一目标文件时整块替换，不累积', async () => {
  const target = tempTarget();
  const first = await start({ target });
  await post(first.gallery, { persona: 'nekopara/chocola' });
  await first.gallery.done;

  const second = await start({ target });
  const res = await post(second.gallery, { persona: 'uma-musume/tokai-teio' });
  assert.equal(res.status, 200);
  await second.gallery.done;

  const doc = fs.readFileSync(target, 'utf8');
  assert.equal(doc.split('<!-- neko:identity:start -->').length - 1, 1);
  assert.ok(doc.includes('## 人设：东海帝皇（Tokai Teio）'));
  assert.ok(!doc.includes('## 人设：巧克力（Chocola）'));
});

test('预填：已识别的人格/场景带进画廊，非法值静默丢弃', async () => {
  const gallery = await createGallery({
    port: 0,
    open: false,
    timeoutSec: 30,
    target: tempTarget(),
    prefill: {
      persona: 'nekopara/chocola',
      personalities: ['insatiable', 'nope'],
      scenario: 'chat',
    },
  });
  try {
    const catalog = await (await fetch(gallery.url + 'api/catalog')).json();
    assert.deepEqual(catalog.prefill.personalities, ['insatiable']);
    assert.equal(catalog.prefill.scenario, 'chat');
    assert.equal(catalog.prefill.persona, 'nekopara/chocola');

    const empty = await createGallery({ port: 0, open: false, target: tempTarget() });
    const catalog2 = await (await fetch(empty.url + 'api/catalog')).json();
    assert.equal(catalog2.prefill.persona, null);
    assert.deepEqual(catalog2.prefill.personalities, []);
    assert.equal(catalog2.prefill.scenario, null);
    empty.close();
  } finally {
    gallery.close();
  }
});

test('启用贪欢时，引用块必须出现在人格区块之前', async () => {
  const { gallery, target } = await start();
  const res = await post(gallery, {
    persona: 'nekopara/chocola',
    personalities: ['insatiable', 'yandere'],
    jb: 'jailbreaks/deepseek-4-1.md',
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.output, /quote=jailbreaks\/deepseek-4-1\.md/);

  const doc = fs.readFileSync(target, 'utf8');
  const quoteAt = doc.indexOf('> # Assistant Operating Specification');
  const persAt = doc.indexOf('## 人格：贪欢');
  const yandereAt = doc.indexOf('## 人格：病娇');
  assert.ok(quoteAt > 0, '引用块应当存在');
  assert.ok(quoteAt < persAt, '引用块必须在「贪欢」之前');
  assert.ok(persAt < yandereAt, '人格顺序应保持传入顺序');
  assert.ok(doc.indexOf('## 人设：巧克力') > quoteAt, '人设仍排在人格之后');
});

test('未启用贪欢时不插入引用块', async () => {
  const { gallery, target } = await start();
  await post(gallery, { persona: 'nekopara/chocola', personalities: ['yandere'] });
  await gallery.done;
  const doc = fs.readFileSync(target, 'utf8');
  assert.ok(!doc.includes('Assistant Operating Specification'));
  assert.ok(!doc.includes('quote='));
});

test('越狱引用：jb 合法值透传 --jb，非法值被拒绝', async () => {
  const { gallery, target } = await start();
  try {
    const bad = await post(gallery, {
      persona: 'nekopara/chocola',
      personalities: ['insatiable'],
      jb: 'jailbreaks/nope.md',
    });
    assert.equal(bad.status, 400);

    const ok = await post(gallery, {
      persona: 'nekopara/chocola',
      personalities: ['insatiable'],
      jb: 'jailbreaks/deepseek-4-1.md',
    });
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).output, /quote=jailbreaks\/deepseek-4-1\.md/);
    const doc = fs.readFileSync(target, 'utf8');
    assert.ok(doc.includes('> # Assistant Operating Specification'));
  } finally {
    gallery.close();
  }
});

test('越狱总是可用：无人格也能引用；不启用即不传引用', async () => {
  const a = await start();
  const any = await post(a.gallery, {
    persona: 'nekopara/chocola',
    jb: 'jailbreaks/glm-5-3-flash.md',
  });
  assert.equal(any.status, 200);
  assert.match((await any.json()).output, /quote=jailbreaks\/glm-5-3-flash\.md/);
  await a.gallery.done;

  const b = await start();
  try {
    const off = await post(b.gallery, {
      persona: 'nekopara/chocola',
      personalities: ['insatiable'],
      jb: 'off',
    });
    assert.equal(off.status, 200, '不启用即不传引用，即使启用贪欢也不报错');
    assert.doesNotMatch((await off.json()).output, /quote=/);
    const doc = fs.readFileSync(b.target, 'utf8');
    assert.ok(!doc.includes('> # Assistant Operating Specification'));
  } finally {
    b.gallery.close();
  }
});

test('预览接口：与写入共用组装逻辑，不要求称呼、不落盘', async () => {
  const { gallery, target } = await start();
  try {
    const call = (address) => fetch(gallery.url + 'api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Neko-Token': gallery.token },
      body: JSON.stringify({
        persona: 'bang-dream/anon-chihaya',
        personalities: ['insatiable'],
        scenario: 'chat',
        jb: 'off',
        address,
      }),
    });

    // 未填称呼：预览放行，占位符原样显示
    const raw = await call('');
    assert.equal(raw.status, 200);
    const rawBody = await raw.json();
    assert.match(rawBody.preview, /^<!-- neko:identity:start -->/);
    assert.ok(rawBody.preview.includes('【称呼】'));
    assert.ok(rawBody.preview.includes('## 人格：贪欢'));
    assert.ok(rawBody.preview.includes('## 场景：口语化聊天'));
    assert.ok(!rawBody.preview.includes('Assistant Operating Specification'), 'jb=off 不含引用');

    // 填了称呼：占位符被替换
    const filled = await call('搭档');
    const filledBody = await filled.json();
    assert.ok(filledBody.preview.includes('搭档'));
    assert.ok(!filledBody.preview.includes('【称呼】'));

    assert.equal(fs.existsSync(target), false, '预览不得写目标文件');
  } finally {
    gallery.close();
  }
});

test('引用文件缺失时切换失败，且不碰目标文件', () => {
  const target = tempTarget();
  const res = require('node:child_process').spawnSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'scripts', 'switch.js'),
      'nekopara/chocola',
      '--is', 'insatiable',
      '--jb', 'jailbreaks/does-not-exist.md',
      '--target', target,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /deepseek|does-not-exist/);
  assert.equal(fs.existsSync(target), false, '失败时不应创建目标文件');
});

test('无人操作时按超时关闭，不无限挂起', async () => {
  const { gallery } = await start({ timeoutSec: 1 });
  const done = await gallery.done;
  assert.equal(done.timeout, true);
});
