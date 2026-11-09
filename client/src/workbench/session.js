import * as monaco from 'monaco-editor/esm/vs/editor/editor.main.js';
import * as Y from 'yjs';
import {MonacoBinding} from 'y-monaco';
import {WebsocketProvider} from 'y-websocket';
import * as decoding from 'lib0/decoding';
import {canEdit} from '../editor-state.js';
import {followTheme} from '../theme.js';
import {renderMarkdown} from '../preview.js';
import {createPreviewPipeline} from '../preview-pipeline.js';
import {registerMarkdown} from '../monaco-features.js';
import {connectMonacoPreview} from '../monaco-preview-sync.js';
import {imageMarkdown} from '../embedded-images-core.js';
import {keepSession} from '../presence.js';
import {createRecoveryController} from './recovery-controller.js';
import {activeHeading,mayReload} from './state.js';
import {demoDocument} from './demo.js';
import '../code-colors.css';
import 'katex/dist/katex.min.css';

globalThis.MonacoEnvironment={getWorker:()=>new Worker('/static/monaco/editor.worker.js')};
// React owns views. This controller owns exactly one Monaco/Y.Doc/provider lifecycle.
export function mountSession({editorHost,previewHost,store}){
 const params=new URLSearchParams(location.hash.slice(1)),query=new URLSearchParams(location.search),sid=params.get('s'),demo=query.get('demo')==='1';
 let editor,model,provider,ydoc,binding,undo,recovery,pipeline,previewSync,features,presence,data,lastStatus={},closed=false,initialSynced=false,authorized=false,renderToken=0,timer,themeCleanup,allowUnload=false;
 const disposables=[],cleanups=[],fetchAbort=new AbortController();
 const snapshot=()=>store.getSnapshot(),notice=text=>!closed&&store.set({notice:text}),serialize=()=>model?.getValue().replace(/\n/g,data?.eol||'\n')||'';
 function readOnly(){const ro=!canEdit({authorized,blocked:!!lastStatus.blocked,initialSynced,pendingRecovery:recovery?.pending||snapshot().recovery?.pending});editor?.updateOptions({readOnly:ro});store.set({readOnly:ro,authorized});}
 async function renderStatus(state){if(closed)return;lastStatus=state||lastStatus;const token=++renderToken;store.set({status:{...lastStatus},connected:!!provider?.wsconnected});readOnly();if(lastStatus.blocked){store.set({banner:'文件锁、权限或恢复状态冲突：'+lastStatus.blocked+'。当前正文仍可下载。',bannerKind:'blocked'});return;}if(demo||!model||!provider?.synced)return;
  const text=serialize(),bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));if(closed||token!==renderToken||text!==serialize())return;const hash=Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');if(hash===lastStatus.persistedHash){store.set({localDirty:false});recovery?.saved(text);}else store.set({localDirty:true});
 }
 function analyze(){if(!model||closed)return;const headings=features.analyze(model).headings;store.set({headings,activeHeading:activeHeading(headings,editor.getPosition()?.lineNumber||1)});pipeline.update(model.getValue());}
 function updateDocument(){if(closed)return;renderToken++;recovery?.changed(serialize());store.set({localDirty:!demo});clearTimeout(timer);timer=setTimeout(analyze,100);}
 function position(){if(!editor||closed)return;const p=editor.getPosition(),selection=editor.getSelection();if(!p)return;store.set({cursor:{line:p.lineNumber,column:p.column,selected:selection?model.getValueLengthInRange(selection):0},activeHeading:activeHeading(snapshot().headings,p.lineNumber)});previewSync?.selection();}
 function refreshPeers(){if(!provider||closed)return;const peers=[];for(const [id,state]of provider.awareness.getStates()){if(state.user)peers.push({id,user:state.user});}store.set({peers});}
 function download(text=serialize(),prefix=''){if(!model)return;const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=prefix+(data.name||'document.md');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function save(){if(demo)return notice('这是本机界面预览，不写入任何文件');if(lastStatus.expired)return notice('会话已过期：修改已保存在本机草稿，请下载副本或从 Cloudreve 重新打开后恢复');if(!provider?.wsconnected||!provider.synced||!authorized||lastStatus.blocked||recovery?.pending)return notice('尚未连接到可写房间，请保留或下载本机副本');provider.ws.send(new Uint8Array([5]));}
 function goToHeading(id){const h=snapshot().headings.find(h=>h.id===id);if(!h)return;editor.setPosition({lineNumber:h.line,column:1});editor.revealLineInCenter(h.line);editor.focus();}
 const controller={get editor(){return editor;},get model(){return model;},get provider(){return provider;},get ydoc(){return ydoc;},get status(){return lastStatus;},get undo(){return undo;},save,download,goToHeading,quickOutline(){editor?.getAction('editor.action.quickOutline')?.run();},focus(){editor?.focus();},layout(){if(!closed)requestAnimationFrame(()=>!closed&&editor?.layout());},setWrapped(value){editor?.updateOptions({wordWrap:value?'on':'off'});store.set({wrapped:value});},setSyncScroll(value){if(snapshot().syncScroll!==value)previewSync?.toggle();store.set({syncScroll:value});},restoreDraft(){recovery?.restore();readOnly();},discardDraft(){recovery?.discard();readOnly();},downloadDraft(){recovery?.download();},hasUnsaved(){return !mayReload(snapshot());},reload(){allowUnload=true;recovery?.flush();location.reload();},resolveBlocked(){if(demo||!sid||!lastStatus.blocked)return;fetch('/api/resolve/'+encodeURIComponent(sid),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'use-cloud'})}).then(r=>{if(r.ok){allowUnload=true;location.reload();return;}notice('重置失败：HTTP '+r.status+'，请先下载当前内容');}).catch(e=>notice('重置失败：'+e.message));},destroy};
 async function start(){
  store.set({demo});if(!demo&&!sid)throw Error('请从 Cloudreve 打开 Markdown 文件。这个地址需要文件会话。');
  if(demo)data={...demoDocument,eol:'\n',canWrite:true,collab:{status:{},roomId:'demo'}};
  else {const response=await fetch('/api/doc/'+encodeURIComponent(sid),{signal:fetchAbort.signal});data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'文稿加载失败');}
  if(closed)return;authorized=!!data.canWrite;const initial=data.content.replace(/\r\n/g,'\n');store.set({name:data.name,eol:data.eol==='\r\n'?'CRLF':'LF'});document.title=data.name+' · Markdown';
  model=monaco.editor.createModel('','markdown',monaco.Uri.parse('inmemory://wopi/'+data.collab.roomId+'/'+encodeURIComponent(data.name)));model.setEOL(monaco.editor.EndOfLineSequence.LF);
  editor=monaco.editor.create(editorHost,{model,readOnly:true,automaticLayout:true,theme:document.documentElement.classList.contains('dark')?'vs-dark':'vs',wordWrap:'on',fontSize:14,lineHeight:23,fontFamily:'"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',minimap:{enabled:false},scrollBeyondLastLine:false,tabSize:4,insertSpaces:true,padding:{top:14,bottom:24},lineNumbersMinChars:3,glyphMargin:false,renderLineHighlight:'gutter',overviewRulerBorder:false,hideCursorInOverviewRuler:true,scrollbar:{verticalScrollbarSize:9,horizontalScrollbarSize:9},find:{addExtraSpaceOnTop:false},accessibilitySupport:'auto',wordBasedSuggestions:'off',autoSurround:'always'});
  features=registerMarkdown(monaco);previewSync=connectMonacoPreview(editor,previewHost);pipeline=createPreviewPipeline({fallback:renderMarkdown,render(html,duration){if(closed)return;const top=previewHost.scrollTop;previewHost.innerHTML=html;previewHost.scrollTop=top;previewSync.afterRender();store.set({duration});},onError:notice});
  ydoc=new Y.Doc();const ytext=ydoc.getText('markdown');if(demo)ytext.insert(0,initial);
  else {provider=new WebsocketProvider(location.origin.replace(/^http/,'ws')+'/collab',data.collab.roomId,ydoc,{params:{sid},connect:false,disableBc:true,maxBackoffTime:5000});provider.messageHandlers[4]=(_encoder,decoder)=>{try{void renderStatus(JSON.parse(decoding.readVarString(decoder)));}catch{notice('协作状态消息无效');}};}
  binding=new MonacoBinding(ytext,model,new Set([editor]),provider?.awareness);undo=new Y.UndoManager(ytext,{trackedOrigins:new Set([binding])});
  editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyZ,()=>undo.undo());editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyMod.Shift|monaco.KeyCode.KeyZ,()=>undo.redo());editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyY,()=>undo.redo());editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,save);editor.addCommand(monaco.KeyMod.Alt|monaco.KeyCode.KeyZ,()=>controller.setWrapped(!snapshot().wrapped));
  const wrapPairs={'*':'*','_':'_','~':'~'};
  const wrapSelection=e=>{const key=e.browserEvent?.key||'',pair=wrapPairs[key];if(!pair)return;const sel=editor.getSelection();if(!sel||sel.isEmpty())return;const text=model.getValueInRange(sel);e.preventDefault();e.stopPropagation();editor.executeEdits('wrap-selection',[{range:sel,text:key+text+pair,forceMoveMarkers:true}]);const start=sel.getStartPosition(),end=sel.getEndPosition();editor.setSelection(new monaco.Selection(start.lineNumber,start.column+1,end.lineNumber,end.column+1));};
  disposables.push(editor.onKeyDown(wrapSelection));
  disposables.push(model.onDidChangeContent(updateDocument),editor.onDidChangeCursorSelection(position));
  if(!demo){try{pruneDrafts(globalThis.localStorage);}catch{}}
  if(!demo)recovery=createRecoveryController({key:data.draftKey,cloudText:data.content,onState(value){store.set({recovery:value});readOnly();},onRestore(text){editor.executeEdits('restore-draft',[{range:model.getFullModelRange(),text:text.replace(/\r\n/g,'\n'),forceMoveMarkers:true}]);editor.focus();},onNotice:notice,download,canRestore:()=>model.getValue()===initial});
  if(provider){
   provider.on('sync',synced=>{if(closed)return;if(synced)initialSynced=true;store.set({initialSynced});readOnly();if(synced){analyze();position();void renderStatus(lastStatus);}});
   provider.on('status',e=>{if(closed)return;store.set({connected:e.status==='connected'});if(e.status!=='connected'&&initialSynced)notice('连接断开，本地修改保留并等待合并');readOnly();void renderStatus(lastStatus);});
   provider.on('connection-close',e=>{if(closed)return;if(e?.code>=4400&&e.code<4500){authorized=false;lastStatus={...lastStatus,expired:true};recovery.flush();readOnly();store.set({banner:'会话已过期，已切换为只读；修改已保留在本机草稿。可下载当前内容，或从 Cloudreve 重新打开后恢复草稿。',bannerKind:'session'});}});
   provider.awareness.on('change',refreshPeers);provider.awareness.setLocalStateField('user',data.collab.user);lastStatus=data.collab.status;provider.connect();
   presence=keepSession({ping:()=>fetch('/api/keepalive/'+sid,{method:'POST'}),onLost(){authorized=false;lastStatus={...lastStatus,expired:true};recovery.flush();readOnly();store.set({banner:'会话或文件锁已失效，已切换为只读；修改已保留在本机草稿。可下载当前内容，或从 Cloudreve 重新打开后恢复。',bannerKind:'session'});},onNotice:notice,interval:240000});
  }else {initialSynced=true;store.set({initialSynced:true});analyze();position();}
  if(!authorized)store.set({banner:data.lockedByOther?'文件由外部编辑器持锁。当前以只读方式查看共享内容。':'当前 Cloudreve 会话为只读，可以实时查看但不能修改。'});
  store.set({phase:'ready',authorized,status:{...lastStatus}});readOnly();
  const imageInput=async e=>{const file=[...(e.clipboardData?.files||e.dataTransfer?.files||[])].find(f=>f.type.startsWith('image/'));if(!file||snapshot().readOnly)return;e.preventDefault();try{const bytes=new Uint8Array(await file.arrayBuffer());if(closed||snapshot().readOnly)return;const md=imageMarkdown(bytes,file.name||'图片');editor.executeEdits('image-paste',[{range:editor.getSelection(),text:md,forceMoveMarkers:true}]);notice('图片已嵌入 Markdown 正文，随文稿保存');}catch(err){notice(err.message);}};
  const editorNode=editor.getDomNode();editorNode.addEventListener('paste',imageInput,true);editorNode.addEventListener('drop',imageInput,true);cleanups.push(()=>{editorNode.removeEventListener('paste',imageInput,true);editorNode.removeEventListener('drop',imageInput,true);});
  const links=e=>{const a=e.target.closest('a[href]');if(!a)return;const href=a.getAttribute('href');if(href.startsWith('#')){e.preventDefault();try{goToHeading(decodeURIComponent(href.slice(1)));}catch{}}else if(!/^(https?:|mailto:)/i.test(href)){e.preventDefault();notice('WOPI 未提供相对文件读取权限：'+href);}};previewHost.addEventListener('click',links);cleanups.push(()=>previewHost.removeEventListener('click',links));
  themeCleanup=followTheme(dark=>monaco.editor.setTheme(dark?'vs-dark':'vs'));
  if(query.has('qa')){globalThis.__wopiQA=controller;globalThis.__workbenchQA={store,controller,mountCount:(globalThis.__workbenchMounts=(globalThis.__workbenchMounts||0)+1)};}
 }
 const beforeUnload=e=>{if(allowUnload)return;if(controller.hasUnsaved()){recovery?.flush();e.preventDefault();e.returnValue='';}};
 const pageHide=e=>{if(e.persisted){recovery?.flush();provider?.disconnect();}else destroy();};
 const pageShow=e=>{if(e.persisted&&!closed)provider?.connect();};
 window.addEventListener('beforeunload',beforeUnload);window.addEventListener('pagehide',pageHide);window.addEventListener('pageshow',pageShow);
 function destroy(){if(closed)return;closed=true;renderToken++;fetchAbort.abort();clearTimeout(timer);presence?.stop();recovery?.destroy();provider?.destroy();binding?.destroy();undo?.destroy();disposables.forEach(d=>d.dispose());cleanups.forEach(fn=>fn());pipeline?.destroy();previewSync?.destroy();features?.destroy();themeCleanup?.();editor?.dispose();model?.dispose();ydoc?.destroy();window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('pagehide',pageHide);window.removeEventListener('pageshow',pageShow);if(!demo&&sid)try{navigator.sendBeacon('/api/unlock/'+sid);}catch{}if(globalThis.__wopiQA===controller)delete globalThis.__wopiQA;}
 controller.ready=start().catch(e=>{if(!closed)store.set({phase:'error',banner:e.message});});return controller;
}
