import * as monaco from 'monaco-editor/esm/vs/editor/editor.main.js';
import * as Y from 'yjs';
import {MonacoBinding} from 'y-monaco';
import {WebsocketProvider} from 'y-websocket';
import * as decoding from 'lib0/decoding';
import {followTheme} from './theme.js';
import {canEdit} from './editor-state.js';
import {renderMarkdown} from './preview.js';
import {createPreviewPipeline} from './preview-pipeline.js';
import {attachRecovery} from './recovery.js';
import {registerMarkdown,createOutline} from './monaco-features.js';
import {connectMonacoPreview} from './monaco-preview-sync.js';
import {imageMarkdown} from './embedded-images-core.js';
import './code-colors.css';
import 'katex/dist/katex.min.css';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.hash.slice(1)),sid=params.get('s');
globalThis.MonacoEnvironment={getWorker:()=>new Worker('/static/monaco/editor.worker.js')};
let editor,model,provider,ydoc,binding,undo,recovery,pipeline,previewSync,outline,features,data,lastStatus={},canWrite=false,blocked=false,timer,heartbeat,renderToken=0,wrapped=true,closed=false,initialSynced=false;
const disposables=[];
const notice=text=>$('session-note').textContent=text;
const chip=(text,cls='')=>{$('chip').textContent=text;$('chip').className=cls;};
const banner=text=>{$('banner-text').textContent=text;$('banner').classList.add('show');};
const serialize=()=>model.getValue().replace(/\n/g,data.eol||'\n');
function download(text,prefix=''){const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=prefix+($('fname').textContent||'document.md');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function readOnly(){const ro=!canEdit({authorized:canWrite,blocked,initialSynced,pendingRecovery:recovery?.pending});editor?.updateOptions({readOnly:!!ro});$('btn-save').disabled=!!ro;}
async function renderStatus(state){lastStatus=state||lastStatus;const token=++renderToken;blocked=!!lastStatus.blocked;readOnly();if(blocked){chip('协作写入已暂停','err');banner('文件锁、权限或恢复状态发生冲突：'+lastStatus.blocked+'。当前正文仍可下载。');return;}
 if(!provider?.wsconnected){chip('离线 · 尚未保存','err');return;}if(lastStatus.saving){chip('正在保存共享文稿…');return;}if(lastStatus.dirty){chip(lastStatus.error?'保存失败，重试中…':'共享文稿有未保存修改',lastStatus.error?'err':'');return;}
 if(!model||!provider.synced)return;const text=serialize();const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));if(token!==renderToken)return;const hash=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');if(hash===lastStatus.persistedHash){chip(lastStatus.savedAt?'已保存 '+new Date(lastStatus.savedAt).toLocaleTimeString():'已同步','ok');recovery?.saved(text);}else chip('本地更改等待同步');}
