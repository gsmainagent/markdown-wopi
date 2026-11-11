export function createStore(initial={}) {
  let value=Object.freeze({...initial});const listeners=new Set();
  return {getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},set(patch){const next=typeof patch==='function'?patch(value):patch;if(Object.entries(next).every(([k,v])=>Object.is(value[k],v)))return;value=Object.freeze({...value,...next});for(const fn of [...listeners])fn();}};
}
export function statusPresentation(s){
 if(s.phase==='error')return {label:'无法打开',tone:'error'};
 if(s.demo)return {label:'界面预览',tone:'muted'};
 if(s.phase!=='ready')return {label:'正在打开…',tone:'muted'};
 if(s.status?.blocked)return {label:'写入已暂停',tone:'error'};
 if(s.recovery?.pending)return {label:'发现本机草稿',tone:'warning'};
 if(!s.initialSynced)return {label:s.connected?'正在同步…':'正在连接…',tone:'muted'};
 if(!s.connected)return {label:s.localDirty?'离线 · 草稿已保护':'连接已断开',tone:'warning'};
 if(!s.authorized)return {label:'只读',tone:'muted'};
 if(s.status?.saving)return {label:'正在保存…',tone:'muted',busy:true};
 if(s.status?.error)return {label:'保存失败 · 重试中',tone:'error'};
 if(s.status?.dirty||s.localDirty)return {label:'有未保存修改',tone:'warning'};
 return {label:s.status?.savedAt?'已保存':'已同步',tone:'success'};
}
// Two independent thresholds: the outline becomes a drawer well before the preview is
// dropped, so a mid-width window (browser zoom, docked side window) still shows 编辑与预览.
export const OUTLINE_DRAWER_AT=760,SPLIT_MIN_WIDTH=520;
export function outlineOpenForWidth(width){return width>=OUTLINE_DRAWER_AT;}
export function layoutForWidth(width){return width>=SPLIT_MIN_WIDTH?'split':'editor';}

export function activeHeading(headings,line){return headings.filter(h=>h.line<=line).at(-1)?.id||null;}
export function mayReload(s){return !s.localDirty&&!s.status?.dirty&&!s.recovery?.pending;}
export const initialState={phase:'loading',name:'正在打开文稿…',authorized:false,readOnly:true,connected:false,initialSynced:false,localDirty:false,demo:false,headings:[],activeHeading:null,status:{},notice:'',banner:'',bannerKind:'',recovery:null,cursor:{line:1,column:1,selected:0},eol:'LF',peers:[],wrapped:true,syncScroll:true,duration:null};
