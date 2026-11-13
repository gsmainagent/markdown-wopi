'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const {fileMetadata,refreshError}=require('./server-state.cjs');
const {createCollaboration}=require('./collaboration.cjs');
const RENEW_MS=Math.max(1000,Number(process.env.LOCK_REFRESH_MS)||240000);
const PRESENCE_MS=12*60000;

const PORT = parseInt(process.env.PORT || '3001', 10);
const MOCK = process.env.MOCK === '1';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
// Origin 只由 scheme/host/port 构成，永远不带路径。BASE_URL 允许挂子路径前缀
// （反代 strip 前缀的部署方式），所以比较前必须把两边都收敛成 origin，否则
// “Origin 与带路径的 BASE_URL 不相等”会让握手永远失败（实测 WS 403）。
function originOf(value) {
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const host = u.hostname.toLowerCase();
    const port = u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) ? ':' + u.port : '';
    return u.protocol + '//' + (host.includes(':') ? '[' + host + ']' : host) + port;
  } catch {
    return '';
  }
}
const sameOrigin = (a, b) => { const x = originOf(a), y = originOf(b); return !!x && x === y; };
// 配置里写带路径/默认端口/大写的值都按 origin 处理；解析不出来的条目不得悄悄放宽门禁，
// 所以“有没有配”按原始列表判断，“匹不匹配”按规范化集合判断。
// 挂载前缀：BASE_URL 里可以带路径（如 https://wopi.example:3443/markdown）。
// 反代到底剥不剥这个前缀，两种写法都有人在用（proxy_pass 结尾有没有 /），
// 这里两种都接住：进来的路径若以前缀开头就先剥掉，否则原样走根路由。
// 不这么做的话，保留前缀的转发会让我们只注册了根路径的路由全部 404（实测踩过）。
const ROUTE_PREFIX = (() => {
  try {
    const pathname = new URL(BASE_URL).pathname.replace(/\/+$/, '');
    return pathname.startsWith('/') && pathname !== '/' ? pathname : '';
  } catch { return ''; }
})();
const stripPrefix = pathname => {
  const raw = String(pathname || '/');
  if (ROUTE_PREFIX && (raw === ROUTE_PREFIX || raw.startsWith(ROUTE_PREFIX + '/'))) {
    const rest = raw.slice(ROUTE_PREFIX.length);
    return rest.startsWith('/') ? rest : '/' + rest;
  }
  return raw;
};
const ALLOWED_ORIGINS_RAW = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set(ALLOWED_ORIGINS_RAW.map(originOf).filter(Boolean));
ALLOWED_ORIGINS_RAW.forEach((raw, i) => { if (!ALLOWED_ORIGINS.has(originOf(raw))) console.warn('ALLOWED_ORIGINS 条目无法解析为 origin，已忽略: ' + raw); });
const STATIC_DIR = path.join(__dirname, 'static');
const MOCK_FILE = process.env.MOCK_FILE || path.join(__dirname, 'mock-data.md');
// MOCK host keeps one in-memory lock so the self-test can exercise the real lock lifecycle.
let mockLock = '';
const MAX_BODY = 20 * 1024 * 1024;

// 会话仅在内存：sid -> { wopisrc, token, ttl, created, lockId, lockFailed }
// access_token 全程不出服务端；编辑器只拿随机 sid。
const sessions = new Map();

const newSid = () => crypto.randomBytes(24).toString('base64url');
const live = (s) => Date.now() <= Math.min(s.ttl, s.created + 12 * 3600 * 1000);
let collaboration;
setInterval(()=>{for(const [sid,session] of sessions)if(!live(session)){void collaboration?.leave(sid).catch(()=>{});sessions.delete(sid);}},60000).unref();

function log(sid, method, p, status) {
  console.log(new Date().toISOString(), (sid || '-').slice(0, 8), method, p, status);
}

