import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderMarkdown } from './src/preview.js';
import { hostTheme, followTheme } from './src/theme.js';
const cases=[["screenshot formula next to Chinese","求$\\lim\\limits_{n\\to\\infty}\\sin^2\\left(\\pi\\sqrt{n^2+n}\\right)$ 看根号","class=\"katex\"",1],["display dollars","$$\n\\lim\\limits_{n\\to\\infty}\\sin^2\\left(\\pi\\sqrt{n^2+n}\\right)\n$$","class=\"katex-display\"",1],["inline brackets","内联 \\(x_1^2+\\frac{1}{2}\\) 公式","class=\"katex\"",1],["display brackets","\\[\\sqrt{x^2+1}\\]","class=\"katex-display\"",1],["math fence","```math\nx^2\n```","class=\"katex-display\"",1],["code span","`$\\lim\\limits_{n\\to\\infty}\\sin^2\\left(\\pi\\sqrt{n^2+n}\\right)$`","<code>",0],["code fence","```tex\n$\\lim\\limits_{n\\to\\infty}\\sin^2\\left(\\pi\\sqrt{n^2+n}\\right)$\n```","<pre><code",0],["escaped dollar","\\$x+1$","$x+1$",0],["currency","价格 $5 和 $10，正常文字","$5",0],["bad formula fallback","$\\nonexistentcommand{x}$ 后文 **还在**","还在",null],["normal Markdown","# Heading\n\n**粗体** [link](https://example.com)","<strong>粗体</strong>",0]];
for(const [name,input,part,count] of cases)test(name,()=>{
 const html=renderMarkdown(input);assert.ok(html.includes(part),name+' output mismatch');
 if(count!==null)assert.equal(html.split('class="katex"').length-1,count);
 if(count)assert.ok(html.includes('<math'));
});
test('HTML and TeX HTML extensions remain untrusted',()=>{
 const html=renderMarkdown("<img src=x onerror=alert(1)> $\\href{javascript:alert(1)}{bad}$ $\\htmlClass{injected}{x}$");
 assert.ok(!html.includes('<img '));assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('class="injected"'));
});
test('Cloudreve numeric launch values',()=>{
 assert.equal(hostTheme('2'),'dark');assert.equal(hostTheme('1'),'light');assert.equal(hostTheme('darkmode'),null);
 assert.equal(hostTheme('true'),'dark');assert.equal(hostTheme('false'),'light');assert.equal(hostTheme('system'),null);
});
function simulate(theme,initial,after){
 let handler;const seen=[];const classes=new Set();const media={matches:initial,addEventListener:(n,f)=>handler=f,removeEventListener:(n,f)=>assert.equal(f,handler)};
 globalThis.location={hash:'#s=synthetic'+(theme?'&theme='+theme:''),search:''};
 globalThis.document={documentElement:{style:{},classList:{toggle:(n,b)=>b?classes.add(n):classes.delete(n)}}};
 globalThis.matchMedia=()=>media;
 const stop=followTheme(d=>seen.push(d));media.matches=after;handler();stop();
 return {seen,dark:classes.has('dark'),scheme:document.documentElement.style.colorScheme};
}
test('OS theme changes live without reload',()=>assert.deepEqual(simulate('',false,true),{seen:[false,true],dark:true,scheme:'dark'}));
test('Cloudreve dark wins over OS light',()=>assert.deepEqual(simulate('2',false,false).seen,[true,true]));
test('Cloudreve light wins over OS dark',()=>assert.deepEqual(simulate('1',true,true).seen,[false,false]));
test('unknown theme falls back to OS',()=>assert.deepEqual(simulate('darkmode',true,false).seen,[true,false]));
test('React bootstrap retains host/system theme without manual or persisted override',()=>{
 const html=fs.readFileSync(new URL('./workbench/index.html',import.meta.url),'utf8');
 const entry=fs.readFileSync(new URL('./workbench/main.jsx',import.meta.url),'utf8');
 const main=fs.readFileSync(new URL('./src/workbench/main.jsx',import.meta.url),'utf8');
 const app=fs.readFileSync(new URL('./src/workbench/App.jsx',import.meta.url),'utf8');
 const session=fs.readFileSync(new URL('./src/workbench/session.js',import.meta.url),'utf8');
 assert.ok(!html.includes('btn-theme')&&!html.includes('🌗')&&!app.includes('btn-theme'));
 assert.ok(!session.includes('wopimd-theme')&&!html.includes('localStorage'));
 assert.ok(html.includes('prefers-color-scheme')&&html.includes("get('theme')"));
 assert.ok(html.includes('src="./main.jsx"')&&entry.includes('../src/workbench/main.jsx'));
 assert.ok(main.includes("import './workbench.css'"));
 assert.ok(session.includes('followTheme(')&&session.includes('monaco.editor.setTheme'));
});
