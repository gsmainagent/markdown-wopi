import * as esbuild from 'esbuild';
import fs from 'node:fs';
const root=new URL('../',import.meta.url);process.chdir(root.pathname);
await esbuild.build({entryPoints:{'preview-worker':'client/src/preview-worker.js','editor.worker':'node_modules/monaco-editor/esm/vs/editor/editor.worker.js'},bundle:true,format:'iife',outdir:'static/monaco',minify:true,target:['chrome110'],legalComments:'eof',logLevel:'warning'});
fs.copyFileSync('node_modules/monaco-editor/LICENSE','static/monaco/MONACO-LICENSE.txt');
console.log('Existing preview and Monaco workers built; UI is owned by React/Vite');
