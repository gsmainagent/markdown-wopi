import test from 'node:test';import assert from 'node:assert/strict';import {preprocessMath,renderMarkdown} from './src/preview.js';

const katexRendered=html=>/<span class="katex/.test(html);

test('inline $$…$$ inside a paragraph renders instead of staying raw',()=>{
 const source='A不依赖Δx,可依赖x;$$\\lim_{\\Delta x \\to 0}\\frac{a}{\\Delta x}=0$$';
 const normalized=preprocessMath(source);
 assert.ok(!normalized.includes('$$'),'inline $$ pair should be normalized');
 const html=renderMarkdown(source);
 assert.ok(katexRendered(html),'inline $$ must render');
 assert.ok(!html.includes('$$'),'raw delimiters must be gone');
});

test('$ … $ with space before the closing delimiter renders as math',()=>{
 const html=renderMarkdown('行内 $ \\Delta x $ 结束');
 assert.ok(katexRendered(html));
 assert.ok(!html.includes('$ '),'raw delimited text must be gone');
});

test('display $$ block on its own line still renders as block math',()=>{
 const html=renderMarkdown('前文\n$$\n\\frac{a}{b}=0\n$$\n后文');
 assert.ok(/katex-display/.test(html));
});

test('pure currency is left alone',()=>{
 const source='价格 $5 和 $10，合计 $15';
 assert.equal(preprocessMath(source),source);
 assert.ok(!katexRendered(renderMarkdown(source)));
});

test('fenced code and inline code keep literal dollars',()=>{
 const source='```\n$$\n\\frac{a}{b}\n$$\n```\n\n行内 `$ \\Delta x $` 代码';
 const normalized=preprocessMath(source);
 assert.ok(normalized.includes('$$'),'fence content untouched');
 assert.ok(normalized.includes('`$ \\Delta x $`'),'inline code untouched');
 const html=renderMarkdown(source);
 assert.ok(!/<span class="katex/.test(html),'code must not render math');
});

test('multiple inline formulas on one line all render',()=>{
 const html=renderMarkdown('先 $a$ 再 $$b^2$$ 最后 $ \\int_0^1 x dx $');
 const count=(html.match(/<span class="katex/g)||[]).length;
 assert.ok(count>=3,'expected three rendered formulas, got '+count);
});
