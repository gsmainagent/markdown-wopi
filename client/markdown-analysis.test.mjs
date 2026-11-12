import test from 'node:test';import assert from 'node:assert/strict';
import {unclosedFences,analyzeMarkdown} from './src/markdown-analysis.js';

const F=String.fromCharCode(96).repeat(3),T=String.fromCharCode(126).repeat(3);

test('a properly closed fence is not reported',()=>{
 const doc=['# 标题','',F+'js','const a=1;','const b=2;',F,'','## 下一节'].join('\n');
 assert.deepEqual(unclosedFences(doc),[]);
});

test('an unclosed fence reports the opening line and marker',()=>{
 const doc=['## 定理','',F,'$$\\frac{a}{b}$$','### 柯西中值定理'].join('\n');
 assert.deepEqual(unclosedFences(doc),[{line:3,marker:F,info:''}]);
});

test('an info string opens, a bare marker of the same kind closes',()=>{
 const doc=[F+'text','body',F,'## after'].join('\n');
 assert.deepEqual(unclosedFences(doc),[]);
});

test('a longer outer fence is not closed by a shorter inner one',()=>{
 const B4=String.fromCharCode(96).repeat(4);
 assert.deepEqual(unclosedFences([B4,'nested',F,'still inside'].join('\n')),[{line:1,marker:B4,info:''}],'a 3-backtick line must not close a 4-backtick fence');
 assert.deepEqual(unclosedFences([B4,'nested',B4,'## after'].join('\n')),[],'the same length closes it');
});

test('tilde fences behave the same way',()=>{
 assert.deepEqual(unclosedFences(T+'sh\nls\n'+T),[]);
 assert.deepEqual(unclosedFences(T+'sh\nls'),[{line:1,marker:T,info:'sh'}]);
});

test('up to three leading spaces still count as a fence',()=>{
 assert.deepEqual(unclosedFences('   '+F+'js\nx\n   '+F),[]);
 assert.deepEqual(unclosedFences('    '+F+'js\nx'),[]); // indented 4 spaces is not a fence
});

test('two separate closed blocks are not confused with an unclosed one',()=>{
 const doc=[F+'js','a',F,'','text',F+'py','b',F,''].join('\n');
 assert.deepEqual(unclosedFences(doc),[]);
});

test('analyzeMarkdown emits one warning that points at the opening line',()=>{
 const doc=['# 标题','',F,'$$x$$','','### 后面不上了色的标题'].join('\n');
 const {diagnostics}=analyzeMarkdown(doc);
 const fenceWarnings=diagnostics.filter(d=>d.message.includes('代码围栏未闭合'));
 assert.equal(fenceWarnings.length,1);
 assert.match(fenceWarnings[0].message,/第 3 行/);
 assert.ok(fenceWarnings[0].to>fenceWarnings[0].from);
 assert.equal(fenceWarnings[0].severity,'warning');
});

test('the swallowed heading really disappears from the outline, which is why the warning matters',()=>{
 const doc=['# 标题','## 有色的标题','',F,'$$x$$','### 没色的标题'].join('\n');
 const {headings}=analyzeMarkdown(doc);
 assert.deepEqual(headings.map(h=>h.text),['标题','有色的标题']);
 assert.equal(doc.split('\n')[5].startsWith('###'),true);
});

test('a balanced document produces no fence warning at all',()=>{
 const doc=['# 柯西中值定理','','$'+String.fromCharCode(92)+'frac{1}{2}$','','```js','const x=1;','```','','## 例题'].join('\n');
 assert.equal(analyzeMarkdown(doc).diagnostics.filter(d=>d.message.includes('围栏')).length,0);
});
