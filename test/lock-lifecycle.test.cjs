'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{once,EventEmitter}=require('node:events');
const Y=require('yjs'),{WebsocketProvider}=require('y-websocket'),WebSocket=require('ws'),dec=require('lib0/decoding');
const root=path.resolve(__dirname,'..'),sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',()=>resolve(s.address().port)));
const request=(url,opt={})=>new Promise((resolve,reject)=>{const body=opt.body==null?null:Buffer.from(String(opt.body));const headers={...opt.headers};if(body)headers['Content-Length']=body.length;const req=http.request(url,{method:opt.method||'GET',headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString(),json(){return JSON.parse(this.body);}}));});req.setTimeout(8000,()=>req.destroy(Error('test request timeout')));req.on('error',reject);if(body)req.write(body);req.end();});
async function until(check,emitter,event,timeout=8000){if(check())return;await new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(timer);clearInterval(poll);emitter.off(event,done);};const done=()=>{if(check()){stop();resolve();}};const timer=setTimeout(()=>{stop();reject(Error('condition timed out: '+event));},timeout),poll=setInterval(done,100);emitter.on(event,done);});}
async function harness(t,options={}){
 const events=new EventEmitter(),files=new Map([['1','# Shared\r\n原文'],['2','# Other\n']]),records={locks:0,refresh:0,puts:[],pending:[],hold:false,failRefresh:false,failPut:false,unlockCodes:[],unlocks:[],pendingUnlock:[],holdUnlock:false,unlockNetworkFailures:0};let locked='';
 const host=http.createServer((req,res)=>{const u=new URL(req.url,'http://test'),grant=u.searchParams.get('access_token'),id=u.pathname.split('/')[2];if(!['writer-a','writer-b','reader','reader-old'].includes(grant)){res.writeHead(401).end();return;}
  if(req.method==='GET'&&u.pathname.endsWith('/contents'))return res.end(files.get(id)||'');
  if(req.method==='GET'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({BaseFileName:id+'.md',UserId:grant,UserFriendlyName:grant,UserCanWrite:!grant.startsWith('reader'),ReadOnly:grant.startsWith('reader'),Version:grant==='reader-old'?'v0':'v1'}));}
  const op=req.headers['x-wopi-override'];if(op==='LOCK'){records.locks++;if(locked&&locked!==req.headers['x-wopi-lock'])return res.writeHead(409).end();locked=req.headers['x-wopi-lock'];return res.end();}
  if(op==='REFRESH_LOCK'){records.refresh++;return res.writeHead(records.failRefresh?409:200).end();}
  if(op==='UNLOCK'){const id=req.headers['x-wopi-lock'];records.unlocks.push(id);if(records.unlockNetworkFailures>0){records.unlockNetworkFailures--;req.socket.destroy();return;}const status=records.unlockCodes.shift()||200;const finish=()=>{if(id!==locked){res.writeHead(409).end();return;}if(status>=200&&status<300)locked='';else if(status===409)res.setHeader('X-WOPI-Lock','foreign-lock-must-not-be-used');res.writeHead(status).end();events.emit('unlocked');};if(records.holdUnlock)records.pendingUnlock.push(finish);events.emit('unlock-request');if(!records.holdUnlock)finish();return;}
  if(op==='PUT'){const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{const b=Buffer.concat(chunks);assert.equal(Number(req.headers['content-length']),b.length);const item={id,text:b.toString(),grant,lock:req.headers['x-wopi-lock']};records.puts.push(item);const finish=()=>{if(records.failPut)res.writeHead(502).end();else{files.set(id,item.text);res.end();}events.emit('saved');};if(records.hold)records.pending.push(finish);else finish();events.emit('put');});return;}
  res.writeHead(501).end();
 });
 const hostPort=await listen(host),reserve=http.createServer(),port=await listen(reserve);await new Promise(r=>reserve.close(r));
 const dir=options.dir||fs.mkdtempSync(path.join(os.tmpdir(),'wopi-monaco-test-'));const clients=[];let child,output='';
 async function start(){child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),BASE_URL:'http://127.0.0.1:'+port,COLLAB_DATA_DIR:dir,COLLAB_SAVE_MS:'500',COLLAB_GRACE_MS:String(options.graceMs??60000),LOCK_REFRESH_MS:'1000'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('start timeout '+output)),5000);child.stdout.on('data',x=>{output+=x;if(output.includes('listening')){clearTimeout(timer);resolve();}});child.stderr.on('data',x=>output+=x);child.once('exit',code=>reject(Error('server exit '+code+' '+output)));});}
 async function stop(){if(!child)return;const c=child;child=null;c.kill('SIGTERM');await once(c,'exit');output='';}
 await start();
 const base='http://127.0.0.1:'+port;
 async function session(grant='writer-a',id='1',expectedStatus=200){const form=new URLSearchParams({access_token:grant});const r=await request(base+'/wopi/edit?WOPISrc='+encodeURIComponent('http://127.0.0.1:'+hostPort+'/files/'+id),{method:'POST',body:form.toString(),headers:{'Content-Type':'application/x-www-form-urlencoded'}});assert.equal(r.status,303);assert.match(r.headers.location,/monaco-editor/);const sid=new URLSearchParams(r.headers.location.split('#')[1]).get('s');const loaded=await request(base+'/api/doc/'+sid);assert.equal(loaded.status,expectedStatus,loaded.body);return {sid,data:loaded.json(),status:loaded.status};}
 async function connect(session){const doc=new Y.Doc(),provider=new WebsocketProvider(base.replace('http','ws')+'/collab',session.data.collab.roomId,doc,{params:{sid:session.sid},WebSocketPolyfill:WebSocket,disableBc:true,connect:false});const c={doc,provider,status:{},events:new EventEmitter()};provider.messageHandlers[4]=(_e,d)=>{c.status=JSON.parse(dec.readVarString(d));c.events.emit('status');};clients.push(c);provider.awareness.setLocalStateField('user',{name:'spoof',color:'red'});provider.connect();await until(()=>provider.synced,provider,'sync');return c;}
 t.after(async()=>{for(const c of clients){c.provider.destroy();c.doc.destroy();}await stop();await new Promise(r=>host.close(r));});
 return {base,host,hostPort,dir,files,records,events,session,connect,stop,start,clients,request,until,isLocked:()=>!!locked,output:()=>output};
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const leave=(h,s)=>request(h.base+'/api/unlock/'+s.sid,{method:'POST',body:''});
const noReconnect=c=>{c.provider.shouldConnect=false;};
test('explicit last HTTP member leave waits for real UNLOCK, not grace',{timeout:12000},async t=>{
 const h=await harness(t),s=await h.session();assert(h.isLocked());const start=Date.now(),r=await leave(h,s);assert.equal(r.status,204);assert.equal(h.isLocked(),false,'204 must follow acknowledged unlock for last member');assert(Date.now()-start<3000);assert.equal(h.records.unlocks.length,1);await sleep(1100);assert.equal(h.records.refresh,0);
});
test('one peer leaving retains shared lock, final websocket peer releases',{timeout:15000},async t=>{
 const h=await harness(t),a=await h.session(),b=await h.session('writer-b'),x=await h.connect(a),y=await h.connect(b);noReconnect(x);assert.equal((await leave(h,a)).status,204);assert(h.isLocked());assert.equal(h.records.unlocks.length,0);assert(y.provider.wsconnected);noReconnect(y);assert.equal((await leave(h,b)).status,204);assert.equal(h.isLocked(),false);assert.equal(h.records.unlocks.length,1);
});
test('dirty final flush failure still unlocks and preserves recovery journal',{timeout:15000},async t=>{
 const h=await harness(t),s=await h.session(),x=await h.connect(s);h.records.failPut=true;x.doc.getText('markdown').insert(0,'RECOVER-ME');await until(()=>x.status.dirty,x.events,'status');noReconnect(x);assert.equal((await leave(h,s)).status,204);assert.equal(h.isLocked(),false,'failed final PutFile must not skip UNLOCK');assert.equal(h.files.get('1'),'# Shared\r\n原文');assert(h.records.puts.some(p=>p.text.startsWith('RECOVER-ME')));const {Journal}=require('../collaboration.cjs'),doc=new Y.Doc();new Journal(h.dir,s.data.collab.roomId).restore(doc);assert(doc.getText('markdown').toString().startsWith('RECOVER-ME'));doc.destroy();
});
test('UNLOCK HTTP500 remains tracked, does not return204, retries same lock without refresh',{timeout:15000},async t=>{
 const h=await harness(t),s=await h.session();h.records.unlockCodes=[500,200];const r=await leave(h,s);assert(r.status>=400);assert(h.isLocked());const refresh=h.records.refresh;await until(()=>!h.isLocked(),h.events,'unlocked');assert.equal(h.records.unlocks.length,2);assert.equal(h.records.unlocks[0],h.records.unlocks[1]);assert.equal(h.records.refresh,refresh);assert.match(h.output(),/UNLOCK.*500/);
});
test('UNLOCK409 response cannot replace the owned lock value',{timeout:15000},async t=>{
 const h=await harness(t),s=await h.session();h.records.unlockCodes=[409,409,200];const r=await leave(h,s);assert(r.status>=400);assert(h.isLocked());await until(()=>!h.isLocked(),h.events,'unlocked');assert.equal(h.records.unlocks.length,3);assert(h.records.unlocks.every(x=>x===h.records.unlocks[0]));assert(h.records.unlocks.every(x=>x!=='foreign-lock-must-not-be-used'));
});
test('clean WS close without beacon releases immediately (real tab-close path)',{timeout:15000},async t=>{
 const h=await harness(t),s=await h.session(),x=await h.connect(s);x.provider.shouldConnect=false;const start=Date.now();x.provider.ws.close(1000);await until(()=>!h.isLocked(),h.events,'unlocked');assert(Date.now()-start<3000,'clean close must not wait for grace');assert.equal(h.records.unlocks.length,1);assert.equal(h.files.get('1'),'# Shared\r\n原文');
});
test('abnormal WS drop keeps the fallback grace before releasing',{timeout:15000},async t=>{
 const h=await harness(t,{graceMs:1200}),s=await h.session(),x=await h.connect(s);x.provider.shouldConnect=false;x.provider.ws.terminate();await sleep(400);assert(h.isLocked(),'abnormal drop must keep the lock through grace');await until(()=>!h.isLocked(),h.events,'unlocked');assert.equal(h.records.unlocks.length,1);
});
test('last leave waits for already-running PutFile before unlocking',{timeout:15000},async t=>{
 const h=await harness(t),s=await h.session(),x=await h.connect(s);h.records.hold=true;x.doc.getText('markdown').insert(0,'IN-FLIGHT');await until(()=>h.records.pending.length===1,h.events,'put');noReconnect(x);const leaving=leave(h,s);await sleep(150);assert.equal(h.records.unlocks.length,0,'cannot unlock while PutFile is in flight');h.records.hold=false;h.records.pending.shift()();assert.equal((await leaving).status,204);assert.equal(h.isLocked(),false);assert(h.files.get('1').startsWith('IN-FLIGHT'));assert.equal(h.records.puts.length,1);
});
test('attach during delayed UNLOCK cannot join or lose a retiring room',{timeout:15000},async t=>{
 const h=await harness(t),s=await h.session();h.records.holdUnlock=true;const leaving=leave(h,s);await until(()=>h.records.pendingUnlock.length===1,h.events,'unlock-request');let joined=false;const opening=h.session('writer-b').then(v=>{joined=true;return v;});await sleep(120);assert.equal(joined,false);assert.equal(h.records.locks,1);h.records.holdUnlock=false;h.records.pendingUnlock.shift()();assert.equal((await leaving).status,204);const next=await opening;assert(next.data.canWrite);assert.equal(h.records.locks,2);const peer=await h.connect(next);assert(peer.provider.synced);noReconnect(peer);assert.equal((await leave(h,next)).status,204);assert.equal(h.isLocked(),false);
});
test('graceful shutdown attempts unlock even when final save fails',{timeout:15000},async t=>{
 const h=await harness(t),s=await h.session(),x=await h.connect(s);h.records.failPut=true;x.doc.getText('markdown').insert(0,'SHUTDOWN-RECOVERY');await until(()=>x.status.dirty,x.events,'status');x.provider.disconnect();await h.stop();assert.equal(h.isLocked(),false);assert.equal(h.records.unlocks.length,1);assert.equal(h.files.get('1'),'# Shared\r\n原文');
});
test('successful UNLOCK204 is an acknowledgement, not a retryable failure',{timeout:12000},async t=>{
 const h=await harness(t),s=await h.session();h.records.unlockCodes=[204];assert.equal((await leave(h,s)).status,204);assert.equal(h.isLocked(),false);assert.equal(h.records.unlocks.length,1);
});

