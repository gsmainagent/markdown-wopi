import test from 'node:test';import assert from 'node:assert/strict';import {pruneDrafts} from './src/draft-store.js';

function stub(){
 const map=new Map();
 return {map,getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),key:i=>[...map.keys()][i]??null,get length(){return map.size;}};
}
const key='a'.repeat(64),PREFIX='wopimd-draft-v1:';
const record=(over={})=>JSON.stringify({schema:1,key,owner:'o1',revision:1,base:'1:0:0',text:'x',updated:Date.now(),...over});

test('prune keeps a current draft and removes only unusable records',()=>{
 const s=stub();
 s.setItem(PREFIX+key,record());
 s.setItem(PREFIX+'b'.repeat(64),record({key:'b'.repeat(64),updated:Date.now()-15*24*3600*1000}));
 s.setItem(PREFIX+'c'.repeat(64),'{not json');
 s.setItem(PREFIX+'d'.repeat(64),record({key:'d'.repeat(64),schema:2}));
 s.setItem('unrelated-key','keep');
 const removed=pruneDrafts(s);
 assert.equal(removed,3);
 assert.ok(s.getItem(PREFIX+key),'current draft survives');
 assert.equal(s.getItem('unrelated-key'),'keep');
});

test('prune tolerates a storage that throws',()=>{
 const broken={get length(){throw Error('denied');},key(){throw Error('denied');},getItem(){throw Error('denied');},removeItem(){throw Error('denied');}};
 assert.equal(pruneDrafts(broken),0);
});
