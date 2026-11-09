import test from 'node:test';import assert from 'node:assert/strict';import {canEdit} from './src/editor-state.js';
test('once initially synchronized, network loss alone does not disable local editing',()=>{assert.equal(canEdit({authorized:true,blocked:false,initialSynced:true,pendingRecovery:false}),true);});
test('first connection must synchronize before any local editing',()=>assert.equal(canEdit({authorized:true,initialSynced:false}),false));
test('read-only permission, room conflict or pending recovery always denies editing',()=>{for(const p of [{authorized:false,initialSynced:true},{authorized:true,initialSynced:true,blocked:true},{authorized:true,initialSynced:true,pendingRecovery:true}])assert.equal(canEdit(p),false);});
