'use strict';
// /hosting/discovery 的形状测试。
// 回归护栏的由来：Cloudreve 4.19.1 会为「每个 net-zone 里的每个 app」各建一个 viewer，
// 我们曾同时声明 external-https + external-http 两个 zone ⇒ 一次导入就在文件菜单里
// 出现两个同名编辑器（实测 GET /api/v4/admin/tool/wopi 返回 2 个 viewer）。
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'),
  fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process'), { once } = require('node:events');

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
    assert.match(res.body, /<app name="Markdown Editor" favIconUrl="http:\/\/127\.0\.0\.1:\d+\/static\/icon-64\.png">/);
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
    assert.match(res.body, /<app name="A&amp;B &quot;C&quot; &lt;D&gt;" favIconUrl="https:\/\/md\.example\.org:3004\/static\/icon-64\.png">/);
    assert.equal(count(res.body, 'https://md.example.org:3004/wopi/edit?WOPISrc=&lt;wopisrc&gt;'), 4);
    assert.ok(!res.body.includes('http://'), 'an http urlsrc leaked into an https deployment');
  });
});

test('the shim redirect target is the entry the build actually produces', { timeout: 20000 }, async () => {
  // 源码层约束（不依赖构建产物，CI 在 npm run build 之前就跑测试，static/ 也不入库）：
  // server.js 里出现的每个 /static/*.html 都必须是 finalize-build.mjs 会产出的入口。
  // 这条拦的正是刚修掉的那类 bug：?ui=legacy 曾指向早已不再产出的 editor.html（线上 404）。
  const produced = [...new Set([...fs.readFileSync(path.join(root, 'client/workbench/finalize-build.mjs'), 'utf8').matchAll(/\/static\/([\w.-]+\.html)/g)].map((m) => m[1]))];
  assert.deepEqual(produced, ['monaco-editor.html'], 'build entry changed; update this guard');
  const targetLine = fs.readFileSync(path.join(root, 'server.js'), 'utf8').match(/var target = '([^']*\.html)'/);
  assert.ok(targetLine, 'could not find the shim redirect target in server.js');
  // 跳转必须是**相对**写法（根绝对路径会掉出反代前缀），且相对 /wopi/edit 解析后
  // 正好落在构建产出的入口上。
  assert.ok(!targetLine[1].startsWith('/'), 'shim redirect must stay relative, got ' + targetLine[1]);
  assert.equal(new URL(targetLine[1], 'http://h/wopi/edit').pathname, '/static/' + produced[0], 'shim redirects to an entry the build does not produce');

  await withDiscovery({}, async (res, port) => {
    assert.equal(res.status, 200);
    for (const suffix of ['', '&ui=legacy']) {
      const shim = await post(port, '/wopi/edit?WOPISrc=' + encodeURIComponent('http://127.0.0.1:1/files/1') + '&access_token=x' + suffix);
      assert.equal(shim.status, 303, 'shim status for ' + (suffix || 'default'));
      const loc = shim.location || '';
      // 跳转是相对写法（见 server.js 注释），所以按浏览器的解析规则还原成真实地址再断言
      const resolved = new URL(loc, 'http://127.0.0.1:' + port + '/wopi/edit');
      assert.equal(resolved.pathname, '/static/monaco-editor.html', 'unexpected redirect target: ' + loc);
      assert.match(resolved.hash, /^#s=/, 'sid missing from ' + loc);
      assert.ok(!loc.includes('access_token'), 'access_token leaked into the redirect');
      // 产物在树里（本地/已部署）才验真实可取；未构建的树里这条没意义
      if (fs.existsSync(path.join(root, 'static', 'monaco-editor.html'))) {
        const asset = await get(resolved.origin + resolved.pathname);
        assert.equal(asset.status, 200, 'redirect points at a missing asset: ' + resolved.pathname);
      }
    }
  });
});

test('the icon assets the entry page and discovery reference really ship', { timeout: 20000 }, async () => {
  // static/ 不入库也不由测试构建，所以这里查「源头资产 + 构建脚本」这一对不变量：
  // 页面引用的每个图标文件都必须躺在 client/assets/icon 里，且 build.mjs 会把它们搬进 static/。
  const dir = path.join(root, 'client', 'assets', 'icon');
  const wanted = ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-64.png', 'icon-192.png', 'icon-512.png', 'favicon.ico'];
  for (const f of wanted) assert.ok(fs.existsSync(path.join(dir, f)), 'missing icon asset: ' + f);
  const build = fs.readFileSync(path.join(root, 'client/build.mjs'), 'utf8');
  assert.match(build, /client\/assets\/icon/, 'build.mjs no longer copies the icon assets into static/');
  const finalize = fs.readFileSync(path.join(root, 'client/workbench/finalize-build.mjs'), 'utf8');
  const linked = [...finalize.matchAll(/href="(icon-[0-9]+\.png|favicon\.ico)"/g)].map(m => m[1]);
  for (const ref of linked) assert.ok(wanted.includes(ref), 'entry page links an icon that does not exist: ' + ref);
  assert.ok(linked.length >= 3, 'expected the entry page to link several icon sizes, got ' + linked.length);
  // 浏览器链接必须是相对路径：绝对路径会在 strip 前缀的反代下掉到站点根
  assert.ok(!/href="\/static\/|href="\//.test(finalize), 'icon links must be relative to the document');

  await withDiscovery({}, async (res) => {
    const urls = [...res.body.matchAll(/favIconUrl="([^"]+)"/g)].map(m => m[1]);
    assert.equal(urls.length, 1, 'exactly one app means exactly one favIconUrl');
    assert.match(urls[0], /^http:\/\/127\.0\.0\.1:\d+\/static\/icon-64\.png$/);
    // favIconUrl 指的必须是服务端真正会返回文件的路径。回归护栏：曾经写成
    // base + '/icon-64.png'（前缀根），而图标只存在于 static/ 下 ⇒ 线上 404，
    // 库里缓存了一张破图标。所以这里把「URL → 磁盘资产 → 构建搬运」三段串起来查。
    assert.equal(new URL(urls[0]).pathname, '/static/icon-64.png', 'favIconUrl is not under the static route');
    assert.ok(fs.existsSync(path.join(dir, 'icon-64.png')), 'favIconUrl points at an asset that does not exist');
    for (const u of [...res.body.matchAll(/(?:urlsrc|favIconUrl)="([^"]+)"/g)].map(m => m[1])) {
      assert.ok(!u.includes('lng'), 'Cloudreve blind-replaces the literal lng: ' + u);
    }
  });
});

test('WOPI_NET_ZONE overrides the derived zone for unusual topologies', { timeout: 20000 }, async () => {
  await withDiscovery({ WOPI_NET_ZONE: 'internal-https' }, res => {
    assert.equal(count(res.body, '<net-zone name="internal-https">'), 1);
    assert.equal(count(res.body, '<net-zone '), 1);
  });
});
