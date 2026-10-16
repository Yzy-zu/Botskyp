import { constants } from 'node:fs';
import { open,readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { product } from '../../../config/product.js';
import { validateBytes } from '../media/catalog.js';
import { digest } from '../media/storage.js';
export type LibraryFile={path:string;category:string;sha256:string;mime:string;size:number;data:Buffer};
const mimeByExtension:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.mp4':'video/mp4','.webm':'video/webm','.pdf':'application/pdf','.txt':'text/plain'};
export function safeComponent(name:string):boolean{
  return name.length<=product.libraryNameChars && name.normalize('NFC')===name && /^[\p{L}\p{N}][\p{L}\p{N} _.()-]*$/u.test(name) && !name.includes('..') && !name.endsWith('.') && !name.endsWith(' ');
}
export function safeLibraryPath(path:string):boolean{return path.split('/').length>=2 && path.split('/').length<=product.libraryMaxDepth+1 && path.split('/').every(safeComponent);}
export function verifyFile(data:Buffer,mime:string,sha256:string,size:number):boolean{
  try{return data.length===size && size<=product.libraryFileBytes && digest(data)===sha256 && (validateBytes(data,mime),true);}catch{return false;}
}
/** Pin every directory descriptor. O_NOFOLLOW applies to each component, including race replacements. */
export async function discover(root:string):Promise<LibraryFile[]>{
  const result:LibraryFile[]=[];let bytes=0,entries=0;
  const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
  async function walk(dir:FileHandle,parts:string[]):Promise<void>{
    const names=await readdir(`/proc/self/fd/${dir.fd}`);
    for(const name of names.sort()){
      if(++entries>product.libraryMaxItems*product.libraryMaxDepth)throw new Error('library_entry_limit');
      if(!safeComponent(name))throw new Error('library_unsafe_name');
      const next=[...parts,name];
      const file=await open(`/proc/self/fd/${dir.fd}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
        const stat=await file.stat();
        if(stat.isDirectory()){
          if(next.length>product.libraryMaxDepth)throw new Error('library_depth_limit');
          await walk(file,next);continue;
        }
        if(!stat.isFile() || stat.nlink!==1)throw new Error('library_unsafe_file');
        if(!parts.length)continue;
        const mime=mimeByExtension[extname(name).toLowerCase()];if(!mime)continue;
        if(stat.size<=0 || stat.size>product.libraryFileBytes || bytes+stat.size>product.libraryStorageBytes || result.length>=product.libraryMaxItems)throw new Error('library_size_limit');
        const data=Buffer.alloc(stat.size);let offset=0;
        while(offset<data.length){const read=await file.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw new Error('library_incomplete');offset+=read.bytesRead;}
        const after=await file.stat();
        if(after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ctimeMs!==stat.ctimeMs)throw new Error('library_changed');
        validateBytes(data,mime);bytes+=data.length;
        result.push({path:next.join('/'),category:next[0]!,sha256:digest(data),mime,size:data.length,data});
      }finally{await file.close();}
    }
  }
  const dir=await open(root,directoryFlags);
  try{await walk(dir,[]);return result;}finally{await dir.close();}
}
