'use strict';
// /hosting/discovery 的形状测试。
// 回归护栏的由来：Cloudreve 4.19.1 会为「每个 net-zone 里的每个 app」各建一个 viewer，
// 我们曾同时声明 external-https + external-http 两个 zone ⇒ 一次导入就在文件菜单里
// 出现两个同名编辑器（实测 GET /api/v4/admin/tool/wopi 返回 2 个 viewer）。
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'),
  path = require('node:path'), { spawn } = require('node:child_process'), { once } = require('node:events');

const root = path.resolve(__dirname, '..');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(url), { method: 'GET' }, res => {
      const chunks = [];
      res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(Error('request timeout')));
    req.end();
  });
}

// 起一个只为了读 discovery 的服务实例；reserve 一个空闲端口后立刻释放，交给子进程绑定
async function withDiscovery(env, fn) {
  const reserve = http.createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), BASE_URL: 'http://127.0.0.1:' + port, ALLOWED_ORIGINS: '', COLLAB_DATA_DIR: path.join(root, '.runtime', 'discovery-test'), ...env },
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
    const res = await get('http://127.0.0.1:' + port + '/hosting/discovery');
    return await fn(res, port);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
}

function post(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: '' } }, res => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(Error('request timeout')));
    req.end('access_token=x');
  });
}

const count = (hay, needle) => hay.split(needle).length - 1;

test('discovery declares exactly one app so hosts create exactly one editor', { timeout: 20000 }, async () => {
  await withDiscovery({}, res => {
    assert.equal(res.status, 200);
    assert.match(res.type, /application\/xml/);
    assert.equal(count(res.body, '<net-zone '), 1, 'more than one net-zone makes Cloudreve list duplicate editors');
    assert.equal(count(res.body, '<app '), 1);
    assert.equal(count(res.body, '</wopi-discovery>'), 1);
    // 默认展示名不再是硬编码的 WopiMdEditor
    assert.match(res.body, /<app name="Markdown Editor">/);
    assert.ok(!res.body.includes('WopiMdEditor'), 'placeholder app name is still being emitted');
    // md / markdown 各有 view(默认) + edit
    for (const ext of ['md', 'markdown']) {
      assert.equal(count(res.body, 'ext="' + ext + '" name="view" default="true"'), 1, ext + ' view action');
      assert.equal(count(res.body, 'ext="' + ext + '" name="edit"'), 1, ext + ' edit action');
    }
    // urlsrc 必须保留 wopisrc 占位与主题令牌，且绝不能出现子串 lng（Cloudreve 前端会盲替换）
    assert.equal(count(res.body, 'WOPISrc=&lt;wopisrc&gt;'), 4);
    assert.equal(count(res.body, 'theme=darkmode'), 4);
    assert.ok(!/urlsrc="[^"]*lng/.test(res.body), 'urlsrc contains the literal lng, which Cloudreve blind-replaces');
    // http 的 BASE_URL ⇒ external-http zone（scheme 跟着 BASE_URL 走，不再两个都声明）
    assert.match(res.body, /<net-zone name="external-http">/);
  });
});

test('discovery follows the BASE_URL scheme and escapes a custom app name', { timeout: 20000 }, async () => {
  await withDiscovery({ BASE_URL: 'https://md.example.org:3004', WOPI_APP_NAME: 'A&B "C" <D>' }, res => {
    assert.equal(res.status, 200);
    assert.equal(count(res.body, '<net-zone '), 1);
    assert.match(res.body, /<net-zone name="external-https">/);
    assert.match(res.body, /<app name="A&amp;B &quot;C&quot; &lt;D&gt;">/);
    assert.equal(count(res.body, 'https://md.example.org:3004/wopi/edit?WOPISrc=&lt;wopisrc&gt;'), 4);
    assert.ok(!res.body.includes('http://'), 'an http urlsrc leaked into an https deployment');
  });
});

test('the shim redirect target is an asset that actually ships', { timeout: 20000 }, async () => {
  await withDiscovery({}, async (res, port) => {
    assert.equal(res.status, 200);
    for (const suffix of ['', '&ui=legacy']) {
      // 回归护栏：?ui=legacy 曾指向 CM6 时代的 /static/editor.html，那个产物早已不在 static/ 里，
      // 线上实测 404。现在任何 ui 参数都必须落在真实存在的入口页上。
      const shim = await post(port, '/wopi/edit?WOPISrc=' + encodeURIComponent('http://127.0.0.1:1/files/1') + '&access_token=x' + suffix);
      assert.equal(shim.status, 303, 'shim status for ' + (suffix || 'default'));
      const loc = shim.location || '';
      assert.match(loc, /^\/static\/monaco-editor\.html#s=/, 'unexpected redirect target: ' + loc);
      assert.ok(!loc.includes('access_token'), 'access_token leaked into the redirect');
      const asset = await get('http://127.0.0.1:' + port + loc.split('#')[0]);
      assert.equal(asset.status, 200, 'redirect points at a missing asset: ' + loc.split('#')[0]);
    }
  });
});

test('WOPI_NET_ZONE overrides the derived zone for unusual topologies', { timeout: 20000 }, async () => {
  await withDiscovery({ WOPI_NET_ZONE: 'internal-https' }, res => {
    assert.equal(count(res.body, '<net-zone name="internal-https">'), 1);
    assert.equal(count(res.body, '<net-zone '), 1);
  });
});