function send(res, status, body, type) {
  const b = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
  return status;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 用 http/https.request 而非全局 fetch：不受 NODE_USE_ENV_PROXY/HTTP_PROXY 等环境变量劫持
function upstream(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { ...(opts.headers || {}) };
    if (opts.body !== undefined) headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = mod.request(u, { method: opts.method || 'GET', headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => JSON.parse(body.toString('utf8')),
          text: async () => body.toString('utf8'),
        });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('upstream timeout'), { status: 504 })));
    req.on('error', (e) => reject(Object.assign(e, { status: e.status || 502 })));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const withToken = (s, suffix) => {
  const sep = s.wopisrc.includes('?') ? '&' : '?';
  return s.wopisrc + (suffix || '') + sep + 'access_token=' + encodeURIComponent(s.token);
};

async function wopiCheckFileInfo(s) {
  const r = await upstream(withToken(s));
  if (!r.ok) throw Object.assign(new Error('checkfileinfo HTTP ' + r.status), { status: 502 });
  const j = await r.json();
  const info=fileMetadata(s,j); s.fileInfo=info; return info;
}

async function wopiGetContents(s) {
  const r = await upstream(withToken(s, '/contents'));
  if (!r.ok) throw Object.assign(new Error('getfile HTTP ' + r.status), { status: 502 });
  return await r.text();
}

async function wopiLock(s) {
  const lockId = crypto.randomBytes(16).toString('hex');
  const r = await upstream(withToken(s), { method: 'POST', headers: { 'X-WOPI-Lock': lockId, 'X-WOPI-Override': 'LOCK' } });
  if (r.status === 200) { s.lockId = lockId; s.closing=false; s.lastSeen=Date.now(); s.nextRefresh=Date.now()+RENEW_MS; return { ok: true }; }
  if (r.status !== 409) throw Object.assign(new Error('lock HTTP ' + r.status), { status: 502 });
  return { ok: false, conflict: true };
}

const wopiRefreshLock = async (s) => {
  if (!s.lockId || s.closing) throw Object.assign(new Error('document lock unavailable'),{status:409});
  if(s.refreshing)return s.refreshing;
  s.refreshing=(async()=>{
    const r=await upstream(withToken(s),{method:'POST',headers:{'X-WOPI-Lock':s.lockId,'X-WOPI-Override':'REFRESH_LOCK'}});
    if(r.status!==200){if([401,403,409].includes(r.status))s.lockFailed=true;throw refreshError(r.status);}
    s.lastRefreshError=null;s.nextRefresh=Date.now()+RENEW_MS;
  })().finally(()=>{s.refreshing=null;});
  return s.refreshing;
};

async function wopiPutFile(s, text) {
  const headers = { 'X-WOPI-Override': 'PUT', 'Content-Type': 'text/plain; charset=utf-8' };
  if (s.lockId) headers['X-WOPI-Lock'] = s.lockId;
  const r = await upstream(withToken(s, '/contents'), { method: 'POST', headers, body: text });
  return r.status;
}

async function wopiUnlock(s) {
  if (!s.lockId) return;
  s.closing=true;
  if(s.refreshing)try{await s.refreshing;}catch{}
  try {
    const response=await upstream(withToken(s), { method:'POST',headers:{'X-WOPI-Lock':s.lockId,'X-WOPI-Override':'UNLOCK'} });
    console.log(new Date().toISOString(),'WOPI','UNLOCK',response.status);
    if(!response.ok)throw Object.assign(new Error('unlock HTTP '+response.status),{status:response.status});
    s.lockId=null;
  } catch(e) {
    if(!/^unlock HTTP /.test(e.message))console.warn(new Date().toISOString(),'WOPI','UNLOCK',e.status||502);
    throw e;
  }
}

const xmlAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Cloudreve 会为 discovery 里「每个 net-zone 的每个 app」各建一个 viewer：4.19.1 实测
// （GET /api/v4/admin/tool/wopi?endpoint=…）两个 zone ⇒ 一次导入就得到两个同名编辑器。
// 所以只声明一个 zone，名字跟 BASE_URL 的 scheme 走；拓扑特殊时用 WOPI_NET_ZONE 覆盖。
const WOPI_APP_NAME = process.env.WOPI_APP_NAME || 'Markdown Editor';
const WOPI_NET_ZONE = process.env.WOPI_NET_ZONE || '';

