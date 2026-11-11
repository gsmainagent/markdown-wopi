import test from 'node:test';import assert from 'node:assert/strict';
import {OUTLINE_DRAWER_AT,SPLIT_MIN_WIDTH,layoutForWidth,outlineOpenForWidth} from './src/workbench/state.js';

test('a mid-width window keeps the preview pane (the reported bug)',()=>{
 // 660 CSS px is what a ~986 device-px screenshot at 150% zoom measures; it must stay split.
 assert.equal(layoutForWidth(1280),'split');
 assert.equal(layoutForWidth(760),'split');
 assert.equal(layoutForWidth(660),'split');
 assert.equal(layoutForWidth(SPLIT_MIN_WIDTH),'split');
});

test('only a genuinely narrow container falls back to editor-only',()=>{
 assert.equal(layoutForWidth(SPLIT_MIN_WIDTH-1),'editor');
 assert.equal(layoutForWidth(400),'editor');
 assert.equal(layoutForWidth(0),'editor');
});

test('the outline still becomes a drawer at the original width',()=>{
 assert.equal(OUTLINE_DRAWER_AT,760);
 assert.equal(outlineOpenForWidth(761),true);
 assert.equal(outlineOpenForWidth(760),true);
 assert.equal(outlineOpenForWidth(660),false);
 assert.equal(outlineOpenForWidth(659),false);
});

test('the two thresholds stay independent',()=>{
 assert.ok(SPLIT_MIN_WIDTH<OUTLINE_DRAWER_AT,'preview must survive widths that already lost the sidebar');
 const drawerOnly=[SPLIT_MIN_WIDTH,700,759].filter(w=>layoutForWidth(w)==='split'&&outlineOpenForWidth(w)===false);
 assert.equal(drawerOnly.length,3);
});