test('fresh verified writer can release the known lock after an old token401',{timeout:15000},async t=>{
 const h=await harness(t),s=await h.session();h.records.unlockCodes=[401];assert.equal((await leave(h,s)).status,401);assert(h.isLocked());const next=await h.session('writer-b');assert(next.data.canWrite);assert.equal(h.records.unlocks[0],h.records.unlocks[1]);assert.equal(h.records.locks,2);assert.equal((await leave(h,next)).status,204);assert.equal(h.isLocked(),false);
});
test('UNLOCK network failure preserves ownership and retries rather than clearing the lock',{timeout:15000},async t=>{
 const h=await harness(t),s=await h.session();h.records.unlockNetworkFailures=1;assert.equal((await leave(h,s)).status,502);assert(h.isLocked());await until(()=>!h.isLocked(),h.events,'unlocked');assert.equal(h.records.unlocks.length,2);assert.equal(h.records.unlocks[0],h.records.unlocks[1]);
});
test('simultaneous first attaches acquire exactly one shared upstream lock',{timeout:15000},async t=>{
 const h=await harness(t),[a,b]=await Promise.all([h.session(),h.session('writer-b')]);assert(a.data.canWrite&&b.data.canWrite);assert.equal(a.data.collab.roomId,b.data.collab.roomId);assert.equal(h.records.locks,1);assert.equal((await leave(h,a)).status,204);assert(h.isLocked());assert.equal((await leave(h,b)).status,204);assert.equal(h.isLocked(),false);
});