function discoveryXML(base) {
  const esc = xmlAttr(base);
  // urlsrc 两条硬约束：
  // 1) 不得出现子串 lng —— Cloudreve 会无条件追加 lang=lng 并由前端盲替换字面量 lng；
  // 2) theme=darkmode 不是「写死暗色」，而是 Cloudreve 自己 queryPlaceholders 里
  //    THEME_ID → darkmode 的产物，由它前端再替换成真实主题（写成 <THEME_ID> 等价）。
  const urlsrc = esc + '/wopi/edit?WOPISrc=&lt;wopisrc&gt;&amp;theme=darkmode';
  const zoneName = WOPI_NET_ZONE || (/^https:/i.test(base) ? 'external-https' : 'external-http');
  const zone = (name) =>
    '  <net-zone name="' + name + '">\n' +
    '    <app name="' + xmlAttr(WOPI_APP_NAME) + '" favIconUrl="' + xmlAttr(base + '/icon-64.png') + '">\n' +
    ['md', 'markdown'].map((ext) =>
      '      <action ext="' + ext + '" name="view" default="true" urlsrc="' + urlsrc + '"/>\n' +
      '      <action ext="' + ext + '" name="edit" urlsrc="' + urlsrc + '"/>'
    ).join('\n') + '\n' +
    '    </app>\n' +
    '  </net-zone>';
  return '<?xml version="1.0" encoding="utf-8"?>\n<wopi-discovery>\n' + zone(zoneName) + '\n</wopi-discovery>\n';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.map': 'application/json',
};

function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname.replace(/^\/static\//, ''));
  const full = path.resolve(STATIC_DIR, rel);
  if (full !== STATIC_DIR && !full.startsWith(STATIC_DIR + path.sep)) return void log(null, 'GET', pathname, send(res, 403, { ok: false }));
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return void log(null, 'GET', pathname, send(res, 404, { ok: false }));
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  });
}

async function handleShim(req, res, u) {
  if (ALLOWED_ORIGINS_RAW.length) {
    const org = req.headers.origin;
    // 带 Origin 就必须命中允许列表；命中不了（含畸形值）一律拒，绝不 fail open。
    if (org && !ALLOWED_ORIGINS.has(originOf(org))) return void log(null, req.method, u.pathname, send(res, 403, { ok: false, error: 'origin not allowed' }));
  }
  let wopisrc = u.searchParams.get('WOPISrc');
  let token = u.searchParams.get('access_token') || '';
  let ttl = parseInt(u.searchParams.get('access_token_ttl') || '0', 10);
  if (req.method === 'POST') {
    const form = new URLSearchParams((await readBody(req, 64 * 1024)).toString('utf8'));
    token = form.get('access_token') || token;
    ttl = parseInt(form.get('access_token_ttl') || '0', 10) || ttl;
    wopisrc = wopisrc || form.get('WOPISrc');
  }
  if (!wopisrc) return void log(null, req.method, u.pathname, send(res, 400, { ok: false, error: 'WOPISrc required' }));
  if (!token) return void log(null, req.method, u.pathname, send(res, 400, { ok: false, error: 'access_token required' }));
  const sid = newSid();
  sessions.set(sid, { wopisrc, token, ttl: ttl > Date.now() ? ttl : Date.now() + 3600e3, created: Date.now(), lockId: null, lockFailed: false });
  // 旧的 ?ui=legacy 逃生门已删：它指向 CM6 时代的 editor 页面产物，那个文件早已不在
  // 构建输出里（线上实测 404）。现在无论带不带 ui 参数都进 Monaco 工作台。
  // 相对跳转：请求来自 <前缀>/wopi/edit，`../static/...` 由浏览器解析成
  // <前缀>/static/...；根部署时前缀为空，同样解析到 /static/...。
  // 写成根绝对路径会让 strip 前缀的反代把浏览器打到站点根上（实测 404）。
  var target = '../static/monaco-editor.html';
  // Cloudreve replaces the first literal darkmode with 2 (dark) or 1 (light). Forward only a validated cosmetic value.
  const requestedTheme = u.searchParams.get('theme') || '';
  const theme = /^(dark|2|true)$/i.test(requestedTheme) ? 'dark' : /^(light|1|false)$/i.test(requestedTheme) ? 'light' : '';
  res.writeHead(303, { Location: target + '#s=' + sid + (theme ? '&theme=' + theme : ''), 'Cache-Control': 'no-store' });
  res.end();
  log(sid, req.method, u.pathname, 303);
}

