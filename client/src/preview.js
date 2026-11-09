import MarkdownIt from 'markdown-it';
import {katex} from '@mdit/plugin-katex';
import GithubSlugger from 'github-slugger';
import {inlineLabel} from './markdown-analysis.js';
import {highlightCode} from './code-languages.js';
const md=new MarkdownIt({html:false,linkify:true,highlight:highlightCode}).use(katex,{delimiters:'all',mathFence:true,throwOnError:false,trust:false,strict:'ignore',maxExpand:1000,maxSize:20});
md.core.ruler.push('source_positions',state=>{
 const slugger=new GithubSlugger();
 for(let i=0;i<state.tokens.length;i++){
  const t=state.tokens[i];
  if(t.block&&t.map){t.attrSet('data-source-line',String(t.map[0]+1));t.attrSet('data-source-end',String(t.map[1]+1));}
  if(t.type==='heading_open')t.attrSet('id',slugger.slug(inlineLabel(state.tokens[i+1])));
 }
});
const image=md.renderer.rules.image;
md.renderer.rules.image=(items,i,options,env,self)=>{
 const src=items[i].attrGet('src')||'';
 if(!/^(https?:|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(src))return '<span class="unresolved-image" role="note">图片路径未解析：'+md.utils.escapeHtml(src)+'（宿主未提供目录读取能力）</span>';
 return image(items,i,options,env,self);
};
const openLink=md.renderer.rules.link_open||((items,i,options,env,self)=>self.renderToken(items,i,options));
md.renderer.rules.link_open=(items,i,options,env,self)=>{const href=items[i].attrGet('href')||'';if(/^https?:/i.test(href)){items[i].attrSet('target','_blank');items[i].attrSet('rel','noopener noreferrer');}return openLink(items,i,options,env,self);};
for(const name of Object.keys(md.renderer.rules)){
 const original=md.renderer.rules[name];
 md.renderer.rules[name]=(items,i,options,env,self)=>{const t=items[i],html=original(items,i,options,env,self);return t.block&&t.map&&t.nesting===0?'<div data-source-line="'+(t.map[0]+1)+'" data-source-end="'+(t.map[1]+1)+'">'+html+'</div>':html;};
}
const latexish=text=>/[\\^_{}]/.test(text);
function normalizeInline(segment){
 return segment
  .replace(/\$\$([^$\n]+?)\$\$/g,(m,body)=>latexish(body)?'$'+body.trim()+'$':m)
  .replace(/\$\s+([^$\n]*?)\s+\$/g,(m,body)=>latexish(body)?'$'+body.trim()+'$':m);
}
// The KaTeX plugin rejects $$...$$ inside a paragraph and $ ... $ with a space before the
// closing delimiter. Normalize those render-time only; fenced code and inline code are skipped,
// and currency without LaTeX markers ($5 and $10) is left alone.
export function preprocessMath(source){
 const lines=String(source).split('\n');let fence=null;
 for(let i=0;i<lines.length;i++){
  const line=lines[i],trimmed=line.trim();
  const fenceMatch=line.match(/^\s{0,3}(`{3,}|~{3,})/);
  if(fenceMatch){const marker=fenceMatch[1][0];if(!fence)fence=marker;else if(marker===fence)fence=null;continue;}
  if(fence)continue;
  if(trimmed.length>4&&trimmed.startsWith('$$')&&trimmed.endsWith('$$'))continue;
  lines[i]=line.split(/(`+[^`]*`+)/).map((part,index)=>index%2?part:normalizeInline(part)).join('');
 }
 return lines.join('\n');
}
export function renderMarkdown(source){return md.render(preprocessMath(source));}
