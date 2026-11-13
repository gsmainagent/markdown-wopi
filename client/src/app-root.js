// 子路径部署支持：服务可能挂在站点根，也可能挂在反向代理剥掉的前缀后面
// （nginx: `location /mdedit/ { proxy_pass http://127.0.0.1:3001/; }`）。
// 代理剥掉前缀后，后端看到的永远是 /api、/collab、/static，浏览器看到的却是
// /mdedit/... ⇒ 任何写死的根绝对路径都会掉到站点根去（实测 404）。
// 文档页固定位于 <root>static/monaco-editor.html，所以「应用根」就是路径里
// 最后一段 /static/ 之前的部分；不含 /static/ 时退回站点根。
// 这样同一份构建产物在根部署和前缀部署下都对，不需要为子路径单独打包。
export function appRootOf(pathname) {
  const index = String(pathname || '/').lastIndexOf('/static/');
  if (index < 0) return '/';
  return String(pathname).slice(0, index + 1);
}

export const APP_ROOT = appRootOf(typeof location === 'undefined' ? '/' : location.pathname);

// '/api/doc/x' -> '<root>api/doc/x'；也接受已经不带前导斜杠的写法。
export function appUrl(path) {
  return APP_ROOT + String(path).replace(/^\/+/, '');
}

// 协作 WS 也挂在同一个前缀下面，location.origin 本身不含路径。
export function appWsUrl(path) {
  return location.origin.replace(/^http/, 'ws') + appUrl(path);
}
