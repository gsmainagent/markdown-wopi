import test from 'node:test';import assert from 'node:assert/strict';
import {appRootOf} from './src/app-root.js';

// 子路径部署时后端收到的是剥掉前缀的路径，只有浏览器地址栏还带着前缀；
// 应用根必须从文档路径里推出来，否则 /api、/collab、worker 全都会掉到站点根。
test('the app root is whatever precedes the last /static/ segment',()=>{
  assert.equal(appRootOf('/static/monaco-editor.html'),'/');
  assert.equal(appRootOf('/mdedit/static/monaco-editor.html'),'/mdedit/');
  assert.equal(appRootOf('/a/b/mdedit/static/monaco-editor.html'),'/a/b/mdedit/');
  assert.equal(appRootOf('/mdedit/static/monaco-editor.html#s=abc'),'/mdedit/');   // hash 不参与 pathname
  assert.equal(appRootOf('/'),'/','a page outside /static/ falls back to the site root');
});
test('a second /static/ in the path does not shorten the prefix',()=>{
  assert.equal(appRootOf('/static/mdedit/static/monaco-editor.html'),'/static/mdedit/');
});
