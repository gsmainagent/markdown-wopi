/**
 * merge-core.js — 零依赖 ESM 行级三方合并纯函数。
 *
 * 约定（重要）：
 *  - 行切分只按 "\n"，"\r" 保留为行内容的一部分（CRLF 输入的 "\r" 不会被吞掉）。
 *  - 文本末尾的换行通过「最后一个空字符串元素」表示：splitLines("a\n") === ["a", ""]，
 *    因此 string[] 结果 join("\n") 可逐字节还原原文（含尾换行）。
 *  - 空串 "" 视作「无行」：splitLines("") === []。
 *  - 行内容原样比较，无 trim / 大小写折叠 / 行内字符级 diff。
 */

/** 按 "\n" 切行；空串 → 无行。 */
function splitLines(text) {
  if (typeof text !== 'string') throw new TypeError('merge-core: expected a string');
  if (text === '') return [];
  return text.split('\n');
}

/**
 * LCS 动态规划求最短编辑脚本（Myers/LCS 均可，此处用 LCS DP）。
 * 返回扁平的逐行操作数组：{type:'equal'|'delete'|'insert', a, b}
 *  - equal: a/b 为两边行下标
 *  - delete: a 为被删行下标，b 为当前 b 游标
 *  - insert: b 为被插入行下标，a 为当前 a 游标（= 插入点，即其后的第一条 a 行下标）
 */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * W;
    const next = row + W;
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[row + j] = dp[next + j + 1] + 1;
      } else {
        const del = dp[next + j];
        const ins = dp[row + j + 1];
        dp[row + j] = del >= ins ? del : ins;
      }
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', a: i, b: j });
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      ops.push({ type: 'delete', a: i, b: j });
      i++;
    } else {
      ops.push({ type: 'insert', a: i, b: j });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'delete', a: i++, b: j });
  while (j < m) ops.push({ type: 'insert', a: i, b: j++ });
  return ops;
}

/**
 * 行级 diff：连续同类型操作合并为一个 run。
 * @returns {Array<{type:'equal'|'insert'|'delete', lines:string[], aStart:number, bStart:number}>}
 */
