import {appUrl} from './app-root.js';
export function createPreviewPipeline({render,fallback,onError=()=>{},workerFactory=()=>new Worker(appUrl('static/monaco/preview-worker.js'))}) {
 let worker=null,latest=0,destroyed=false,currentSource='';
 try{worker=workerFactory();worker.onmessage=e=>{if(!destroyed&&e.data.id===latest){if(e.data.error)onError(e.data.error);else render(e.data.html,e.data.duration);}};worker.onerror=()=>{worker?.terminate();worker=null;if(!destroyed){onError('后台预览不可用，已切回普通预览');try{render(fallback(currentSource),null);}catch(e){onError(e.message);}}};}catch{}
 return {update(source){currentSource=source;const id=++latest;if(worker)worker.postMessage({id,source});else try{render(fallback(source),null);}catch(e){onError(e.message);}},destroy(){destroyed=true;worker?.terminate();}};
}
