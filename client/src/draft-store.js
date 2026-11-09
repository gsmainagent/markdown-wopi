const PREFIX = 'wopimd-draft-v1:';
const MAX_TEXT = 2 * 1024 * 1024, MAX_AGE = 14 * 24 * 3600 * 1000;
export function textFingerprint(text) {
  // Non-secret change discriminator; content equality, not this hash, decides a clean draft.
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i),16777619); b = Math.imul(b ^ text.charCodeAt(i),2246822507); }
  return text.length + ':' + (a>>>0).toString(16) + ':' + (b>>>0).toString(16);
}
export function pruneDrafts(storage,now=Date.now){
 // Removes only records this app owns, and only when unusable: unparsable, wrong schema/key,
 // expired past MAX_AGE, or timestamped in the future. Current drafts are never touched.
 let removed=0;
 try{
  const keys=[];
  for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k&&k.startsWith(PREFIX))keys.push(k);}
  for(const name of keys){
   let record=null;
   try{record=JSON.parse(storage.getItem(name));}catch{}
   const key=name.slice(PREFIX.length);
   const bad=!record||record.schema!==1||record.key!==key||typeof record.text!=='string'||record.text.length>MAX_TEXT||!Number.isFinite(record.updated)||now()-record.updated>MAX_AGE||record.updated>now()+300000;
   if(bad){storage.removeItem(name);removed++;}
  }
 }catch{}
 return removed;
}
export function createDraftStore({key,storage,now=Date.now,owner=globalThis.crypto?.randomUUID?.() || String(Math.random())}) {
  if (!/^[a-f0-9]{64}$/.test(key || '')) throw Error('Invalid scoped document key');
  const name = PREFIX + key;
  let ownRevision = 0;
  function read(cloudText) {
    let raw; try { raw = storage.getItem(name); } catch { return {kind:'unavailable'}; }
    if (!raw) return {kind:'empty'};
    let record; try { record = JSON.parse(raw); } catch { return {kind:'invalid'}; }
    if (record?.schema!==1 || record.key!==key || typeof record.text!=='string' || record.text.length>MAX_TEXT || !Number.isFinite(record.updated) || now()-record.updated>MAX_AGE || record.updated>now()+300000) return {kind:'invalid'};
    if (record.text===cloudText) return {kind:'same',record};
    return {kind:'recoverable',record,cloudChanged:record.base!==textFingerprint(cloudText)};
  }
  function write(text,baseText,{force=false}={}) {
    if (text.length>MAX_TEXT) return {ok:false,reason:'size'};
    // Another editing tab's unsaved copy must not be silently destroyed.
    let current; try { const raw=storage.getItem(name); current=raw?JSON.parse(raw):null; } catch(e) { if(e instanceof SyntaxError)current=null;else return {ok:false,reason:'storage'}; }
    if (!force && current?.owner && current.owner!==owner && typeof current.text==='string' && current.text!==text && now()-current.updated<MAX_AGE && current.text!==baseText) return {ok:false,reason:'other-tab',record:current};
    const record={schema:1,key,owner,revision:++ownRevision,base:textFingerprint(baseText),text,updated:now()};
    try { storage.setItem(name,JSON.stringify(record)); return {ok:true,record}; } catch { return {ok:false,reason:'storage'}; }
  }
  function remove(record) {
    // Compare-and-remove: a save in this tab must not erase a newer draft from another tab.
    try {
      const raw=storage.getItem(name); if(!raw)return true;
      const current=JSON.parse(raw);
      if(record && (current.owner!==record.owner || current.revision!==record.revision || current.updated!==record.updated))return false;
      if(!record && current.owner!==owner)return false;
      storage.removeItem(name);return true;
    } catch { return false; }
  }
  return {read,write,remove,name,owner};
}
