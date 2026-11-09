import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
const parser=new MarkdownIt({html:false});
export function inlineLabel(item){return (item?.children||[]).map(t=>t.type==='text'||t.type==='code_inline'?t.content:t.type==='image'?t.content:t.type==='softbreak'?' ':'').join('').trim();}
export function analyzeMarkdown(source){
 const items=parser.parse(source,{}),slugger=new GithubSlugger(),headings=[],diagnostics=[];
 const starts=[0];for(const match of source.matchAll(/\r\n|\n|\r/g))starts.push(match.index+match[0].length);
 const lines=source.split(/\r\n|\n|\r/),masked=[...lines];
 for(let i=0;i<items.length;i++){
  const t=items[i];
  if(t.type==='heading_open'&&t.map){const text=inlineLabel(items[i+1]);headings.push({line:t.map[0]+1,level:Number(t.tag.slice(1)),text,id:slugger.slug(text),from:starts[t.map[0]],to:starts[t.map[0]]+lines[t.map[0]].length});}
  if(['fence','code_block','html_block'].includes(t.type)&&t.map)for(let n=t.map[0];n<t.map[1];n++)masked[n]=' '.repeat(lines[n].length);
 }
 const refs=new Set();
 for(const line of masked){const m=/^ {0,3}\[([^\]]+)\]:\s*\S/.exec(line);if(m)refs.add(m[1].trim().replace(/\s+/g,' ').toLowerCase());}
 const ids=new Set(headings.map(h=>h.id));
 for(let n=0;n<masked.length;n++){
  const line=masked[n].replace(/(\x60+)[^\x60]*?\1/g,m=>' '.repeat(m.length));
  for(const m of line.matchAll(/\]\(\s*#([^\s)]*)/g)){
   let id;try{id=decodeURIComponent(m[1]);}catch{id=null;}
   if(id!==''&&!ids.has(id)){const from=starts[n]+m.index+m[0].indexOf('#');diagnostics.push({from,to:from+m[1].length+1,severity:'warning',message:'找不到文内标题：#'+m[1]});}
  }
  for(const m of line.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)){
   const ref=(m[2]||m[1]).trim().replace(/\s+/g,' ').toLowerCase();
   if(!refs.has(ref))diagnostics.push({from:starts[n]+m.index,to:starts[n]+m.index+m[0].length,severity:'warning',message:'引用链接未定义：'+ref});
  }
 }
 return {headings,diagnostics};
}
