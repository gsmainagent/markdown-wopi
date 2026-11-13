'use strict';
// 子路径部署（BASE_URL 带路径前缀 + 反代 strip 前缀）的回归护栏。
// 三条不变量：urlsrc 原样带前缀；所有 Origin 判断只按 origin（路径/默认端口/大小写无关）；
// 跳转用相对写法，浏览器解析后仍留在前缀里面。
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'),
  fs = require('node:fs'), os = require('node:os'), path = require('node:path'),
  { spawn } = require('node:child_process'), { once } = require('node:events');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(String(options.body));
    const headers = { ...(options.headers || {}) };
    if (body) { headers['Content-Length'] = body.length; if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    const req = http.request(new URL(url), { method: options.method || 'GET', headers }, res => {
      const chunks = []; res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(6000, () => req.destroy(Error('request timeout')));
    if (body) req.write(body); req.end();
  });
}

// 起一个带指定 BASE_URL / ALLOWED_ORIGINS 的实例（MOCK 宿主，不需要外部 Cloudreve）
async function withServer({ basePath = '', allowedOrigins = '', baseUrl = '' }, fn) {
  const reserve = http.createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));
  const mockFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wopimd-subpath-')), 'doc.md');
  fs.writeFileSync(mockFile, '# Subpath\n\n合成文稿，不含生产数据。\n');
  const rooms = path.join(path.dirname(mockFile), 'rooms');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), MOCK: '1', MOCK_FILE: mockFile, COLLAB_DATA_DIR: rooms,
      // 浏览器侧看到的前缀地址；后端收到的请求仍是根路径（等价 strip 前缀的反代）
      BASE_URL: (baseUrl || 'https://host.example:3443') + basePath,
      ALLOWED_ORIGINS: allowedOrigins,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', x => { output += x; });
  child.stderr.on('data', x => { output += x; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('server did not start: ' + output)), 8000);
      child.stdout.on('data', x => { if (x.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(Error('server exited ' + code + ': ' + output)); });
    });
    return await fn({ port, origin: 'https://host.example:3443', prefix: basePath, output: () => output });
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
}

// 用 MOCK 宿主换一个真实 sid + roomId
async function openSession(ctx, originHeader) {
  const wopisrc = encodeURIComponent('http://127.0.0.1:' + ctx.port + '/mock/wopi/files/1');
  const shim = await request('http://127.0.0.1:' + ctx.port + '/wopi/edit?WOPISrc=' + wopisrc + '&access_token=mock',
    { method: 'POST', body: 'access_token=mock', headers: { Origin: originHeader } });
  assert.equal(shim.status, 303, 'shim should accept the launch: ' + shim.body);
  const sid = new URLSearchParams((shim.headers.location || '').split('#')[1]).get('s');
  assert.ok(sid, 'no sid in ' + shim.headers.location);
  const doc = await request('http://127.0.0.1:' + ctx.port + '/api/doc/' + sid, { headers: { Origin: originHeader } });
  assert.equal(doc.status, 200, doc.body);
  return { sid, roomId: JSON.parse(doc.body).collab.roomId };
}

function wsHandshake(ctx, roomId, sid, originHeader, collabPath = '/collab') {
  return new Promise(resolve => {
    const ws = new WebSocket('ws://127.0.0.1:' + ctx.port + collabPath + '/' + roomId + '?sid=' + sid, { origin: originHeader });
    const settle = verdict => { clearTimeout(timer); try { ws.terminate(); } catch { } resolve(verdict); };
    const timer = setTimeout(() => settle('timeout'), 4000);
    ws.on('open', () => settle('open'));
    ws.on('unexpected-response', (_q, res) => settle('HTTP ' + res.statusCode));
    ws.on('error', () => settle('error'));
  });
}

test('discovery keeps the BASE_URL path prefix in every urlsrc', { timeout: 20000 }, async () => {
  await withServer({ basePath: '/mdedit' }, async ctx => {
    const res = await request('http://127.0.0.1:' + ctx.port + '/hosting/discovery');
    assert.equal(res.status, 200);
    const urls = [...res.body.matchAll(/urlsrc="([^"]+)"/g)].map(m => m[1]);
    assert.equal(urls.length, 4);
    for (const raw of urls) {
      const url = raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      assert.ok(url.startsWith('https://host.example:3443/mdedit/wopi/edit?'), 'prefix lost: ' + url);
      assert.ok(!url.includes('lng'), 'Cloudreve blind-replaces the literal lng: ' + url);
    }
    // 前缀不改变 zone 的推导：仍是 https 那一档，且只有一档
    assert.equal(res.body.split('<net-zone ').length - 1, 1);
    assert.match(res.body, /<net-zone name="external-https">/);
    // 图标 URL 也得带前缀，且落在 /static/ 路由下（否则线上 404）
    const icon = /favIconUrl="([^"]+)"/.exec(res.body)[1];
    assert.equal(icon, 'https://host.example:3443/mdedit/static/icon-64.png');
  });
});

