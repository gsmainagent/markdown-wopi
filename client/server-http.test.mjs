import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {spawn} from 'node:child_process';import {once} from 'node:events';import {EventEmitter} from 'node:events';

function request(url,options={}){return new Promise((resolve,reject)=>{const body=options.body===undefined?null:Buffer.from(String(options.body)),headers={...(options.headers||{})};if(body){headers['Content-Length']=body.length;if(options.body instanceof URLSearchParams)headers['Content-Type']='application/x-www-form-urlencoded';}const req=http.request(new URL(url),{method:options.method||'GET',headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,headers:{get:n=>res.headers[n.toLowerCase()]},json:async()=>JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('request timeout')));if(body)req.write(body);req.end();});}
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));
test('HTTP idle renewal, keepalive, conflict stop and readonly enforcement',{timeout:15000},async()=>{
 const events=new EventEmitter();let refreshes=0,writes=0,locked='',rejectRefresh=false;
 const host=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');if(u.searchParams.get('access_token')!=='synthetic'){res.writeHead(401).end();return;}
  if(req.method==='GET'&&u.pathname.endsWith('/contents')){res.end('原文\r\ntext');return;}
  if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({BaseFileName:'test.md',UserId:'test-user',UserCanWrite:!u.pathname.includes('readonly'),SupportsLocks:true,Version:'1'}));return;}
  const op=req.headers['x-wopi-override'];
  if(op==='LOCK'){locked=req.headers['x-wopi-lock'];res.end();return;}
  if(op==='REFRESH_LOCK'){refreshes++;res.writeHead(rejectRefresh?409:200).end();events.emit('renew');return;}
  if(op==='UNLOCK'){locked='';res.end();return;}
  if(op==='PUT'){writes++;req.resume();req.on('end',()=>res.end());return;}res.writeHead(501).end();
 });
 const hostPort=await listen(host),reserve=http.createServer(),port=await listen(reserve);await close(reserve);
 const base='http://127.0.0.1:'+port,child=spawn(process.execPath,['../server.js'],{cwd:import.meta.dirname,env:{...process.env,PORT:String(port),BASE_URL:base,LOCK_REFRESH_MS:'1000',ALLOWED_ORIGINS:''},stdio:['ignore','pipe','pipe']});
 let err='';child.stderr.on('data',x=>err+=x);
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server did not start '+err)),5000);child.stdout.on('data',x=>{if(x.toString().includes('listening')){clearTimeout(timer);resolve();}});child.once('exit',code=>reject(Error('child exit '+code+' '+err)));});
  async function session(path='/files/1'){const r=await request(base+'/wopi/edit?WOPISrc='+encodeURIComponent('http://127.0.0.1:'+hostPort+path),{method:'POST',body:new URLSearchParams({access_token:'synthetic'}),redirect:'manual'});assert.equal(r.status,303);return new URLSearchParams(r.headers.get('location').split('#')[1]).get('s');}
  const sid=await session();const r=await request(base+'/api/doc/'+sid);const d=await r.json();assert.equal(r.status,200);assert.equal(d.canWrite,true);assert.match(d.draftKey,/^[a-f0-9]{64}$/);assert.equal(d.content,'原文\r\ntext');assert.ok(locked);
  if(!refreshes)await Promise.race([once(events,'renew'),new Promise((_,reject)=>setTimeout(()=>reject(Error('automatic idle renewal missing')),3500))]);
  assert.ok(refreshes>=1);assert.equal(writes,0,'idle renew must not rewrite file');
  assert.equal((await request(base+'/api/keepalive/'+sid,{method:'POST'})).status,200);
  rejectRefresh=true;assert.equal((await request(base+'/api/keepalive/'+sid,{method:'POST'})).status,409);
  assert.equal((await request(base+'/api/doc/'+sid,{method:'PUT',body:'do not write'})).status,403);assert.equal(writes,0);
  assert.equal((await request(base+'/api/unlock/'+sid,{method:'POST'})).status,204);
  rejectRefresh=false;const next=await session();const nextDoc=await request(base+'/api/doc/'+next).then(r=>r.json());assert.equal(nextDoc.draftKey,d.draftKey);await request(base+'/api/unlock/'+next,{method:'POST'});
  const ro=await session('/files/readonly');const readonly=await request(base+'/api/doc/'+ro).then(r=>r.json());assert.equal(readonly.canWrite,false);assert.equal((await request(base+'/api/doc/'+ro,{method:'PUT',body:'blocked'})).status,403);assert.equal(writes,0);
 }finally{child.kill();await once(child,'exit').catch(()=>{});await close(host);}
});
