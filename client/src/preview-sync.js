export function interpolate(points, value, from = 'line', to = 'top') {
  if (!points.length) return 0;
  if (value <= points[0][from]) return points[0][to];
  for (let i = 1; i < points.length; i++) {
    const a = points[i-1], b = points[i];
    if (value <= b[from]) return a[to] + (b[to]-a[to]) * (value-a[from]) / Math.max(0.001, b[from]-a[from]);
  }
  return points.at(-1)[to];
}
export function connectPreview(view, preview) {
  let enabled = true, points = [], stale = true, frame = 0, expectedEditor = null, expectedPreview = null, active = null;
  const nodes = () => [...preview.querySelectorAll('[data-source-line]')];
  function map() {
    if (!stale) return points;
    const origin = preview.getBoundingClientRect().top;
    const candidates = nodes().map(el => ({ line: Number(el.dataset.sourceLine), top: el.getBoundingClientRect().top - origin + preview.scrollTop })).sort((a,b) => a.line-b.line || a.top-b.top);
    points = [{ line: 1, top: 0 }];
    for (const p of candidates) if (p.line > points.at(-1).line && p.top >= points.at(-1).top) points.push(p);
    points.push({ line: view.state.doc.lines+1, top: Math.max(preview.scrollHeight, points.at(-1).top) });
    stale = false; return points;
  }
  function fromEditor() {
    if (!enabled) return;
    const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    const line = view.state.doc.lineAt(block.from).number + Math.max(0, view.scrollDOM.scrollTop-block.top)/Math.max(1,block.height);
    const top = interpolate(map(), line);
    preview.scrollTop = top; expectedPreview = preview.scrollTop;
  }
  function sourceScroll() {
    if (expectedEditor !== null && Math.abs(view.scrollDOM.scrollTop-expectedEditor) < 2) { expectedEditor = null; return; }
    expectedEditor = null;
    cancelAnimationFrame(frame); frame = requestAnimationFrame(fromEditor);
  }
  function previewScroll() {
    if (expectedPreview !== null && Math.abs(preview.scrollTop-expectedPreview) < 2) { expectedPreview = null; return; }
    expectedPreview = null; if (!enabled) return;
    const line = interpolate(map(), preview.scrollTop, 'top', 'line');
    const n = Math.max(1, Math.min(view.state.doc.lines, Math.floor(line)));
    const block = view.lineBlockAt(view.state.doc.line(n).from);
    view.scrollDOM.scrollTop = block.top + (line-n)*block.height; expectedEditor = view.scrollDOM.scrollTop;
  }
  function selection() {
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    let match = null;
    for (const node of nodes()) if (Number(node.dataset.sourceLine) <= line && (!match || Number(node.dataset.sourceLine) >= Number(match.dataset.sourceLine))) match = node;
    if (active !== match) { active?.classList.remove('preview-active'); active = match; active?.classList.add('preview-active'); }
  }
  function reveal(event) {
    const node = event.target.closest('[data-source-line]'); if (!node || event.target.closest('a,button,input')) return;
    const n = Math.max(1, Math.min(view.state.doc.lines, Number(node.dataset.sourceLine)));
    view.dispatch({ selection: { anchor: view.state.doc.line(n).from }, scrollIntoView: true }); view.focus();
  }
  const invalidate = () => { stale = true; };
  const observer = new ResizeObserver(invalidate); observer.observe(preview); observer.observe(view.scrollDOM);
  view.scrollDOM.addEventListener('scroll', sourceScroll, { passive: true });
  preview.addEventListener('scroll', previewScroll, { passive: true }); preview.addEventListener('dblclick', reveal); preview.addEventListener('load', invalidate, true);
  document.fonts?.ready.then(invalidate);
  return {
    afterRender() { stale = true; active = null; selection(); if (enabled) sourceScroll(); },
    selection,
    toggle() { enabled = !enabled; if (enabled) sourceScroll(); return enabled; },
    destroy() { cancelAnimationFrame(frame); observer.disconnect(); view.scrollDOM.removeEventListener('scroll', sourceScroll); preview.removeEventListener('scroll', previewScroll); preview.removeEventListener('dblclick', reveal); preview.removeEventListener('load', invalidate, true); }
  };
}