export function diffLines(aText, bText) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const ops = lcsOps(a, b);
  const out = [];
  let cur = null;
  for (const op of ops) {
    const line = op.type === 'insert' ? b[op.b] : a[op.a];
    if (cur !== null && cur.type === op.type) {
      cur.lines.push(line);
      continue;
    }
    cur = { type: op.type, lines: [line], aStart: op.a, bStart: op.b };
    out.push(cur);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 内部：把一侧的相对 base 改动表示成「段」[baseStart, baseEnd) → lines
 * baseEnd === baseStart 表示纯插入（插入点）。
 * ------------------------------------------------------------------ */

function pushSegment(segs, start, end, lines) {
  const last = segs.length > 0 ? segs[segs.length - 1] : null;
  // 连续的删+插（替换）在 diff 里是分开的 run，但在 base 坐标上首尾相接，合并成一段。
  if (last !== null && start <= last.baseEnd) {
    if (end > last.baseEnd) last.baseEnd = end;
    for (const line of lines) last.lines.push(line);
    return;
  }
  segs.push({ baseStart: start, baseEnd: end, lines });
}

function sideSegments(baseText, sideText) {
  const runs = diffLines(baseText, sideText);
  const segs = [];
  let basePos = 0;
  for (const run of runs) {
    const len = run.lines.length;
    if (run.type === 'equal') {
      basePos += len;
    } else if (run.type === 'delete') {
      pushSegment(segs, basePos, basePos + len, []);
      basePos += len;
    } else {
      pushSegment(segs, basePos, basePos, run.lines.slice());
    }
  }
  return segs;
}

function sameLines(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * 两侧改了「完全相同」的内容时只保留一次：丢弃与 ours 段完全等同（同区间同内容）的 theirs 段。
 */
function dropDuplicateSegments(oursSegs, theirsSegs) {
  return theirsSegs.filter(
    (t) => !oursSegs.some((o) => o.baseStart === t.baseStart && o.baseEnd === t.baseEnd && sameLines(o.lines, t.lines)),
  );
}

/**
 * 冲突判定（base 坐标）：
 *  - 两段都非空：严格相交才冲突（仅边界相接不算，例 A 的 [1,2) 与 [2,3) 不冲突）。
 *  - 两段都是纯插入：插入点相同才冲突。
 *  - 一段纯插入于 p、另一段非空 [s,e)：p 严格落在 (s,e) 内才冲突。
 */
function isConflict(o, t) {
  const oEmpty = o.baseStart === o.baseEnd;
  const tEmpty = t.baseStart === t.baseEnd;
  if (oEmpty && tEmpty) return o.baseStart === t.baseStart;
  if (oEmpty) return t.baseStart < o.baseStart && o.baseStart < t.baseEnd;
  if (tEmpty) return o.baseStart < t.baseStart && t.baseStart < o.baseEnd;
  return o.baseStart < t.baseEnd && t.baseStart < o.baseEnd;
}

/** 冲突段两两相连成簇，每簇 = 一个 conflict hunk。 */
function clusterConflicts(oursSegs, theirsSegs) {
  const nodes = [];
  for (const seg of oursSegs) nodes.push({ seg, side: 'ours' });
  for (const seg of theirsSegs) nodes.push({ seg, side: 'theirs' });
  const nOurs = oursSegs.length;
  const adj = nodes.map(() => []);
  for (let i = 0; i < oursSegs.length; i++) {
    for (let j = 0; j < theirsSegs.length; j++) {
      if (isConflict(oursSegs[i], theirsSegs[j])) {
        adj[i].push(nOurs + j);
        adj[nOurs + j].push(i);
      }
    }
  }
  const seen = nodes.map(() => false);
  const clusters = [];
  for (let s = 0; s < nodes.length; s++) {
    if (seen[s]) continue;
    seen[s] = true;
    if (adj[s].length === 0) continue; // 孤立段 = 非冲突改动
    const members = [];
    const stack = [s];
    while (stack.length > 0) {
      const cur = stack.pop();
      members.push(nodes[cur]);
      for (const nx of adj[cur]) {
        if (!seen[nx]) {
          seen[nx] = true;
          stack.push(nx);
        }
      }
    }
    clusters.push(members);
  }
  return clusters;
}

/** 在 base 区间 [start,end) 上套用某一侧（该簇内）的段，未被覆盖的 base 行原样保留。 */
function renderRegion(baseLines, start, end, segs) {
  const list = segs.slice().sort((x, y) => x.baseStart - y.baseStart);
  const out = [];
  let pos = start;
  for (const s of list) {
    if (s.baseStart < pos) continue; // 防御：不应出现重叠段
    if (s.baseStart > pos) {
      for (let k = pos; k < s.baseStart; k++) out.push(baseLines[k]);
    }
    for (const line of s.lines) out.push(line);
    if (s.baseEnd > pos) pos = s.baseEnd;
  }
  if (pos < end) {
    for (let k = pos; k < end; k++) out.push(baseLines[k]);
  }
  return out;
}

function analyze(baseText, oursText, theirsText) {
  const baseLines = splitLines(baseText);
  const oursSegs = sideSegments(baseText, oursText);
  const theirsRaw = sideSegments(baseText, theirsText);
  const theirsSegs = dropDuplicateSegments(oursSegs, theirsRaw);
  const groups = clusterConflicts(oursSegs, theirsSegs);
  const infos = groups.map((members) => {
    let baseStart = Infinity;
    let baseEnd = -Infinity;
    for (const m of members) {
      if (m.seg.baseStart < baseStart) baseStart = m.seg.baseStart;
      if (m.seg.baseEnd > baseEnd) baseEnd = m.seg.baseEnd;
    }
    return { id: -1, members, baseStart, baseEnd, oursContent: [], theirsContent: [] };
  });
  infos.sort((x, y) => x.baseStart - y.baseStart || x.baseEnd - y.baseEnd);
  infos.forEach((info, idx) => {
    info.id = idx;
    for (const m of info.members) m.seg.clusterId = idx;
    info.oursContent = renderRegion(
      baseLines,
      info.baseStart,
      info.baseEnd,
      info.members.filter((m) => m.side === 'ours').map((m) => m.seg),
    );
    info.theirsContent = renderRegion(
      baseLines,
      info.baseStart,
      info.baseEnd,
      info.members.filter((m) => m.side === 'theirs').map((m) => m.seg),
    );
  });
  return { baseLines, oursSegs, theirsSegs, infos };
}

function byStart(x, y) {
  return x.baseStart - y.baseStart || x.baseEnd - y.baseEnd;
}

/**
 * 渲染合并结果。pickFor(info) 返回该 conflict hunk 采用的 string[]。
 * 非冲突改动按各自一侧自动落位（同一插入点至多一侧，否则已判为冲突）。
 */
function renderMerge(ctx, pickFor) {
  const { baseLines, oursSegs, theirsSegs, infos } = ctx;
  const baseLen = baseLines.length;
  const oList = oursSegs.filter((s) => s.clusterId === undefined).sort(byStart);
  const tList = theirsSegs.filter((s) => s.clusterId === undefined).sort(byStart);
  const out = [];
  let pos = 0;
  let oi = 0;
  let ti = 0;
  let ci = 0;
  const guardLimit = 8 * (baseLen + oList.length + tList.length + infos.length) + 1000;
  let guard = 0;
  for (;;) {
    if (++guard > guardLimit) throw new Error('merge-core: render loop did not converge');
    // 1) 该点的纯插入（非冲突段）先落地
    while (oi < oList.length && oList[oi].baseStart === pos && oList[oi].baseEnd === pos) {
      for (const line of oList[oi].lines) out.push(line);
      oi++;
    }
    while (ti < tList.length && tList[ti].baseStart === pos && tList[ti].baseEnd === pos) {
      for (const line of tList[ti].lines) out.push(line);
      ti++;
    }
    // 2) 该点开始的 conflict hunk 整段取材
    if (ci < infos.length && infos[ci].baseStart === pos) {
      const info = infos[ci];
      ci++;
      for (const line of pickFor(info)) out.push(line);
      if (info.baseEnd > pos) pos = info.baseEnd;
      while (oi < oList.length && oList[oi].baseStart < pos) oi++;
      while (ti < tList.length && tList[ti].baseStart < pos) ti++;
      continue;
    }
    if (pos >= baseLen) break;
    // 3) 该点开始的有长度改动（替换/删除），或原样输出 base 行
    let advanced = false;
    while (oi < oList.length && oList[oi].baseStart === pos) {
      const s = oList[oi++];
      for (const line of s.lines) out.push(line);
      if (s.baseEnd > pos) pos = s.baseEnd;
      advanced = true;
    }
    while (ti < tList.length && tList[ti].baseStart === pos) {
      const s = tList[ti++];
      for (const line of s.lines) out.push(line);
      if (s.baseEnd > pos) pos = s.baseEnd;
      advanced = true;
    }
    if (!advanced) {
      out.push(baseLines[pos]);
      pos++;
    }
  }
  return out;
}

/**
 * 三方合并且只产出「默认取 ours」的初步结果 + 需人工选择的 conflict hunks。
 */
export function buildHunks(base, ours, theirs) {
  const ctx = analyze(base, ours, theirs);
  const hunks = ctx.infos.map((info) => ({
    id: info.id,
    kind: 'conflict',
    baseStart: info.baseStart,
    baseEnd: info.baseEnd,
    ours: info.oursContent.slice(),
    theirs: info.theirsContent.slice(),
  }));
  const merged = renderMerge(ctx, (info) => info.oursContent);
  return { merged, hunks };
}

/**
 * 按 decisions 覆盖 conflict hunk（未决的默认 ours 并计入 pending）。
 * @param {Array<{id:number, pick:'ours'|'theirs'}>} decisions
 */
export function applyChoices(base, ours, theirs, decisions) {
  const ctx = analyze(base, ours, theirs);
  const picks = new Map();
  if (Array.isArray(decisions)) {
    for (const d of decisions) {
      if (d !== null && typeof d === 'object' && typeof d.id === 'number' && (d.pick === 'ours' || d.pick === 'theirs')) {
        picks.set(d.id, d.pick);
      }
    }
  }
  let pending = 0;
  const text = renderMerge(ctx, (info) => {
    const pick = picks.get(info.id);
    if (pick === 'theirs') return info.theirsContent;
    if (pick !== 'ours') pending++;
    return info.oursContent;
  });
  return { text, pending };
}
