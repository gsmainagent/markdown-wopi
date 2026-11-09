import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const base=new URL('../../static/workbench/',import.meta.url),index=new URL('index.html',base),target=new URL('../../static/monaco-editor.html',import.meta.url),html=fs.readFileSync(index,'utf8');
if(!html.includes('stylesheet')||!html.includes('prefers-color-scheme')||!html.includes('type="module"'))throw Error('Framework HTML/CSS/theme entry missing');
const refs=[...html.matchAll(/(?:src|href)="(\/static\/workbench\/assets\/[^\"]+)"/g)].map(x=>x[1]);if(!refs.some(p=>p.endsWith('.css'))||!refs.some(p=>p.endsWith('.js')))throw Error('Hashed module/style references missing');
const files={};for(const ref of refs){const file=new URL(ref.replace('/static/workbench/',''),base);const body=fs.readFileSync(file);if(!body.length)throw Error('Empty built resource');files[ref]={bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')};if(ref.endsWith('.css')){const css=body.toString();for(const token of ['.workbench','.monaco-editor','.katex'])if(!css.includes(token))throw Error('CSS pipeline missing '+token);}}
fs.copyFileSync(index,target);fs.writeFileSync(new URL('../../build-entry-report.json',import.meta.url),JSON.stringify({status:'passed',files,themeBootstrap:true},null,2)+'\n');console.log('React workbench entry verified: actual hashed JS/CSS exist; shell, Monaco and KaTeX styles included');
