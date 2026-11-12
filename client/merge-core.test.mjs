import test from 'node:test';
import assert from 'node:assert/strict';

import { diffLines, buildHunks, applyChoices } from './src/merge-core.js';

/* 约定：string[] 结果 join("\n") 还原文本；尾换行 = 末位空字符串元素。 */
const asText = (lines) => lines.join('\n');

/* ---------------- 算例 A ---------------- */
test('A: 两侧改不同行 -> 自动合并, 无冲突', () => {
  const base = 'a\nb\nc';
  const ours = 'a\nB\nc';
  const theirs = 'a\nb\nC';
  const r = buildHunks(base, ours, theirs);
  assert.deepStrictEqual(r, { merged: ['a', 'B', 'C'], hunks: [] });
  const c = applyChoices(base, ours, theirs, []);
  assert.deepStrictEqual(c, { text: ['a', 'B', 'C'], pending: 0 });
});

test('A-diff: diffLines 精确的空/删/插分组', () => {
  assert.deepStrictEqual(diffLines('a\nb\nc', 'a\nB\nc'), [
    { type: 'equal', lines: ['a'], aStart: 0, bStart: 0 },
    { type: 'delete', lines: ['b'], aStart: 1, bStart: 1 },
    { type: 'insert', lines: ['B'], aStart: 2, bStart: 1 },
    { type: 'equal', lines: ['c'], aStart: 2, bStart: 2 },
  ]);
  assert.deepStrictEqual(diffLines('a', 'a\nb'), [
    { type: 'equal', lines: ['a'], aStart: 0, bStart: 0 },
    { type: 'insert', lines: ['b'], aStart: 1, bStart: 1 },
  ]);
});

/* ---------------- 算例 B ---------------- */
test('B: 同一行两侧改成不同内容 -> 1 个冲突, 两种 pick', () => {
  const base = 'a\nb\nc';
  const ours = 'a\nOURS\nc';
  const theirs = 'a\nTHEIRS\nc';
  const r = buildHunks(base, ours, theirs);
  assert.deepStrictEqual(r, {
    merged: ['a', 'OURS', 'c'],
    hunks: [{ id: 0, kind: 'conflict', baseStart: 1, baseEnd: 2, ours: ['OURS'], theirs: ['THEIRS'] }],
  });
  assert.deepStrictEqual(applyChoices(base, ours, theirs, [{ id: 0, pick: 'ours' }]), {
    text: ['a', 'OURS', 'c'],
    pending: 0,
  });
  assert.deepStrictEqual(applyChoices(base, ours, theirs, [{ id: 0, pick: 'theirs' }]), {
    text: ['a', 'THEIRS', 'c'],
    pending: 0,
  });
  // 未决 -> 默认 ours 且 pending 1
  assert.deepStrictEqual(applyChoices(base, ours, theirs, []), { text: ['a', 'OURS', 'c'], pending: 1 });
});

/* ---------------- 算例 C ---------------- */
test('C: 仅 ours 追加, theirs 未变 -> 直接取 ours, 无冲突', () => {
  const base = 'a\nb';
  const ours = 'a\nb\nX';
  const theirs = 'a\nb';
  assert.deepStrictEqual(buildHunks(base, ours, theirs), { merged: ['a', 'b', 'X'], hunks: [] });
});

/* ---------------- 算例 D ---------------- */
test('D: 两侧改成完全相同内容 -> 只出现一次, 无冲突', () => {
  const base = 'a';
  const ours = 'A';
  const theirs = 'A';
  assert.deepStrictEqual(buildHunks(base, ours, theirs), { merged: ['A'], hunks: [] });
  assert.deepStrictEqual(applyChoices(base, ours, theirs, []), { text: ['A'], pending: 0 });
  assert.deepStrictEqual(diffLines('a', 'A'), [
    { type: 'delete', lines: ['a'], aStart: 0, bStart: 0 },
    { type: 'insert', lines: ['A'], aStart: 1, bStart: 0 },
  ]);
});

