import fs from 'node:fs';
import crypto from 'node:crypto';
const base=new URL('../../static/workbench/',import.meta.url),index=new URL('index.html',base),target=new URL('../../static/monaco-editor.html',import.meta.url);
let html=fs.readFileSync(index,'utf8');
if(!html.includes('stylesheet')||!html.includes('prefers-color-scheme')||!html.includes('type="module"'))throw Error('Framework HTML/CSS/theme entry missing');
// 入口页会从 static/workbench/index.html 上移一层写成 static/monaco-editor.html，
// 所以资源引用统一收敛成「相对文档」的 workbench/assets/…：不带站点根前缀，
// 根部署与 /mdedit/ 这类 strip 前缀的子路径部署都能命中（绝对路径在后者下必 404）。
const toRelative=(ref)=>'workbench/assets/'+ref.split('/').pop();
const refs=[...html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)].map((m)=>m[1]);
if(!refs.some((p)=>p.endsWith('.css'))||!refs.some((p)=>p.endsWith('.js')))throw Error('Hashed module/style references missing');
for(const ref of refs)html=html.split('"'+ref+'"').join('"'+toRelative(ref)+'"');
if(/(?:src|href)="(?:\/|\.\/)assets\//.test(html))throw Error('A root- or build-relative asset reference survived the rewrite');
// 模板里用 <link rel="icon" href="data:,"> 压掉 favicon 请求；发布时换成真图标。
// 用相对 href：入口页固定在 <前缀>/static/monaco-editor.html，所以相对路径天然带上前缀。
const iconLinks='<link rel="icon" type="image/png" sizes="16x16" href="icon-16.png">'
 +'<link rel="icon" type="image/png" sizes="32x32" href="icon-32.png">'
 +'<link rel="shortcut icon" href="favicon.ico">'
 +'<link rel="apple-touch-icon" href="icon-192.png">';
if(!/<link rel="icon" href="data:,">/.test(html))throw Error('favicon placeholder missing in built entry');
html=html.replace(/<link rel="icon" href="data:,">/,iconLinks);
for(const f of ['icon-16.png','icon-32.png','favicon.ico','icon-192.png'])if(!fs.existsSync(new URL(f,new URL('../../static/',import.meta.url))))throw Error('favicon asset not built: '+f);
const files={};
for(const ref of refs){
 const relative=toRelative(ref);
 const body=fs.readFileSync(new URL(relative,new URL('../../static/',import.meta.url)));
 if(!body.length)throw Error('Empty built resource');
 files[relative]={bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')};
 if(relative.endsWith('.css')){const css=body.toString();for(const token of ['.workbench','.monaco-editor','.katex'])if(!css.includes(token))throw Error('CSS pipeline missing '+token);}
}
fs.writeFileSync(target,html);
fs.writeFileSync(new URL('../../build-entry-report.json',import.meta.url),JSON.stringify({status:'passed',files,themeBootstrap:true},null,2)+'\n');
console.log('React workbench entry verified: relative hashed JS/CSS exist; shell, Monaco and KaTeX styles included');
