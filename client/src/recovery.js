import {createDraftStore} from './draft-store.js';
export function attachRecovery({key,cloudText,bar,onRestore,onPending,onNotice,download,canRestore=()=>true}) {
  let storage;try{storage=globalThis.localStorage;}catch{}
  let store=null,current=null,lastOwn=null,pending=false,timer=null,text=cloudText,savedText=cloudText,notice='';
  const showNotice=value=>{if(value!==notice){notice=value;onNotice(value);}};
  if(key&&storage)try{store=createDraftStore({key,storage});}catch{}
  const label=bar.querySelector('[data-recovery-label]');
  function show(result){current=result.record;pending=true;bar.hidden=false;label.textContent=(result.cloudChanged?'云端内容已变化；':'')+'发现此浏览器未保存草稿（'+new Date(current.updated).toLocaleString()+'）。恢复只修改编辑区，不会直接覆盖云端。';onPending(true);}
  function persist(){
    clearTimeout(timer);timer=null;
    if(pending||!store||text===savedText)return;
    const result=store.write(text,savedText);
    if(result.ok){lastOwn=result.record;showNotice('本机草稿已保护');}
    else showNotice(result.reason==='other-tab'?'另一窗口有未保存草稿，本窗口未覆盖它；请下载副本':result.reason==='size'?'文稿超过本机草稿限额，请及时保存或下载副本':'本机草稿存储不可用，请及时保存或下载副本');
  }
  const restore=()=>{
    if(!canRestore()){showNotice('协作文稿已有新修改，禁止用旧全文覆盖他人；请下载草稿后比对合并');return;}
    const fresh=store.read(savedText);
    if(fresh.kind==='recoverable'&&(fresh.record.updated!==current.updated||fresh.record.owner!==current.owner||fresh.record.revision!==current.revision)){show(fresh);showNotice('草稿已更新，请再次确认恢复');return;}
    text=current.text;pending=false;bar.hidden=true;const result=store.write(text,savedText,{force:true});if(result.ok)lastOwn=result.record;onPending(false);onRestore(text);showNotice('草稿已恢复，等待保存到云端');
  };
  const discard=()=>{
    if(!store.remove(current)){const fresh=store.read(savedText);if(fresh.kind==='recoverable'){show(fresh);showNotice('另一窗口更新了草稿，未丢弃新版本');return;}}
    current=null;pending=false;bar.hidden=true;onPending(false);showNotice('已保留云端版本');
  };
  bar.querySelector('[data-recovery-restore]').onclick=restore;
  bar.querySelector('[data-recovery-discard]').onclick=discard;
  bar.querySelector('[data-recovery-download]').onclick=()=>current&&download(current.text,'recovered-');
  if(store){const result=store.read(cloudText);if(result.kind==='recoverable')show(result);else if(result.kind==='same')store.remove(result.record);else if(result.kind==='unavailable')showNotice('本机草稿存储不可用');}
  else showNotice(key?'本机草稿存储不可用':'宿主未提供用户身份，本机草稿未启用');
  const storageChanged=e=>{if(store&&e.key===store.name&&text!==savedText)showNotice('另一窗口更新了本机草稿；本窗口内容仍保留');};
  window.addEventListener('storage',storageChanged);
  return {get pending(){return pending;},changed(value,{composing=false}={}){text=value;clearTimeout(timer);if(!composing)timer=setTimeout(persist,400);},compositionEnd(){persist();},saved(value){savedText=value;if(text===savedText){clearTimeout(timer);store?.remove(lastOwn);lastOwn=null;showNotice('');}else persist();},flush:persist,destroy(){persist();window.removeEventListener('storage',storageChanged);clearTimeout(timer);}};
}
