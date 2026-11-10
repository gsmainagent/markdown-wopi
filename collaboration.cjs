'use strict';
// Yjs wire protocol, adapted from the MIT-licensed y-websocket server pattern.
const Y=require('yjs'),sync=require('y-protocols/sync'),awareness=require('y-protocols/awareness');
const enc=require('lib0/encoding'),dec=require('lib0/decoding'),{WebSocketServer}=require('ws');
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const STATUS=4,MAX_UPDATE=2*1024*1024,MAX_TEXT=20*1024*1024;
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const canonical=text=>text.replace(/\r\n/g,'\n');
function roomKey(s){const u=new URL(s.wopisrc);return hash(u.origin+u.pathname);}
function packet(type,write){const e=enc.createEncoder();enc.writeVarUint(e,type);write(e);return enc.toUint8Array(e);}
function atomic(file,bytes){const tmp=file+'.tmp';fs.writeFileSync(tmp,bytes,{mode:0o600});fs.renameSync(tmp,file);}
class Journal{
 constructor(dir,key){this.dir=path.join(dir,key);fs.mkdirSync(this.dir,{recursive:true,mode:0o700});this.meta=path.join(this.dir,'meta.json');this.snapshot=path.join(this.dir,'state.bin');this.log=path.join(this.dir,'updates.bin');this.ancestor=path.join(this.dir,'ancestor.bin');}
 restore(doc){if(!fs.existsSync(this.meta))return null;const meta=JSON.parse(fs.readFileSync(this.meta,'utf8'));if(fs.existsSync(this.snapshot))Y.applyUpdate(doc,fs.readFileSync(this.snapshot),'journal');if(fs.existsSync(this.log)){const data=fs.readFileSync(this.log);let pos=0;while(pos+4<=data.length){const n=data.readUInt32LE(pos);pos+=4;if(n>MAX_UPDATE||pos+n>data.length)throw Error('incomplete recovery journal');Y.applyUpdate(doc,data.subarray(pos,pos+n),'journal');pos+=n;}if(pos!==data.length)throw Error('truncated recovery journal');}return meta;}
 append(update){const h=Buffer.alloc(4);h.writeUInt32LE(update.length);const fd=fs.openSync(this.log,'a',0o600);try{fs.writeSync(fd,Buffer.concat([h,Buffer.from(update)]));fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}}
 checkpoint(doc,meta){atomic(this.snapshot,Y.encodeStateAsUpdate(doc));atomic(this.meta,JSON.stringify(meta));atomic(this.log,Buffer.alloc(0));}
}
function createCollaboration({server,sessions,live,checkInfo,getContents,lock,refresh,put,unlock,dataDir,origin,saveDelay=1000,renewMs=240000,graceMs=15000}){
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});const rooms=new Map(),pending=new Map();let stopping=false;const wss=new WebSocketServer({noServer:true,maxPayload:MAX_UPDATE});
 function status(r){return {revision:r.revision,persistedRevision:r.persistedRevision,dirty:r.revision!==r.persistedRevision,saving:!!r.saving,releasing:!!r.releasing,blocked:r.blocked||null,error:r.error||null,savedAt:r.savedAt||null,clients:r.connections.size,persistedHash:r.baseHash};}
 function sendStatus(r,ws){const bytes=packet(STATUS,e=>enc.writeVarString(e,JSON.stringify(status(r))));if(ws){if(ws.readyState===1)ws.send(bytes);}else for(const c of r.connections)if(c.readyState===1)c.send(bytes);}
 function broadcast(r,bytes){for(const c of r.connections)if(c.readyState===1)c.send(bytes);}
 function schedule(r,ms=saveDelay){clearTimeout(r.timer);if(!r.blocked&&!r.releasing&&r.revision!==r.persistedRevision)r.timer=setTimeout(()=>void flush(r).catch(()=>{}),ms);}
 async function writer(r){
  if(r.writer&&live(r.writer)&&!r.writer.lockFailed)return r.writer;
  for(const m of r.members.values())if(m.canWrite&&live(m.session)){const info=await checkInfo(m.session);if(!info.canWrite)continue;m.session.lockId=r.lockId;m.session.closing=false;r.writer=m.session;if(r.lockId)r.lockSession=r.writer;return r.writer;}
  throw Object.assign(Error('no authorized live writer; reopen from Cloudreve'),{status:403});
 }
 async function acquire(r){
  if(r.lockId)return;if(r.acquiring)return r.acquiring;
  r.acquiring=(async()=>{const session=await writer(r),result=await lock(session);if(!result.ok){r.blocked='external-lock';throw Object.assign(Error('file locked outside collaboration room'),{status:409});}
   r.lockId=session.lockId;r.lockSession=session;r.writer=session;r.nextRenew=Date.now()+renewMs;
  })().finally(()=>{r.acquiring=null;});return r.acquiring;
 }
 async function flush(r,final=false){
  if(r.releasing&&!final)throw Object.assign(Error('room is releasing'),{status:409});
  clearTimeout(r.timer);if(r.blocked)throw Object.assign(Error(r.blocked),{status:409});if(r.saving){await r.saving;if(r.revision!==r.persistedRevision)return flush(r,final);return status(r);}if(r.revision===r.persistedRevision)return status(r);
  const revision=r.revision,text=r.text();
  r.saving=(async()=>{try{await acquire(r);const s=await writer(r);await refresh(s);const code=await put(s,text);if(code!==200)throw Object.assign(Error('PutFile HTTP '+code),{status:[401,403].includes(code)?403:code===409?409:502});r.persistedRevision=revision;r.baseHash=hash(text);r.version=(await checkInfo(s)).version||r.version;r.savedAt=Date.now();r.error=null;r.retry=1000;r.journal.checkpoint(r.doc,{baseHash:r.baseHash,eol:r.eol,savedAt:r.savedAt});}
   catch(e){r.error=e.message;if([401,403,409].includes(e.status))r.blocked=e.status===409?'lock-conflict':'permission-or-session';throw e;}
   finally{r.saving=null;sendStatus(r);if(!r.blocked&&r.revision!==r.persistedRevision){r.retry=Math.min((r.retry||1000)*2,60000);schedule(r,r.error?r.retry:saveDelay);}}})();sendStatus(r);await r.saving;return status(r);
 }
 async function renew(r){
  if(r.releasing||stopping)throw Object.assign(Error('room is releasing'),{status:409});
  if(r.blocked)throw Object.assign(Error(r.blocked),{status:409});if(r.renewing)return r.renewing;
  r.renewing=(async()=>{try{await acquire(r);const session=await writer(r);await refresh(session);r.nextRenew=Date.now()+renewMs;r.error=null;return status(r);}catch(e){r.error=e.message;if([401,403,409].includes(e.status))r.blocked='lock-or-session-lost';sendStatus(r);throw e;}finally{r.renewing=null;}})();return r.renewing;
 }
 // Decodes the journal's last-saved snapshot into plain text. A missing or unreadable
 // snapshot simply means "no common base"; the client then falls back to a two-way compare.
 function baseText(r){
  try{
   if(fs.existsSync(r.journal.ancestor))return fs.readFileSync(r.journal.ancestor,'utf8').replace(/\n/g,r.eol);
   if(!fs.existsSync(r.journal.snapshot))return null;
   const doc=new Y.Doc();
   try{Y.applyUpdate(doc,fs.readFileSync(r.journal.snapshot),'base');return doc.getText('markdown').toString().replace(/\n/g,r.eol);}
   finally{doc.destroy();}
  }catch{return null;}
 }
 async function conflict(r){
  if(!r.blocked)throw Object.assign(Error('room is not in conflict'),{status:409});
  const member=[...r.members.values()].find(m=>live(m.session));
  if(!member)throw Object.assign(Error('reopen the document from Cloudreve to load the latest host content'),{status:409});
  const theirs=await getContents(member.session);
  return {base:baseText(r),ours:r.text(),theirs,eol:r.eol};
 }
 async function resolveMerge(r,text){
  if(!r.blocked)throw Object.assign(Error('room is not in conflict'),{status:409});
  if(typeof text!=='string')throw Object.assign(Error('merged text is required'),{status:400});
  if(text.length>MAX_TEXT)throw Object.assign(Error('document limit exceeded'),{status:413});
  if(![...r.members.values()].some(m=>m.canWrite&&live(m.session)))throw Object.assign(Error('no writable member can resolve this conflict'),{status:403});
  if(r.saving)try{await r.saving;}catch{}
  // Apply while still blocked so no autosave races the merge, then hand it to the normal
  // serialised save path (acquire -> REFRESH_LOCK -> PutFile). A refused host write keeps
  // the room blocked; the merged state itself is already recorded in the journal.
  const lines=canonical(text).split('\n');
  r.doc.transact(()=>{const t=r.doc.getText('markdown');t.delete(0,t.length);t.insert(0,lines.join('\n'));},'conflict-merge');
  r.blocked=null;r.error=null;
  try{return await flush(r);}
  catch(e){r.blocked=e.status===409?'lock-conflict':'permission-or-session';r.error=e.message;sendStatus(r);throw e;}
 }
 async function attach(s,sid){
  if(stopping)throw Object.assign(Error('server is stopping'),{status:503});
  if(!live(s))throw Object.assign(Error('session expired'),{status:404});const info=await checkInfo(s);s.lastSeen=Date.now();const key=roomKey(s);let r=rooms.get(key);
  while(r?.releasing){
   if(r.retiring)try{await r.retiring;}catch{}
   // A fresh, host-verified writer may release our known lock after its old token expires.
   if(rooms.get(key)===r&&r.releasePending&&info.canWrite&&r.lockId&&r.lockSession!==s){
    s.lockId=r.lockId;s.closing=true;r.lockSession=s;
    try{await retire(r,'reauthorized');}catch{throw Object.assign(Error('previous lock release pending; retry later'),{status:503});}
   }
   r=rooms.get(key);if(r?.releasing)throw Object.assign(Error('previous lock release pending; retry later'),{status:503});
   Object.assign(info,await checkInfo(s));r=rooms.get(key);
  }
  if(!r){if(!pending.has(key))pending.set(key,(async()=>{const cloud=await getContents(s),doc=new Y.Doc(),journal=new Journal(dataDir,key);let meta=null;try{meta=journal.restore(doc);}catch(e){doc.destroy();throw Object.assign(Error('recovery journal error; preserved for review: '+e.message),{status:503});}
    const eol=meta?.eol||(cloud.includes('\r\n')?'\r\n':'\n');let blocked=null;if(!meta)doc.getText('markdown').insert(0,canonical(cloud));
    const value=()=>doc.getText('markdown').toString().replace(/\n/g,eol),recovered=value();if(meta&&meta.baseHash!==hash(cloud)&&hash(recovered)!==hash(cloud))blocked='external-file-changed; download recovered copy before resolution';
    const dirty=recovered!==cloud;const room={key,doc,journal,eol,version:info.version,text:value,members:new Map(),connections:new Set(),writer:null,lockId:null,revision:dirty?1:0,persistedRevision:0,baseHash:hash(cloud),blocked,timer:null,saving:null,lastSeen:Date.now(),savedAt:meta?.savedAt||null};
    room.awareness=new awareness.Awareness(doc);room.awareness.setLocalState(null);if(!meta)journal.checkpoint(doc,{baseHash:room.baseHash,eol,savedAt:room.savedAt});
    if(!meta)try{fs.writeFileSync(journal.ancestor,Buffer.from(canonical(cloud)),{mode:0o600});}catch{}
    doc.on('update',(update,origin)=>{try{journal.append(update);}catch(e){room.blocked='journal-write-failed';room.error=e.message;}room.revision++;broadcast(room,packet(0,e=>sync.writeUpdate(e,update)));sendStatus(room);schedule(room);});
    room.awareness.on('update',({added,updated,removed})=>broadcast(room,packet(1,e=>enc.writeVarUint8Array(e,awareness.encodeAwarenessUpdate(room.awareness,added.concat(updated,removed))))));rooms.set(key,room);return room;})().finally(()=>pending.delete(key)));
   r=await pending.get(key);
  }
  if(r.releasing)return attach(s,sid);
  r.attaching=(r.attaching||0)+1;try{
  if(r.saving){await r.saving;const latest=await checkInfo(s);Object.assign(info,latest);}
  if(r.version&&info.version&&r.version!==info.version)throw Object.assign(Error('file version differs from active collaboration room; historical sessions cannot join live content'),{status:409});
  if(stopping||r.releasing)throw Object.assign(Error('room is releasing'),{status:503});
  r.explicitLeave=false;r.members.set(sid,{session:s,canWrite:info.canWrite,info});s.roomKey=key;r.lastSeen=Date.now();
  if(info.canWrite&&!r.blocked&&!r.lockId){r.writer=s;try{await acquire(r);}catch(e){if(e.status!==409)throw e;}}
  const canWrite=info.canWrite&&!r.blocked;return {room:r,info,canWrite};
  }finally{r.attaching--;if(!r.attaching&&!r.members.size&&!r.connections.size&&r.explicitLeave&&!r.releasing)void retire(r,'explicit').catch(()=>{});}
 }
 function identity(s,info){const id=info.userId||'user';return {id,name:info.userName||'Cloudreve user',color:'#'+hash(id).slice(0,6)};}
 // A successful last-member leave waits for the actual upstream acknowledgement.
 function closeSockets(sockets){return Promise.all(sockets.map(ws=>new Promise(resolve=>{
  if(ws.readyState===3)return resolve();ws.explicitlyClosed=true;ws.canWrite=false;
  const timer=setTimeout(()=>ws.terminate(),5000);timer.unref();ws.once('close',()=>{clearTimeout(timer);resolve();});ws.close(1000,'editor closed');
 })));}
 function retire(r,reason='idle'){
  if(r.retiring)return r.retiring;if(rooms.get(r.key)!==r)return Promise.resolve(true);
  if(reason!=='shutdown'&&(r.attaching||(reason==='explicit'&&r.members.size)))return Promise.resolve(false);
  // Set the gate synchronously, before the first await, so no new member can join.
  r.releasing=true;clearTimeout(r.timer);r.timer=null;
  r.retiring=(async()=>{
   await closeSockets([...r.connections]);
   if(r.renewing)try{await r.renewing;}catch{}
   if(!r.finalFlushAttempted){r.finalFlushAttempted=true;
    try{if(r.saving)await r.saving;if(!r.blocked)await flush(r,true);}
    catch(e){r.error=e.message;console.warn(new Date().toISOString(),r.key.slice(0,8),'final-save-failed',e.status||502,'journal-retained');}
   }
   if(r.lockId){const owner=r.lockSession||r.writer;if(!owner)throw Object.assign(Error('owned lock has no release session'),{status:503});
    owner.lockId=r.lockId;await unlock(owner);r.lockId=null;r.lockSession=null;
   }
   r.releasePending=false;clearTimeout(r.timer);r.awareness.destroy();r.doc.destroy();
   if(rooms.get(r.key)===r)rooms.delete(r.key);return true;
  })().catch(e=>{
   r.releasePending=true;r.releaseAttempts=(r.releaseAttempts||0)+1;
   r.releaseAt=Date.now()+Math.min(60000,1000*2**Math.min(r.releaseAttempts-1,6));r.error='lock release pending (HTTP '+(e.status||502)+')';
   console.warn(new Date().toISOString(),r.key.slice(0,8),'release-pending',e.status||502,reason);throw e;
  }).finally(()=>{r.retiring=null;});return r.retiring;
 }
 async function leave(sid){
  const session=sessions.get(sid),r=session&&rooms.get(session.roomKey);if(!r)return;
  r.members.delete(sid);r.lastSeen=Date.now();
  if(!r.members.size){r.explicitLeave=true;if(!r.attaching)return retire(r,'explicit');}
  await closeSockets([...r.connections].filter(c=>c.sid===sid));
 }
 // Explicit user resolution for a blocked recovery state: drop this room's journal, release
 // our lock, and let the next attach seed fresh content from the host.
 async function discard(r){
  if(!r)throw Object.assign(Error('no active room'),{status:404});
  if(r.releasing)return true;
  r.releasing=true;r.explicitLeave=true;clearTimeout(r.timer);r.timer=null;
  await closeSockets([...r.connections]);
  if(r.renewing)try{await r.renewing;}catch{}
  if(r.saving)try{await r.saving;}catch{}
  if(r.lockId){const owner=r.lockSession||r.writer;if(owner){owner.lockId=r.lockId;try{await unlock(owner);}catch{}}r.lockId=null;r.lockSession=null;}
  try{fs.rmSync(r.journal.dir,{recursive:true,force:true});}catch{}
  r.awareness.destroy();r.doc.destroy();
  if(rooms.get(r.key)===r)rooms.delete(r.key);
  return true;
 }

 function sanitizeAwareness(bytes,ws,r){
  const d=dec.createDecoder(bytes),n=dec.readVarUint(d),accepted=[];if(n>256)throw Error('awareness packet limit');
  for(let i=0;i<n;i++){const id=dec.readVarUint(d),clock=dec.readVarUint(d);let state=JSON.parse(dec.readVarString(d));
   if(ws.awarenessId===undefined){if([...r.connections].some(c=>c!==ws&&c.awarenessId===id))continue;ws.awarenessId=id;}
   // Providers echo remote awareness changes. Ignore those instead of granting ownership.
   if(id!==ws.awarenessId)continue;if(state!==null)state={selection:state.selection||null,user:ws.identity};accepted.push({id,clock,state});
  }
  if(!accepted.length)return;const e=enc.createEncoder();enc.writeVarUint(e,accepted.length);for(const item of accepted){enc.writeVarUint(e,item.id);enc.writeVarUint(e,item.clock);enc.writeVarString(e,JSON.stringify(item.state));}awareness.applyAwarenessUpdate(r.awareness,enc.toUint8Array(e),ws);
 }

 server.on('upgrade',async(req,socket,head)=>{
  try{const u=new URL(req.url,'http://localhost');const match=u.pathname.match(/^\/collab\/([a-f0-9]{64})$/);if(!match)throw Error('not found');if(req.headers.origin&&req.headers.origin!==origin(req))throw Error('origin forbidden');const sid=u.searchParams.get('sid'),s=sessions.get(sid);if(!s||!live(s))throw Error('session invalid');const a=await attach(s,sid);if(a.room.key!==match[1])throw Error('room forbidden');
   wss.handleUpgrade(req,socket,head,ws=>{const r=a.room;ws.sid=sid;ws.canWrite=a.canWrite;ws.identity=identity(s,a.info);ws.alive=true;r.connections.add(ws);r.lastSeen=Date.now();
    ws.on('pong',()=>ws.alive=true);ws.on('message',data=>{try{if(ws.explicitlyClosed||r.releasing)return;if(!live(s))return ws.close(4401,'session expired');s.lastSeen=r.lastSeen=Date.now();const d=dec.createDecoder(new Uint8Array(data)),type=dec.readVarUint(d);
     if(type===0){const kind=dec.readVarUint(d);if(kind===sync.messageYjsSyncStep1){const sv=dec.readVarUint8Array(d);ws.send(packet(0,e=>sync.writeSyncStep2(e,r.doc,sv)));}
      else if(kind===sync.messageYjsSyncStep2||kind===sync.messageYjsUpdate){const update=dec.readVarUint8Array(d);if(!ws.canWrite||r.blocked){if(update.length>2){ws.close(4403,'read-only');}return;}if(r.doc.getText('markdown').length>MAX_TEXT)return ws.close(4409,'document limit');Y.applyUpdate(r.doc,update,ws);}
      else throw Error('invalid sync message');}
     else if(type===5){if(!ws.canWrite||r.blocked)return ws.close(4403,'read-only');void flush(r).catch(()=>sendStatus(r,ws));}else if(type===1)sanitizeAwareness(dec.readVarUint8Array(d),ws,r);else if(type===3)ws.send(packet(1,e=>enc.writeVarUint8Array(e,awareness.encodeAwarenessUpdate(r.awareness,Array.from(r.awareness.getStates().keys())))));else throw Error('invalid protocol message');
    }catch{ws.close(4400,'invalid collaboration message');}});
    ws.on('close',(code)=>{
     r.connections.delete(ws);
     if(ws.awarenessId!==undefined)awareness.removeAwarenessStates(r.awareness,[ws.awarenessId],ws);
     r.lastSeen=Date.now();sendStatus(r);
     // A clean client-initiated close (tab close without beacon, or explicit disconnect) is an
     // intentional editor exit: 1000 carries an explicit code, 1005 means close frame without one.
     // Abnormal drops (1006, heartbeat terminate, protocol rejects) keep the reconnect grace.
     if((code===1000||code===1005)&&ws.sid)r.members.delete(ws.sid);
     if(!r.members.size&&!r.connections.size&&!r.attaching&&!r.releasing&&(r.explicitLeave||code===1000||code===1005)){r.explicitLeave=true;void retire(r,'explicit').catch(()=>{});}
    });
    ws.send(packet(0,e=>sync.writeSyncStep1(e,r.doc)));ws.send(packet(1,e=>enc.writeVarUint8Array(e,awareness.encodeAwarenessUpdate(r.awareness,Array.from(r.awareness.getStates().keys())))));sendStatus(r,ws);
   });
  }catch{socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();}
 });
 const heartbeat=setInterval(()=>{const now=Date.now();for(const r of rooms.values()){
  if(r.releasing){if(!r.retiring&&r.releasePending&&now>=r.releaseAt)void retire(r,'retry').catch(()=>{});continue;}
  for(const c of r.connections){const session=sessions.get(c.sid);if(!session||!live(session)){c.close(4401,'session expired');continue;}if(!c.alive){c.terminate();continue;}c.alive=false;c.ping();}
  if(!r.connections.size&&now-r.lastSeen>graceMs&&!r.attaching){void retire(r).catch(()=>{});continue;}
  if((r.connections.size||r.members.size)&&r.lockId&&!r.blocked&&now>=r.nextRenew){r.nextRenew=now+renewMs;void renew(r).catch(()=>{});}
 }},Math.min(10000,Math.max(1000,renewMs))).unref();
 return {attach,leave,discard,status,identity,flush,renew,conflict,resolveMerge,roomFor(s){return rooms.get(s.roomKey);},async close(){
  stopping=true;clearInterval(heartbeat);await Promise.allSettled([...pending.values()]);
  await Promise.allSettled([...rooms.values()].map(r=>retire(r,'shutdown')));wss.close();
 },rooms};
}
module.exports={createCollaboration,roomKey,Journal,canonical,STATUS};