/* ---------------- 算例 E ---------------- */
test('E: 一侧删除 vs 另一侧修改 -> 1 个冲突', () => {
  const base = 'a\nb';
  const ours = 'a';
  const theirs = 'a\nB2';
  assert.deepStrictEqual(buildHunks(base, ours, theirs), {
    merged: ['a'],
    hunks: [{ id: 0, kind: 'conflict', baseStart: 1, baseEnd: 2, ours: [], theirs: ['B2'] }],
  });
  assert.deepStrictEqual(applyChoices(base, ours, theirs, [{ id: 0, pick: 'ours' }]), { text: ['a'], pending: 0 });
  assert.deepStrictEqual(applyChoices(base, ours, theirs, [{ id: 0, pick: 'theirs' }]), {
    text: ['a', 'B2'],
    pending: 0,
  });
});

/* ---------------- 算例 F ---------------- */
test('F: base 为空串 -> 两侧各自插入即冲突', () => {
  const base = '';
  const ours = 'x';
  const theirs = 'y';
  assert.deepStrictEqual(buildHunks(base, ours, theirs), {
    merged: ['x'],
    hunks: [{ id: 0, kind: 'conflict', baseStart: 0, baseEnd: 0, ours: ['x'], theirs: ['y'] }],
  });
  assert.deepStrictEqual(applyChoices(base, ours, theirs, [{ id: 0, pick: 'ours' }]), { text: ['x'], pending: 0 });
  assert.deepStrictEqual(applyChoices(base, ours, theirs, [{ id: 0, pick: 'theirs' }]), { text: ['y'], pending: 0 });
});

/* ---------------- 算例 G ---------------- */
test('G1: 尾换行保留（base/发起方都带尾换行）', () => {
  const r = buildHunks('a\n', 'a\nb\n', 'a\n');
  assert.deepStrictEqual(r, { merged: ['a', 'b', ''], hunks: [] });
  assert.equal(asText(r.merged), 'a\nb\n');
  assert.equal(asText(r.merged).endsWith('\n'), true);
});

test('G2: 无尾换行时不得凭空多出空行', () => {
  const r = buildHunks('a', 'a\nb', 'a');
  assert.deepStrictEqual(r, { merged: ['a', 'b'], hunks: [] });
  assert.equal(asText(r.merged), 'a\nb');
  assert.equal(asText(r.merged).endsWith('\n'), false);
});

/* ---------------- 算例 H ---------------- */
test('H: 两侧在同一 base 行前后各插入不同内容 -> 两段都保留, 无冲突', () => {
  const base = 'a\nb';
  const ours = 'a\nX\nb';
  const theirs = 'a\nb\nY';
  assert.deepStrictEqual(buildHunks(base, ours, theirs), { merged: ['a', 'X', 'b', 'Y'], hunks: [] });
});

/* ---------------- 其余要求 ---------------- */
test('空文本: 三者皆空', () => {
  assert.deepStrictEqual(diffLines('', ''), []);
  assert.deepStrictEqual(buildHunks('', '', ''), { merged: [], hunks: [] });
  assert.deepStrictEqual(applyChoices('', '', '', []), { text: [], pending: 0 });
  assert.deepStrictEqual(diffLines('', 'a\nb'), [
    { type: 'insert', lines: ['a', 'b'], aStart: 0, bStart: 0 },
  ]);
});

test('纯删除: 仅 ours 删中间一行', () => {
  const r = buildHunks('a\nb\nc', 'a\nc', 'a\nb\nc');
  assert.deepStrictEqual(r, { merged: ['a', 'c'], hunks: [] });
  assert.deepStrictEqual(applyChoices('a\nb\nc', 'a\nc', 'a\nb\nc', []), { text: ['a', 'c'], pending: 0 });
});