async function handleApi(req,res,u){
 const match=u.pathname.match(/^\/api\/(doc|unlock|keepalive|save|status|resolve)\/([A-Za-z0-9_-]+)$/);
 if(!match)return void send(res,404,{ok:false});
 const kind=match[1],sid=match[2],session=sessions.get(sid);
 if(kind==='unlock'){if(req.method!=='POST')return void send(res,405,{ok:false});await collaboration.leave(sid);res.writeHead(204);return res.end();}
 if(!session||!live(session))return void send(res,404,{ok:false,error:'session expired'});
 session.lastSeen=Date.now();
 if(kind==='doc'&&req.method==='GET'){
  const {room,info,canWrite}=await collaboration.attach(session,sid);
  return void send(res,200,{ok:true,name:info.name,canWrite,lockedByOther:room.blocked==='external-lock',content:room.text(),size:Buffer.byteLength(room.text()),draftKey:info.draftKey,version:info.version,eol:room.eol,capabilities:info.capabilities,collab:{roomId:room.key,user:collaboration.identity(session,info),status:collaboration.status(room)}});
 }
 const room=collaboration.roomFor(session);if(!room)return void send(res,409,{ok:false,error:'open document before collaboration requests'});
 if(kind==='resolve'&&req.method==='POST'){
  let action='';try{action=JSON.parse((await readBody(req,4096)).toString('utf8')).action;}catch{}
  if(action!=='use-cloud')return void send(res,400,{ok:false,error:'unsupported action'});
  if(!room.blocked)return void send(res,409,{ok:false,error:'room is not blocked'});
  await collaboration.discard(room);return void send(res,200,{ok:true});
 }
 if(kind==='status'&&req.method==='GET')return void send(res,200,{ok:true,...collaboration.status(room)});
 if(kind==='keepalive'&&req.method==='POST'){room.lastSeen=Date.now();if(room.blocked)return void send(res,409,{ok:false,error:room.blocked});await collaboration.renew(room);return void send(res,200,{ok:true,expires:session.ttl,...collaboration.status(room)});}
 if(kind==='save'&&req.method==='POST'){
  const member=room.members.get(sid);if(!member?.canWrite)return void send(res,403,{ok:false,error:'read-only'});
  const status=await collaboration.flush(room);return void send(res,200,{ok:true,...status});
 }
 // Raw full-document client PUT is forbidden in shared rooms: it could overwrite peers.
 if(kind==='doc'&&req.method==='PUT')return void send(res,403,{ok:false,error:'use shared Yjs updates; raw document overwrite disabled'});
 return void send(res,405,{ok:false});
}

