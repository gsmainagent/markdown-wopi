'use strict';
const crypto=require('node:crypto');
function fileMetadata(session,info) {
  const u=new URL(session.wopisrc); // no query or access token is sent to the browser or stored in the key
  const user=String(info.UserId||info.UserID||'');
  const docKey=user?crypto.createHash('sha256').update(JSON.stringify([u.origin,u.pathname,user])).digest('hex'):null;
  return {userId:user,userName:String(info.UserFriendlyName||'Cloudreve user').slice(0,100),name:info.BaseFileName||'document.md',canWrite:info.UserCanWrite!==false && info.ReadOnly!==true,draftKey:docKey,version:String(info.Version||''),capabilities:{relativeWrite:info.UserCanNotWriteRelative===false,relativeRead:false,directoryList:false,rename:false}};
}
function shouldRenew(s,now,leaseMs) { return !!s.lockId && !s.lockFailed && !s.closing && now<s.ttl && now<s.created+12*3600000 && now-(s.lastSeen||s.created)<leaseMs && now>=(s.nextRefresh||0); }
function refreshError(status) {const code=status===401||status===403?403:status===409?409:502;return Object.assign(new Error('refresh lock HTTP '+status),{status:code});}
module.exports={fileMetadata,shouldRenew,refreshError};