test('the shim redirect stays relative so a stripping proxy keeps its prefix', { timeout: 20000 }, async () => {
  await withServer({ basePath: '/mdedit', allowedOrigins: 'https://host.example:3443' }, async ctx => {
    const wopisrc = encodeURIComponent('http://127.0.0.1:' + ctx.port + '/mock/wopi/files/1');
    const shim = await request('http://127.0.0.1:' + ctx.port + '/wopi/edit?WOPISrc=' + wopisrc + '&access_token=mock',
      { method: 'POST', body: 'access_token=mock', headers: { Origin: 'https://host.example:3443' } });
    const loc = shim.headers.location || '';
    assert.ok(!loc.startsWith('/'), 'Location must be relative, got ' + loc);
    // 浏览器把相对 Location 解析到「当前请求 URL」上：带前缀时必须落回前缀内
    const resolvedPrefixed = new URL(loc, 'https://host.example:3443/mdedit/wopi/edit');
    const resolvedRoot = new URL(loc, 'https://host.example:3443/wopi/edit');
    assert.equal(resolvedPrefixed.pathname, '/mdedit/static/monaco-editor.html');
    assert.equal(resolvedRoot.pathname, '/static/monaco-editor.html', 'root deployments must keep working');
    assert.match(resolvedPrefixed.hash, /^#s=/);
    assert.ok(!loc.includes('access_token'), 'token leaked into the redirect');
  });
});

test('routes also answer when the proxy keeps the prefix (the reported 404)', { timeout: 30000 }, async () => {
  await withServer({ basePath: '/markdown', allowedOrigins: 'https://host.example:3443' }, async ctx => {
    // 这就是 owner 现场那次：nginx 的 proxy_pass 结尾没有 /，前缀原样转给我们
    const disc = await request('http://127.0.0.1:' + ctx.port + '/markdown/hosting/discovery');
    assert.equal(disc.status, 200, 'prefixed discovery 404s: the exact bug from the field');
    assert.match(disc.body, /urlsrc="https:\/\/host\.example:3443\/markdown\/wopi\/edit\?/);

    const wopisrc = encodeURIComponent('http://127.0.0.1:' + ctx.port + '/mock/wopi/files/1');
    const shim = await request('http://127.0.0.1:' + ctx.port + '/markdown/wopi/edit?WOPISrc=' + wopisrc + '&access_token=mock',
      { method: 'POST', body: 'access_token=mock', headers: { Origin: 'https://host.example:3443' } });
    assert.equal(shim.status, 303, 'prefixed shim: ' + shim.body);
    const sid = new URLSearchParams((shim.headers.location || '').split('#')[1]).get('s');
    assert.ok(sid);
    const doc = await request('http://127.0.0.1:' + ctx.port + '/markdown/api/doc/' + sid, { headers: { Origin: 'https://host.example:3443' } });
    assert.equal(doc.status, 200, doc.body);
    const roomId = JSON.parse(doc.body).collab.roomId;
    // 协作 WS 也必须认这个前缀，否则页面能开、协同打不上
    assert.equal(await wsHandshake(ctx, roomId, sid, 'https://host.example:3443', '/markdown/collab'), 'open', 'prefixed websocket handshake failed');
    await request('http://127.0.0.1:' + ctx.port + '/api/unlock/' + sid, { method: 'POST', headers: { Origin: 'https://host.example:3443' } });

    // 另一种反代（proxy_pass 带 /，前缀被剥掉）在同一实例上必须照样工作
    const stripped = await request('http://127.0.0.1:' + ctx.port + '/hosting/discovery');
    assert.equal(stripped.status, 200, 'a stripping proxy must not break the prefixed instance');
    assert.equal(stripped.body, disc.body, 'discovery must not depend on which forwarding style was used');
  });
});

test('Origin checks ignore path, case, trailing slash and default ports', { timeout: 30000 }, async () => {
  // 配置里写各种"不干净"的形式，浏览器实际发的 Origin 是干净的那个
  await withServer({ basePath: '/mdedit', allowedOrigins: 'HTTPS://Host.Example:3443/some/path/, https://host.example:3443/' }, async ctx => {
    const { sid, roomId } = await openSession(ctx, 'https://host.example:3443');
    const verdict = await wsHandshake(ctx, roomId, sid, 'https://host.example:3443');
    assert.equal(verdict, 'open', 'WS handshake failed for a normalized-equal origin: ' + verdict + ' / ' + ctx.output().slice(-200));
  });

  // 默认端口写法（https://host 与 https://host:443）等价
  await withServer({ allowedOrigins: 'https://host.example', baseUrl: 'https://host.example' }, async ctx => {
    // 浏览器发来的 Origin 永远省略默认端口；两种写法必须互相等价（否则 WS 门禁会必败）
    const { sid, roomId } = await openSession(ctx, 'https://host.example');
    assert.equal(await wsHandshake(ctx, roomId, sid, 'https://host.example'), 'open', 'bare https origin must pass the gate');
    const other = await request('http://127.0.0.1:' + ctx.port + '/hosting/discovery');
    assert.equal(other.status, 200);
  });

  // 反例：真正的外部来源仍然必须被拒
  await withServer({ allowedOrigins: 'https://host.example:3443' }, async ctx => {
    const wopisrc = encodeURIComponent('http://127.0.0.1:' + ctx.port + '/mock/wopi/files/1');
    const rejected = await request('http://127.0.0.1:' + ctx.port + '/wopi/edit?WOPISrc=' + wopisrc + '&access_token=mock',
      { method: 'POST', body: 'access_token=mock', headers: { Origin: 'https://evil.example' } });
    assert.equal(rejected.status, 403, 'a foreign origin slipped through');
    const { sid, roomId } = await openSession(ctx, 'https://host.example:3443');
    assert.match(await wsHandshake(ctx, roomId, sid, 'https://evil.example'), /HTTP 403|error|timeout/, 'WS accepted a foreign origin');
  });
});
