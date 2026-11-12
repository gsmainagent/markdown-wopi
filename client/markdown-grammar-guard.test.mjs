import test from 'node:test';import assert from 'node:assert/strict';
import {patchMarkdownGrammar,angleGuard} from './src/markdown-grammar-guard.js';
import {language as grammar} from './src/markdown-grammar-guard.js';

const B=String.fromCharCode(92);
// Shapes taken from the reported note: math angle brackets with no closing '>' on the line.
const mathLines=[
 '-1<y_{k+1}<y_{k}<y_{k-1}<1',  // generic interlacing shape, no closing '>' on the line
 '已有 $j$ 个互异根 $a_1<a_2<a_3$ 排成一串',
 '而 $|'+B+'xi|<1$ 使左边系数为正',
 '则存在 $'+B+'xi'+B+'in(a,b),\\ f'+B+"('"+B+'xi)=0$。',
];
const htmlLines=['<div class="x">正文','<span id="a">文字</span>','<br/>','<p>'];

test('the guard refuses to open a tag state for math angle brackets',()=>{
 for(const line of mathLines){
  const m=angleGuard.exec(line);
  assert.equal(m,null,'must not treat math "<x" as an HTML tag: '+line.slice(0,24));
 }
});

test('the guard still recognises real inline HTML',()=>{
 for(const line of htmlLines){
  const m=angleGuard.exec(line);
  assert.ok(m&&/^[a-zA-Z]/.test(m[1]),'real tag must still match: '+line);
 }
});

test('patching the real Monaco grammar replaces the unguarded opener exactly once',()=>{
 const raw=String.fromCharCode(60)+'(\\w+)(\\-|\\w)*';
 const before=grammar.tokenizer.html.filter(r=>Array.isArray(r)&&r[0]instanceof RegExp&&r[0].source===raw).length;
 assert.equal(before,1,'expected exactly one unguarded opener to exist upstream, found '+before);
 const res=patchMarkdownGrammar(grammar);
 assert.equal(res.patched,true,res.reason);
 assert.equal(res.replaced,1,res.reason);
 assert.equal(grammar.tokenizer.html.filter(r=>Array.isArray(r)&&r[0]instanceof RegExp&&r[0].source===raw).length,0,'unguarded opener survived');
});

test('a second patch call is a no-op and keeps exactly one guarded opener',()=>{
 const again=patchMarkdownGrammar(grammar);
 assert.equal(again.patched,false);
 assert.equal(again.reason,'already patched');
 const guarded=grammar.tokenizer.html.filter(r=>Array.isArray(r)&&r[0]instanceof RegExp&&r[0].source===angleGuard.source);
 assert.equal(guarded.length,1);
});

test('self closing tags, closing tags and comments all keep their own rules',()=>{
 const sources=grammar.tokenizer.html.filter(r=>Array.isArray(r)&&r[0]instanceof RegExp).map(r=>r[0].source);
 assert.ok(sources.some(s=>s.includes('\\/\\/>')||s.includes('/>')),'self-closing rule must remain: '+sources.join(' | '));
 assert.ok(sources.some(s=>s.startsWith('<\\/')),'closing-tag rule must remain');
 assert.ok(sources.some(s=>s.includes('<!--')),'comment rule must remain');
 assert.equal(sources.length,4,'html state must keep all four rules, got '+sources.length);
});
