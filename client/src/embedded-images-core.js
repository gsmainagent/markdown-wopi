export const MAX_IMAGE_BYTES=1024*1024;
export function imageType(bytes){
 const b=bytes;if(b.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v))return 'image/png';
 if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
 if(b.length>=6&&String.fromCharCode(...b.slice(0,6)).match(/^GIF8[79]a$/))return 'image/gif';
 if(b.length>=12&&String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP')return 'image/webp';return null;
}
export function imageMarkdown(bytes,name='图片'){
 if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw Error('单张图片必须小于或等于 1 MiB');
 const type=imageType(bytes);if(!type)throw Error('仅支持 PNG/JPEG/GIF/WebP 图片，不支持 SVG 或其他附件');
 let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
 const alt=String(name).replace(/[\r\n]/g,' ').replace(/[\\\[\]]/g,'\\$&');
 return '!['+alt+'](data:'+type+';base64,'+btoa(binary)+')';
}
