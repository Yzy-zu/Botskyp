import { spawn } from 'node:child_process';
import { readFile,writeFile,lstat,readdir,rm,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { product } from '../../../config/product.js';
import { outputMime,validateBytes,safeName,conversions,type Operation } from './catalog.js';
export const temporaryRoot='/tmp/botsky-media';
export async function jobDirectory(id:string,root=temporaryRoot):Promise<string>{
  if(!/^[1-9]\d*$/.test(id))throw new Error('unsafe_job_path');
  await mkdir(root,{recursive:true,mode:0o700});
  if((await lstat(root)).isSymbolicLink())throw new Error('unsafe_root');
  const path=join(root,id);await mkdir(path,{recursive:true,mode:0o700});
  const stat=await lstat(path);if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error('unsafe_job_path');return path;
}
export async function cleanTemporary(id:string,root=temporaryRoot):Promise<void>{
  if(!/^[1-9]\d*$/.test(id))throw new Error('unsafe_job_path');
  // Only this dedicated tmp tree is ever recursively removed. Originals are in PostgreSQL.
  await rm(join(root,id),{recursive:true,force:true});
}
export async function cleanOrphanTemporaries(root=temporaryRoot):Promise<void>{
  await mkdir(root,{recursive:true,mode:0o700});
  for(const name of await readdir(root))if(/^[1-9]\d*$/.test(name))await cleanTemporary(name,root);
}
export type ProcessRequest={operation:Operation;inputs:string[];text?:string|undefined;start?:number|undefined;end?:number|undefined;summary?:boolean|undefined};
export async function runProcess(cwd:string,input:ProcessRequest,signal?:AbortSignal):Promise<{files:string[]}>{
  const combined=AbortSignal.any([AbortSignal.timeout(product.mediaTimeoutMs),...(signal?[signal]:[])]);
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/python3',['-I','/app/scripts/media/runner.py'],{cwd,detached:true,stdio:['pipe','pipe','pipe'],
      env:{PATH:'/usr/bin:/bin',HOME:cwd,TMPDIR:cwd,LANG:'C.UTF-8',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',MALLOC_ARENA_MAX:'2'}});
    let stdout='';let bytes=0;let settled=false;let failure:Error|undefined;
    const finish=(error?:Error)=>{if(settled)return;settled=true;combined.removeEventListener('abort',abort);if(error)reject(error);else{try{resolve(z.strictObject({files:z.array(z.string().regex(/^result(?:-\d+)?\.(?:mp3|ogg|wav|mp4|png|jpg|webp|pdf|txt)$/)).max(product.mediaPdfPages)}).parse(JSON.parse(stdout)));}catch{reject(new Error('process_invalid_result'));}}};
    const kill=()=>{if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')failure=new Error('process_kill_failed');}}};
    const abort=()=>{failure=new Error('process_timeout');kill();};
    child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>product.mediaApiBytes){abort();return;}stdout+=b.toString('utf8');});
    child.stderr.on('data',()=>{/* Drain sanitized diagnostics without retaining input or process details. */});
    child.on('error',()=>finish(new Error('process_unavailable')));
    child.on('close',code=>{
      kill();
      if(code!==0 && !failure){
        try{const parsed=z.strictObject({error:z.string().regex(/^[a-z_]{1,80}$/)}).parse(JSON.parse(stdout));failure=new Error(parsed.error);}
        catch{failure=new Error('process_failed');}
      }
      finish(failure);
    });
    child.stdin.on('error',()=>finish(new Error('process_input_failed')));
    combined.addEventListener('abort',abort,{once:true});if(combined.aborted){abort();return;}
    child.stdin.end(JSON.stringify({...input,limits:product}));
  });
}
export async function saveInput(cwd:string,index:number,bytes:Buffer,mime:string):Promise<string>{
  validateBytes(bytes,mime);
  const {extension}=await import('./catalog.js');
  const name=`input-${index}.${extension(mime)}`;await writeFile(join(cwd,name),bytes,{flag:'wx',mode:0o600});return name;
}
export type Artifact={bytes:Buffer;mime:string;name:string;kind:'image'|'video'|'audio'|'document'|'sticker'};
export async function readArtifacts(cwd:string,id:string,names:string[],operation:Operation):Promise<Artifact[]>{
  const artifacts:Artifact[]=[];let total=0;
  for(const [index,name] of names.entries()){
    if(!/^result(?:-\d+)?\.(?:mp3|ogg|wav|mp4|png|jpg|webp|pdf|txt)$/.test(name))throw new Error('unsafe_output_path');
    const path=join(cwd,name),stat=await lstat(path);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>product.mediaOutputBytes)throw new Error('output_size_limit');
    const bytes=await readFile(path);total+=bytes.length;if(total>product.mediaOutputBytes)throw new Error('output_size_limit');
    const ext=name.split('.').at(-1)!;if(!conversions[operation].outputs.includes(ext))throw new Error('invalid_output_format');const mime=outputMime[ext]!;validateBytes(bytes,mime);
    const kind=operation.includes('sticker')?'sticker':mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'document';
    const limit=kind==='sticker'?(operation==='sticker'?product.mediaStickerBytes:product.mediaAnimatedStickerBytes):kind==='image'?product.mediaImageBytes:kind==='video'?product.mediaVideoBytes:product.mediaOutputBytes;
    if(bytes.length>limit)throw new Error('output_size_limit');
    artifacts.push({bytes,mime,name:safeName(`${id}-${index+1}`,ext),kind});
  }
  if(!artifacts.length)throw new Error('empty_result');return artifacts;
}