async function handleMock(req, res, u) {
  const p = u.pathname;
  if (p === '/mock/wopi/files/1' && req.method === 'GET') {
    const st = fs.statSync(MOCK_FILE);
    return void log(null, 'GET', p, send(res, 200, { BaseFileName: 'mock-data.md', UserCanWrite: true, Size: st.size }));
  }
  if (p === '/mock/wopi/files/1/contents' && req.method === 'GET') {
    return void log(null, 'GET', p, send(res, 200, fs.readFileSync(MOCK_FILE, 'utf8'), 'text/plain; charset=utf-8'));
  }
  if (p === '/mock/wopi/files/1/contents' && req.method === 'POST') {
    if (mockLock && req.headers['x-wopi-lock'] !== mockLock) return void log(null, 'POST', p, send(res, 409, { ok: false, error: 'lock mismatch' }));
    const body = await readBody(req, MAX_BODY);
    fs.writeFileSync(MOCK_FILE, body);
    return void log(null, 'POST', p, send(res, 200, { ok: true }));
  }
  if (p === '/mock/wopi/files/1' && req.method === 'POST') {
    const op = req.headers['x-wopi-override'], val = req.headers['x-wopi-lock'] || '';
    if (op === 'LOCK') {
      if (mockLock && mockLock !== val) { res.writeHead(409, { 'X-WOPI-Lock': mockLock }); res.end(); return void log(null, 'POST', p + ' LOCK-conflict', 409); }
      mockLock = val; res.writeHead(200); res.end(); return void log(null, 'POST', p + ' LOCK', 200);
    }
    if (op === 'REFRESH_LOCK') {
      if (mockLock !== val) { res.writeHead(409); res.end(); return void log(null, 'POST', p + ' REFRESH-conflict', 409); }
      res.writeHead(200); res.end(); return void log(null, 'POST', p + ' REFRESH_LOCK', 200);
    }
    if (op === 'UNLOCK') {
      if (mockLock !== val) { res.writeHead(409, { 'X-WOPI-Lock': mockLock }); res.end(); return void log(null, 'POST', p + ' UNLOCK-conflict', 409); }
      mockLock = ''; res.writeHead(200); res.end(); return void log(null, 'POST', p + ' UNLOCK', 200);
    }
    return void log(null, 'POST', p, send(res, 501, { ok: false, error: 'unsupported override ' + String(op) }));
  }
  return void log(null, req.method, p, send(res, 404, { ok: false }));
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = stripPrefix(u.pathname);
    if (p !== u.pathname) u.pathname = p;   // handleApi/handleMock/serveStatic 都读 u.pathname
    if (p === '/healthz') return void log(null, req.method, p, send(res, 200, 'ok', 'text/plain; charset=utf-8'));
    if (p === '/hosting/discovery') {
      const base = BASE_URL || 'http://' + (req.headers.host || '127.0.0.1:' + PORT);
      return void log(null, req.method, p, send(res, 200, discoveryXML(base), 'application/xml; charset=utf-8'));
    }
    if (p === '/wopi/edit' && (req.method === 'POST' || req.method === 'GET')) return await handleShim(req, res, u);
    if (p.startsWith('/api/')) return await handleApi(req, res, u);
    if (MOCK && p.startsWith('/mock/')) return await handleMock(req, res, u);
    if (p.startsWith('/static/')) return serveStatic(res, p);
    return void log(null, req.method, p, send(res, 404, { ok: false }));
  } catch (e) {
    const status = (e && e.code === 413) ? 413 : (e && e.status) || 500;
    log(null, req.method, new URL(req.url,'http://localhost').pathname, status);
    if (!res.headersSent) send(res, status, { ok: false, error: e.message || 'internal error' });
  }
});

collaboration=createCollaboration({server,sessions,live,checkInfo:wopiCheckFileInfo,getContents:wopiGetContents,lock:wopiLock,refresh:wopiRefreshLock,put:wopiPutFile,unlock:wopiUnlock,dataDir:process.env.COLLAB_DATA_DIR||path.join(__dirname,'.runtime','rooms'),origin:req=>BASE_URL||'http://'+req.headers.host,sameOrigin,stripPrefix,saveDelay:Number(process.env.COLLAB_SAVE_MS)||1000,renewMs:RENEW_MS,graceMs:Number(process.env.COLLAB_GRACE_MS)||15000});
let stopping=false;async function shutdown(){if(stopping)return;stopping=true;await collaboration.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
const BIND = process.env.BIND || '127.0.0.1';
server.listen(PORT, BIND, () => console.log('wopi-md-editor listening on', BIND + ':' + PORT, MOCK ? '(MOCK)' : ''));
