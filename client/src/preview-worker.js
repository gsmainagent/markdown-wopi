import {renderMarkdown} from './preview.js';
self.onmessage=event=>{const {id,source}=event.data;const start=performance.now();try{self.postMessage({id,html:renderMarkdown(source),duration:performance.now()-start});}catch(e){self.postMessage({id,error:e.message});}};
