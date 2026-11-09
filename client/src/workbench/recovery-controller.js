import {createDraftStore} from '../draft-store.js';
// Owns draft policy only. React owns the recovery surface and its event handlers.
export function createRecoveryController({key,cloudText,onState=()=>{},onRestore=()=>{},onNotice=()=>{},download=()=>{},canRestore=()=>true,storage,events=globalThis.window,timers=globalThis}){
 let store=null,current=null,lastOwn=null,pending=false,timer=null,text=cloudText,savedText=cloudText,notice='';
 const notify=value=>{if(notice!==value){notice=value;onNotice(value);}};
 if(storage===undefined)try{storage=globalThis.localStorage;}catch{}
 if(key&&storage)try{store=createDraftStore({key,storage});}catch{}
 function show(result){current=result.record;pending=true;onState({pending:true,cloudChanged:!!result.cloudChanged,updated:current.updated});}
 function clear(){pending=false;onState(null);}
 function persist(){timers.clearTimeout(timer);timer=null;if(pending||!store||text===savedText)return;const r=store.write(text,savedText);if(r.ok){lastOwn=r.record;notify('本机草稿已保护');}else notify(r.reason==='other-tab'?'另一窗口有未保存草稿，本窗口未覆盖它；可下载副本':r.reason==='size'?'超过本机草稿限额，请及时保存或下载副本':'本机草稿存储不可用，请下载副本');}
 function restore(){if(!pending||!current)return false;if(!canRestore()){notify('协作文稿已有新修改，不能用旧全文覆盖；请下载草稿后比对');return false;}const fresh=store.read(savedText);if(fresh.kind==='recoverable'&&(fresh.record.updated!==current.updated||fresh.record.owner!==current.owner||fresh.record.revision!==current.revision)){show(fresh);notify('草稿已更新，请再次确认恢复');return false;}text=current.text;const r=store.write(text,savedText,{force:true});if(r.ok)lastOwn=r.record;clear();onRestore(text);notify('草稿已恢复，等待保存到云端');return true;}
 function discard(){if(!pending||!current)return false;if(!store.remove(current)){const fresh=store.read(savedText);if(fresh.kind==='recoverable'){show(fresh);notify('另一窗口更新了草稿，未丢弃新版本');return false;}}current=null;clear();notify('已保留云端版本');return true;}
 if(store){const r=store.read(cloudText);if(r.kind==='recoverable')show(r);else if(r.kind==='same')store.remove(r.record);else if(r.kind==='unavailable')notify('本机草稿存储不可用');}else notify(key?'本机草稿存储不可用':'宿主未提供用户身份，本机草稿未启用');
 const storageChanged=e=>{if(store&&e.key===store.name&&text!==savedText)notify('另一窗口更新了本机草稿；本窗口内容仍保留');};events?.addEventListener('storage',storageChanged);
 return {get pending(){return pending;},restore,discard,download(){if(current)download(current.text,'recovered-');},changed(value,{composing=false}={}){text=value;timers.clearTimeout(timer);if(!composing)timer=timers.setTimeout(persist,400);},saved(value){savedText=value;if(text===savedText){timers.clearTimeout(timer);store?.remove(lastOwn);lastOwn=null;notify('');}else persist();},flush:persist,destroy(){persist();events?.removeEventListener('storage',storageChanged);timers.clearTimeout(timer);}};
}
