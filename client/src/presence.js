export function keepSession({ping,onLost,onNotice,timers=globalThis,interval=240000,events=globalThis.window}) {
  let timer=null,stopped=false,running=false;
  const schedule=ms=>{timers.clearTimeout(timer);if(!stopped)timer=timers.setTimeout(run,ms);};
  async function run(){
    if(stopped||running)return;running=true;
    try{const response=await ping();if(stopped)return;
      if([401,403,404,409].includes(response.status)){stopped=true;onLost(response.status);return;}
      if(!response.ok)throw Error('HTTP '+response.status);
      onNotice('');schedule(interval);
    }catch{if(!stopped){onNotice('续锁暂时失败，未保存内容仍在本地；恢复网络后会重试');schedule(Math.min(interval,60000));}}
    finally{running=false;}
  }
  const online=()=>{if(!stopped)schedule(0);},offline=()=>onNotice('网络已断开，本机草稿继续保护；云端尚未保存');
  events?.addEventListener('online',online);events?.addEventListener('offline',offline);schedule(interval);
  return {check:run,stop(){stopped=true;timers.clearTimeout(timer);events?.removeEventListener('online',online);events?.removeEventListener('offline',offline);}};
}