test('连续多冲突: >=3 个 hunk, id 递增且 baseStart 单调不减', () => {
  const base = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'].join('\n');
  const oursLines = ['l0', 'O1', 'l2', 'l3', 'O4', 'l5', 'l6', 'O7', 'l8', 'l9'];
  const theirsLines = ['l0', 'T1', 'l2', 'l3', 'T4', 'l5', 'l6', 'T7', 'l8', 'l9'];
  const ours = oursLines.join('\n');
  const theirs = theirsLines.join('\n');
  const r = buildHunks(base, ours, theirs);
  assert.equal(r.hunks.length, 3);
  assert.deepStrictEqual(
    r.hunks.map((h) => [h.id, h.baseStart, h.baseEnd]),
    [
      [0, 1, 2],
      [1, 4, 5],
      [2, 7, 8],
    ],
  );
  for (let i = 1; i < r.hunks.length; i++) {
    assert.equal(r.hunks[i].id, r.hunks[i - 1].id + 1);
    assert.ok(r.hunks[i].baseStart >= r.hunks[i - 1].baseStart);
  }
  assert.deepStrictEqual(r.merged, oursLines);
  // 只决定第一个，其余默认 ours 并计入 pending
  assert.deepStrictEqual(applyChoices(base, ours, theirs, [{ id: 0, pick: 'theirs' }]), {
    text: ['l0', 'T1', 'l2', 'l3', 'O4', 'l5', 'l6', 'O7', 'l8', 'l9'],
    pending: 2,
  });
  // 全部决定 -> pending 0，顺序按 id 应用
  assert.deepStrictEqual(
    applyChoices(base, ours, theirs, [
      { id: 0, pick: 'theirs' },
      { id: 1, pick: 'ours' },
      { id: 2, pick: 'theirs' },
    ]),
    { text: ['l0', 'T1', 'l2', 'l3', 'O4', 'l5', 'l6', 'T7', 'l8', 'l9'], pending: 0 },
  );
});

test('\\r 属于行内容, 不被吞掉', () => {
  const base = 'a\r\nb';
  const ours = 'a\r\nB';
  const theirs = 'a\r\nb';
  const r = buildHunks(base, ours, theirs);
  assert.deepStrictEqual(r, { merged: ['a\r', 'B'], hunks: [] });
  assert.equal(r.merged[0], 'a\r');
  assert.deepStrictEqual(diffLines(base, base), [{ type: 'equal', lines: ['a\r', 'b'], aStart: 0, bStart: 0 }]);
  // CRLF 冲突也要保住 \r
  const conflict = buildHunks('a\r\nb', 'a\r\nOURS', 'a\r\nTHEIRS');
  assert.deepStrictEqual(conflict.hunks, [
    { id: 0, kind: 'conflict', baseStart: 1, baseEnd: 2, ours: ['OURS'], theirs: ['THEIRS'] },
  ]);
});

test('两侧相同的插入去重（插入点相同、内容相同）', () => {
  const r = buildHunks('a', 'a\nX', 'a\nX');
  assert.deepStrictEqual(r, { merged: ['a', 'X'], hunks: [] });
  assert.deepStrictEqual(applyChoices('a', 'a\nX', 'a\nX', []), { text: ['a', 'X'], pending: 0 });
});

test('大输入: 3000 行仅改 3 处, 2 秒内完成', () => {
  const total = 3000;
  const baseList = Array.from({ length: total }, (_, i) => `line-${i}`);
  const oursList = baseList.slice();
  const theirsList = baseList.slice();
  oursList[100] = 'ours-100';
  oursList[1500] = 'ours-1500';
  oursList[2900] = 'ours-2900';
  theirsList[100] = 'theirs-100';
  theirsList[1500] = 'theirs-1500';
  theirsList[2900] = 'theirs-2900';
  const base = baseList.join('\n');
  const ours = oursList.join('\n');
  const theirs = theirsList.join('\n');

  const start = Date.now();
  const r = buildHunks(base, ours, theirs);
  const c = applyChoices(base, ours, theirs, [{ id: 1, pick: 'theirs' }]);
  const elapsed = Date.now() - start;
  console.log(`[timing] 3000 行 / 3 处改动: buildHunks + applyChoices = ${elapsed}ms`);

  assert.equal(r.hunks.length, 3);
  assert.deepStrictEqual(
    r.hunks.map((h) => h.baseStart),
    [100, 1500, 2900],
  );
  assert.equal(r.merged.length, total);
  assert.equal(r.merged[100], 'ours-100');
  assert.equal(c.pending, 2);
  assert.equal(c.text[1500], 'theirs-1500');
  assert.equal(c.text[2900], 'ours-2900');
  assert.ok(elapsed < 2000, `耗时 ${elapsed}ms 超过 2000ms`);
});