function updateDocument(){clearTimeout(timer);recovery?.changed(serialize());chip(provider?.wsconnected?'共享文稿有未保存修改':'离线 · 本机草稿保护');timer=setTimeout(()=>{const text=model.getValue();pipeline.update(text);const analysis=features.analyze(model);outline.update(analysis.headings);},100);}
function position(){const p=editor.getPosition(),selection=editor.getSelection();if(!p)return;const count=selection?model.getValueLengthInRange(selection):0;$('cursor-status').textContent='Ln '+p.lineNumber+', Col '+p.column+(count?' · 选中 '+count:'')+' · UTF-8 · '+(data.eol==='\r\n'?'CRLF':'LF');previewSync?.selection();outline?.selection();}
function save(){if(!provider?.wsconnected||!provider.synced||!canWrite||blocked||recovery?.pending){notice('尚未连接到可写协作房间；请保留或下载本机副本。');return;}chip('保存中…');provider.ws.send(new Uint8Array([5]));}
function refreshPeers(){if(!provider)return;const states=[...provider.awareness.getStates().values()].filter(s=>s.user);$('peers').textContent=states.length+' 个编辑窗口';const style=$('peer-styles');style.textContent='';for(const [id,state] of provider.awareness.getStates()){const color=/^#[a-f0-9]{6}$/i.test(state.user?.color||'')?state.user.color:'#0969da';if(Number.isSafeInteger(id))style.textContent+='.yRemoteSelection-'+id+'{background:'+color+'44}.yRemoteSelectionHead-'+id+'{border-left:2px solid '+color+'}';}}
function replaceWithDraft(text){editor.executeEdits('restore-draft',[{range:model.getFullModelRange(),text:text.replace(/\r\n/g,'\n'),forceMoveMarkers:true}]);editor.focus();}
async function start(){
 if(!sid)throw Error('缺少会话 ID，请从 Cloudreve 重新打开');
 const response=await fetch('/api/doc/'+encodeURIComponent(sid));data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'文稿加载失败');canWrite=!!data.canWrite;$('fname').textContent=data.name;
 const initial=data.content.replace(/\r\n/g,'\n');
 model=monaco.editor.createModel('','markdown',monaco.Uri.parse('inmemory://wopi/'+data.collab.roomId+'/'+encodeURIComponent(data.name)));model.setEOL(monaco.editor.EndOfLineSequence.LF);
 editor=monaco.editor.create($('editor-holder'),{model,readOnly:true,automaticLayout:true,theme:document.documentElement.classList.contains('dark')?'vs-dark':'vs',wordWrap:'on',fontSize:14,lineHeight:22,minimap:{enabled:false},scrollBeyondLastLine:false,tabSize:4,insertSpaces:true,find:{addExtraSpaceOnTop:false},accessibilitySupport:'auto',wordBasedSuggestions:'off'});
 features=registerMarkdown(monaco);outline=createOutline(editor,$('outline'));previewSync=connectMonacoPreview(editor,$('preview'));
 pipeline=createPreviewPipeline({fallback:renderMarkdown,render(html,duration){const top=$('preview').scrollTop;$('preview').innerHTML=html;$('preview').scrollTop=top;previewSync.afterRender();if(duration!==null)$('preview-timing').textContent='预览 '+Math.round(duration)+' ms';},onError:notice});
 ydoc=new Y.Doc();const ytext=ydoc.getText('markdown');provider=new WebsocketProvider(location.origin.replace(/^http/,'ws')+'/collab',data.collab.roomId,ydoc,{params:{sid},connect:false,disableBc:true,maxBackoffTime:5000});
 provider.messageHandlers[4]=(_encoder,decoder)=>{try{void renderStatus(JSON.parse(decoding.readVarString(decoder)));}catch{notice('协作状态消息无效');}};
 binding=new MonacoBinding(ytext,model,new Set([editor]),provider.awareness);undo=new Y.UndoManager(ytext,{trackedOrigins:new Set([binding])});
 editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyZ,()=>undo.undo());editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyMod.Shift|monaco.KeyCode.KeyZ,()=>undo.redo());editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyY,()=>undo.redo());editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,save);
 editor.addCommand(monaco.KeyMod.Alt|monaco.KeyCode.KeyZ,()=>{wrapped=!wrapped;editor.updateOptions({wordWrap:wrapped?'on':'off'});$('btn-wrap').setAttribute('aria-pressed',String(wrapped));});
 disposables.push(model.onDidChangeContent(updateDocument),editor.onDidChangeCursorSelection(position));
 recovery=attachRecovery({key:data.draftKey,cloudText:data.content,bar:$('recovery-bar'),onRestore:replaceWithDraft,onPending:readOnly,onNotice:notice,download,canRestore:()=>model.getValue()===initial});
 provider.on('sync',synced=>{if(synced)initialSynced=true;readOnly();if(synced){pipeline.update(model.getValue());outline.update(features.analyze(model).headings);position();void renderStatus(lastStatus);}});
 provider.on('status',e=>{notice(e.status==='connected'?'已连接协作服务':e.status==='connecting'?'正在重连协作服务…':'连接断开，本地修改保留并等待合并');readOnly();void renderStatus(lastStatus);});
 provider.on('connection-close',e=>{if(e?.code>=4400&&e.code<4500){canWrite=false;readOnly();recovery.flush();banner('协作会话已拒绝或过期。请下载副本并从 Cloudreve 重新打开。');}});
 provider.awareness.on('change',refreshPeers);provider.awareness.setLocalStateField('user',data.collab.user);provider.connect();lastStatus=data.collab.status;
 if(!canWrite)banner(data.lockedByOther?'文件正由外部编辑器持锁，以只读方式查看共享内容。':'当前 Cloudreve 会话为只读，可实时查看但不能修改。');
 $('btn-download').disabled=$('btn-wrap').disabled=$('btn-sync').disabled=false;
 const paste=async(e)=>{const file=[...(e.clipboardData?.files||e.dataTransfer?.files||[])].find(f=>f.type.startsWith('image/'));if(!file||!canWrite||blocked||recovery.pending)return;e.preventDefault();try{const md=imageMarkdown(new Uint8Array(await file.arrayBuffer()),file.name||'图片');editor.executeEdits('image-paste',[{range:editor.getSelection(),text:md,forceMoveMarkers:true}]);notice('图片已嵌入共享 Markdown 正文，随文稿一起保存。');}catch(err){notice(err.message);}};
 editor.getDomNode().addEventListener('paste',paste,true);editor.getDomNode().addEventListener('drop',paste,true);
 heartbeat=setInterval(()=>{if(!closed)void fetch('/api/keepalive/'+sid,{method:'POST'}).then(r=>{if([401,403,404,409].includes(r.status)){canWrite=false;readOnly();recovery.flush();notice('会话或文件锁已失效，请重新打开；本地修改保留。');}}).catch(()=>notice('网络中断；未保存内容保留在本机'));},240000);
 if(new URLSearchParams(location.search).has('qa'))globalThis.__wopiQA={editor,model,provider,ydoc,undo,get status(){return lastStatus;}};
}
$('btn-save').onclick=save;$('btn-download').onclick=()=>model&&download(serialize());
$('btn-symbols').onclick=()=>editor?.getAction('editor.action.quickOutline')?.run();
$('btn-wrap').onclick=()=>{wrapped=!wrapped;editor?.updateOptions({wordWrap:wrapped?'on':'off'});$('btn-wrap').setAttribute('aria-pressed',String(wrapped));};
$('btn-sync').onclick=()=>previewSync&&$('btn-sync').setAttribute('aria-pressed',String(previewSync.toggle()));
$('btn-outline').onclick=()=>{$('outline-panel').hidden=!$('outline-panel').hidden;$('btn-outline').setAttribute('aria-pressed',String(!$('outline-panel').hidden));editor?.layout();};
function reload(){if(!lastStatus.dirty||confirm('共享文稿可能尚未保存。请先下载副本；继续重新加载？'))location.reload();}$('btn-reload').onclick=$('btn-banner-reload').onclick=reload;
const divider=$('divider');let dragging=false,share=50;function split(n){share=Math.max(20,Math.min(80,n));$('wrap').style.gridTemplateColumns='minmax(0,'+share+'fr) 6px minmax(0,'+(100-share)+'fr)';divider.setAttribute('aria-valuenow',String(Math.round(share)));editor?.layout();}
divider.onpointerdown=e=>{if(e.button===0){dragging=true;divider.setPointerCapture(e.pointerId);e.preventDefault();}};divider.onpointermove=e=>{if(dragging){const r=$('wrap').getBoundingClientRect();split((e.clientX-r.left)/r.width*100);}};for(const name of ['pointerup','pointercancel','lostpointercapture'])divider.addEventListener(name,()=>dragging=false);divider.ondblclick=()=>split(50);divider.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){split(share+(e.key==='ArrowLeft'?-5:5));e.preventDefault();}};
$('preview').onclick=e=>{const a=e.target.closest('a[href]');if(!a)return;const href=a.getAttribute('href');if(href.startsWith('#')){e.preventDefault();try{const node=document.getElementById(decodeURIComponent(href.slice(1)));if(node&&$('preview').contains(node))node.scrollIntoView({block:'center'});}catch{}}else if(!/^(https?:|mailto:)/i.test(href)){e.preventDefault();notice('WOPI 未提供相对文件读取权限：'+href);}};
followTheme(dark=>monaco.editor.setTheme(dark?'vs-dark':'vs'));
window.addEventListener('beforeunload',e=>{if(model&&(!provider?.wsconnected||lastStatus.dirty)){recovery?.flush();e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>{closed=true;recovery?.destroy();clearTimeout(timer);clearInterval(heartbeat);provider?.destroy();binding?.destroy();undo?.destroy();disposables.forEach(d=>d.dispose());pipeline?.destroy();previewSync?.destroy();features?.destroy();editor?.dispose();model?.dispose();ydoc?.destroy();if(sid)try{navigator.sendBeacon('/api/unlock/'+sid);}catch{}});
start().catch(e=>{$('editor-holder').textContent='加载失败：'+e.message;chip('加载失败','err');});
