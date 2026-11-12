'use strict';
// MOCK=1 self-test path: the in-image mock host must implement the WOPI lock lifecycle,
// otherwise "run without a host" cannot be claimed. MOCK_FILE keeps the repo sample untouched.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{once}=require('node:events');
const root=path.resolve(__dirname,'..');
const repoSample=path.join(root,'mock-data.md');
const sampleSha=fs.existsSync(repoSample)?crypto.createHash('sha256').update(fs.readFileSync(repoSample)).digest('hex'):null;
const listenFree=()=>new Promise((resolve,reject)=>{const s=require('node:http').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on('error',reject);});
const request=(url,opt={})=>new Promise((resolve,reject)=>{
 const body=opt.body==null?null:Buffer.from(String(opt.body));const headers={...(opt.headers||{})};
 if(body)headers['Content-Length']=body.length;
 const req=require('node:http').request(url,{method:opt.method||'GET',headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});
 req.setTimeout(8000,()=>req.destroy(Error('timeout')));req.on('error',reject);if(body)req.write(body);req.end();
});

test('MOCK host supports lock lifecycle, readonly on foreign lock, save and release',{timeout:25000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wopi-mock-'));
 const mockFile=path.join(dir,'doc.md');
 const seed='# mock\r\n\r\n原文\r\n';
 fs.writeFileSync(mockFile,seed);
 const port=await listenFree();
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,MOCK:'1',MOCK_FILE:mockFile,PORT:String(port),BIND:'127.0.0.1',BASE_URL:base,COLLAB_DATA_DIR:path.join(dir,'rooms'),COLLAB_SAVE_MS:'300',COLLAB_GRACE_MS:'1200',LOCK_REFRESH_MS:'1000'},stdio:['ignore','pipe','pipe']});
 let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('start timeout '+out)),8000);child.stdout.on('data',x=>{if(String(x).includes('listening')){clearTimeout(timer);resolve();}});child.once('exit',c=>reject(Error('exit '+c+' '+out)));});
 t.after(async()=>{child.kill('SIGTERM');await once(child,'exit').catch(()=>{});});
 const wopi=base+'/mock/wopi/files/1';
 const shim=async()=>{const r=await request(base+'/wopi/edit?WOPISrc='+encodeURIComponent(wopi),{method:'POST',body:new URLSearchParams({access_token:'mock',access_token_ttl:'0'}).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded'}});assert.equal(r.status,303,r.body);const sid=new URLSearchParams(r.headers.location.split('#')[1]).get('s');return sid;};
 const doc=async sid=>{const r=await request(base+'/api/doc/'+sid);return {status:r.status,json:JSON.parse(r.body)};};

 // 1. an external holder locks the file first
 const foreign='foreign-lock-value';
 assert.equal((await request(wopi,{method:'POST',headers:{'X-WOPI-Override':'LOCK','X-WOPI-Lock':foreign}})).status,200);
 // 2. our room must go read-only instead of pretending to write
 const ro=await shim();const roDoc=await doc(ro);
 assert.equal(roDoc.status,200);
 assert.equal(roDoc.json.canWrite,false,'a foreign lock must not look writable');
 assert.equal(roDoc.json.lockedByOther,true);
 assert.equal(roDoc.json.content,seed,'read-only sessions still see the content');
 // 3. wrong lock value cannot steal the lock; the holder is echoed back
 const bad=await request(wopi,{method:'POST',headers:{'X-WOPI-Override':'UNLOCK','X-WOPI-Lock':'wrong'}});
 assert.equal(bad.status,409);
 assert.equal(bad.headers['x-wopi-lock'],foreign);
 assert.equal((await request(wopi,{method:'POST',headers:{'X-WOPI-Override':'REFRESH_LOCK','X-WOPI-Lock':'wrong'}})).status,409);
 // 4. correct unlock releases it. The blocked room stays in memory and every reopen refreshes
 // its lastSeen, so writability returns only after it retires (grace + heartbeat tick).
 assert.equal((await request(wopi,{method:'POST',headers:{'X-WOPI-Override':'UNLOCK','X-WOPI-Lock':foreign}})).status,200);
 await new Promise(r=>setTimeout(r,3500));
 const sid=await shim();const d=await doc(sid);
 assert.equal(d.json.canWrite,true,'the released lock must be acquirable once the blocked room retires');
 assert.equal(d.json.content,seed);
 // 5. save goes through the real room path and lands on the mock file
 const saved=await request(base+'/api/save/'+sid,{method:'POST',body:''});
 assert.equal(saved.status,200,saved.body);
 assert.ok(/# mock/.test(fs.readFileSync(mockFile,'utf8')),'mock file still holds the document');
 // 6. leaving releases our lock: a new holder can take it immediately
 assert.equal((await request(base+'/api/unlock/'+sid,{method:'POST',body:''})).status,204);
 let released=false;
 for(let i=0;i<20;i++){const r=await request(wopi,{method:'POST',headers:{'X-WOPI-Override':'LOCK','X-WOPI-Lock':'after-leave'}});if(r.status===200){released=true;break;}await new Promise(r=>setTimeout(r,250));}
 assert.ok(released,'lock must be released after the last member leaves');
 assert.equal((await request(wopi,{method:'POST',headers:{'X-WOPI-Override':'UNLOCK','X-WOPI-Lock':'after-leave'}})).status,200);
 // 7. the repo sample must never be touched by tests
 if(sampleSha)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(repoSample)).digest('hex'),sampleSha,'MOCK_FILE must isolate the test from the repo sample');
});
