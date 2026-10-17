import { z } from 'zod';
import { createHash,randomUUID } from 'node:crypto';
import { product } from '../../../config/product.js';
import type { DriveConfig } from './config.js';
export const fileSchema=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{10,160}$/),name:z.string().max(255),mimeType:z.string(),size:z.string().optional(),md5Checksum:z.string().optional(),sha256Checksum:z.string().optional(),parents:z.array(z.string()).optional(),trashed:z.boolean().optional(),driveId:z.string().optional(),ownedByMe:z.boolean().optional(),capabilities:z.object({canDownload:z.boolean().optional()}).optional()});
export type DriveFile=z.infer<typeof fileSchema>;
const fields='id,name,mimeType,size,md5Checksum,sha256Checksum,parents,trashed,driveId,ownedByMe,capabilities(canDownload)';
const permission=z.object({type:z.string(),role:z.string(),emailAddress:z.string().optional(),deleted:z.boolean().optional(),expirationTime:z.string().optional()});
export type DrivePermission=z.infer<typeof permission>;
export function restrictedTo(permissions:DrivePermission[],owner:string,recipient?:string):boolean{
  const hasRecipient=recipient===undefined || recipient===owner || permissions.some(p=>p.type==='user' && p.role==='reader' && p.emailAddress?.toLowerCase()===recipient && (!p.expirationTime || new Date(p.expirationTime).getTime()>Date.now()));
  return hasRecipient && permissions.some(p=>p.type==='user' && p.role==='owner' && p.emailAddress?.toLowerCase()===owner) && permissions.every(p=>!p.deleted && p.type==='user' && ((p.role==='owner' && p.emailAddress?.toLowerCase()===owner) || (p.role==='reader' && recipient!==undefined && p.emailAddress?.toLowerCase()===recipient)));
}
export class DriveClient {
  private token='';
  constructor(readonly config:DriveConfig,private http:typeof fetch=fetch,private signal:AbortSignal=AbortSignal.timeout(product.driveJobTimeoutMs)){}
  private async bounded(response:Response,limit:number):Promise<Buffer>{
    if(!response.ok || !response.body){await response.body?.cancel();throw new Error('drive_request_failed');}
    const reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
    try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>limit){await reader.cancel();throw new Error('drive_size_limit');}parts.push(r.value);}}finally{reader.releaseLock();}
    return Buffer.concat(parts);
  }
  private async request(path:string,init:RequestInit={},limit:number=product.driveConfigBytes):Promise<Buffer>{
    if(!this.token){
      const response=await this.http('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.clientId,client_secret:this.config.clientSecret,refresh_token:this.config.refreshToken,grant_type:'refresh_token'}),redirect:'error',signal:AbortSignal.any([this.signal,AbortSignal.timeout(product.driveApiTimeoutMs)])});
      this.token=z.object({access_token:z.string().min(1)}).parse(JSON.parse((await this.bounded(response,product.driveConfigBytes)).toString())).access_token;
    }
    if(!/^\/(?:drive\/v3|upload\/drive\/v3)\//.test(path))throw new Error('drive_invalid_endpoint');
    return this.bounded(await this.http(new URL(path,'https://www.googleapis.com'),{...init,headers:{...init.headers,authorization:`Bearer ${this.token}`},redirect:'error',signal:AbortSignal.any([this.signal,AbortSignal.timeout(product.driveApiTimeoutMs)])}),limit);
  }
  async metadata(id:string):Promise<DriveFile>{return fileSchema.parse(JSON.parse((await this.request(`/drive/v3/files/${encodeURIComponent(id)}?fields=${fields}`)).toString()));}
  async permissions(id:string):Promise<DrivePermission[]>{
    const data=z.object({permissions:z.array(permission),nextPageToken:z.string().optional()}).parse(JSON.parse((await this.request(`/drive/v3/files/${encodeURIComponent(id)}/permissions?fields=permissions(type,role,emailAddress,deleted,expirationTime),nextPageToken&pageSize=100`)).toString()));
    if(data.nextPageToken)throw new Error('drive_acl_unverifiable');return data.permissions;
  }
  async folder(id:string):Promise<void>{
    const f=await this.metadata(id);if(f.id!==id || f.mimeType!=='application/vnd.google-apps.folder' || f.trashed || f.driveId || !f.ownedByMe || !restrictedTo(await this.permissions(id),this.config.ownerEmail))throw new Error('drive_folder_not_private');
  }
  async search(folder:string,query:string):Promise<DriveFile[]>{
    await this.folder(folder);
    const escaped=query.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const q=`'${folder}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.shortcut' and name contains '${escaped}'`;
    const params=new URLSearchParams({q,pageSize:String(product.driveMaxResults),fields:`files(${fields})`});
    return z.object({files:z.array(fileSchema).max(product.driveMaxResults)}).parse(JSON.parse((await this.request(`/drive/v3/files?${params}`)).toString())).files;
  }
  async download(file:DriveFile):Promise<Buffer>{
    if(file.capabilities?.canDownload!==true || !file.md5Checksum || Number(file.size)>product.mediaInputBytes)throw new Error('drive_download_unavailable');
    const bytes=await this.request(`/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,{},product.mediaInputBytes);
    if(bytes.length!==Number(file.size) || createHash('md5').update(bytes).digest('hex')!==file.md5Checksum || (file.sha256Checksum && createHash('sha256').update(bytes).digest('hex')!==file.sha256Checksum))throw new Error('drive_checksum_mismatch');return bytes;
  }
  async generateId():Promise<string>{
    return z.object({ids:z.array(z.string().regex(/^[A-Za-z0-9_-]{10,160}$/)).length(1)}).parse(JSON.parse((await this.request('/drive/v3/files/generateIds?count=1&space=drive&type=files')).toString())).ids[0]!;
  }
  async upload(id:string,folder:string,mime:string,bytes:Buffer,name:string):Promise<void>{
    const boundary=`botsky_${randomUUID()}`;
    const metadata={id,name,parents:[folder],mimeType:mime};
    const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const data=fileSchema.parse(JSON.parse((await this.request('/upload/drive/v3/files?uploadType=multipart&fields='+fields,{method:'POST',headers:{'content-type':`multipart/related; boundary=${boundary}`},body})).toString()));
    if(data.id!==id)throw new Error('drive_upload_unverified');
  }
  async shareNew(id:string,email:string,expires:Date):Promise<void>{
    if(!restrictedTo(await this.permissions(id),this.config.ownerEmail))throw new Error('drive_acl_not_private');
    if(email===this.config.ownerEmail)return;
    await this.request(`/drive/v3/files/${encodeURIComponent(id)}/permissions?sendNotificationEmail=false&fields=id`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'user',role:'reader',emailAddress:email,expirationTime:expires.toISOString()})});
    const actual=await this.permissions(id);
    const reader=actual.find(p=>p.type==='user' && p.role==='reader' && p.emailAddress?.toLowerCase()===email);
    if(!restrictedTo(actual,this.config.ownerEmail,email) || !reader?.expirationTime || Date.parse(reader.expirationTime)>expires.getTime()+1000)throw new Error('drive_acl_unverifiable');
  }
}
