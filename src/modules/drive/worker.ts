import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
import { transaction,type Db } from '../../db/client.js';
import type { Config } from '../../config.js';
import { privateEligible } from '../../core/permissions.js';
import { capacity,digest,fetchAttachment } from '../media/storage.js';
import { validateBytes,extension,safeName } from '../media/catalog.js';
import { safeLabel } from '../messaging/access.js';
import { loadDriveConfig } from './config.js';
import { DriveClient,restrictedTo,type DriveFile } from './client.js';
import { driveAllowed,driveRequest } from './service.js';
export type DriveJob={id:string;chat_id:string;owner_id:string;source_message_id:string;payload:unknown;attempts:number};
export type DriveDeps={client:()=>Promise<DriveClient>;attachment:typeof fetchAttachment};
const defaults:DriveDeps={client:async()=>new DriveClient(await loadDriveConfig()),attachment:fetchAttachment};
export async function recoverDrive(db:Db):Promise<void>{
  await transaction(db,async c=>{
    const jobs=(await c.query<DriveJob&{phase:string}>("SELECT j.*,d.phase FROM jobs j JOIN drive_operations d ON d.job_id=j.id WHERE j.kind='drive' AND j.status='running' FOR UPDATE OF j")).rows;
    for(const job of jobs){
      const review=['creating','sharing'].includes(job.phase);
      await c.query("UPDATE jobs SET status=$2,error=$3 WHERE id=$1",[job.id,review || job.attempts>=product.maxSendAttempts?'failed':'queued',review?'drive_write_interrupted':'interrupted']);
      await c.query('UPDATE drive_operations SET phase=$2,detail=$3,updated_at=clock_timestamp() WHERE job_id=$1',[job.id,review?'review':'queued',review?'Resultado remoto incierto; no se repite.':'interrupted']);
      if(review)await notify(c,job,'review','Reinicio durante escritura Drive: resultado incierto, requiere revisión técnica. No se repite.');
    }
  });
}
export async function claimDrive(db:Db):Promise<DriveJob|undefined>{
  return transaction(db,async c=>{
    const job=(await c.query<DriveJob>("SELECT * FROM jobs j WHERE kind='drive' AND status='queued' AND run_after<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM jobs older WHERE older.kind='media' AND older.status='queued' AND older.run_after<=clock_timestamp() AND older.id<j.id) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
    if(job)await c.query("UPDATE jobs SET status='running',attempts=attempts+1 WHERE id=$1",[job.id]);return job;
  });
}
async function notify(c:PoolClient,job:DriveJob,key:string,text:string):Promise<string>{
  return (await c.query<{id:string}>('INSERT INTO outbox(chat_id,payload,dedupe_key) VALUES($1,$2,$3) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id',[job.chat_id,JSON.stringify({text:`Drive #${job.id}: ${text}`,sourceId:job.source_message_id}),`drive:${job.id}:${key}`])).rows[0]!.id;
}
async function allowed(db:Db,config:Config,job:DriveJob):Promise<void>{if(!await transaction(db,c=>driveAllowed(c,config,job.chat_id,job.owner_id)))throw new Error('drive_not_allowed');}
function verifyFile(file:DriveFile,folder:string):void{
  if(file.trashed || file.driveId || !file.ownedByMe || (file.parents?.length!==1 || !file.parents.includes(folder)) || !file.size || !/^[1-9]\d*$/.test(file.size) || Number(file.size)>product.driveLinkMaxBytes || file.mimeType.startsWith('application/vnd.google-apps.'))throw new Error('drive_file_unavailable');
  extension(file.mimeType);
}
export async function processDrive(db:Db,config:Config,job:DriveJob,deps:DriveDeps=defaults):Promise<void>{
  let writing=false;
  try{
    const input=driveRequest.parse(job.payload);await allowed(db,config,job);
    const client=await deps.client();const folder=client.config.folders[job.chat_id];if(!folder)throw new Error('drive_folder_unconfigured');
    await client.folder(folder);
    await db.query("UPDATE drive_operations SET phase='reading',updated_at=clock_timestamp() WHERE job_id=$1",[job.id]);
    if(input.operation==='search'){
      const files=await client.search(folder,input.query);await allowed(db,config,job);
      await transaction(db,async c=>{
        const lines:string[]=[];
        for(const f of files){
          try{verifyFile(f,folder);}catch{continue;}
          const row=(await c.query<{id:string}>(`INSERT INTO drive_entries(chat_id,actor_id,remote_id,name,mime,size,checksum,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8::int*interval '1 minute') ON CONFLICT(chat_id,actor_id,remote_id) DO UPDATE SET name=excluded.name,mime=excluded.mime,size=excluded.size,checksum=excluded.checksum,expires_at=excluded.expires_at RETURNING id`,[job.chat_id,job.owner_id,f.id,safeLabel(f.name),f.mimeType,f.size,f.md5Checksum ?? null,product.sessionMinutes])).rows[0]!;
          lines.push(`${row.id}: ${safeLabel(f.name)} (${f.size} bytes)`);
        }
        const out=await notify(c,job,'search',`${lines.join('\n') || 'Sin archivos admitidos.'}\nResultados propios de este chat; vigencia ${product.sessionMinutes} minutos. Usa «bot drive info <id>» o «bot drive descargar <id>».`);
        await c.query("UPDATE jobs SET status='done',outbox_id=$2 WHERE id=$1",[job.id,out]);await c.query("UPDATE drive_operations SET phase='done' WHERE job_id=$1",[job.id]);
      });return;
    }
    let file:DriveFile;let bytes:Buffer|undefined;let expires=new Date(Date.now()+product.mediaOriginalDays*86_400_000);
    const email=client.config.recipients[job.owner_id];
    if(input.operation==='upload'){
      if(!email || !await transaction(db,c=>privateEligible(c,{id:job.owner_id,role:config.OWNER_JIDS.includes(job.owner_id)?'owner':'member'})))throw new Error('drive_recipient_unconfigured');
      const source=input.source;
      const accepted=await db.query("SELECT 1 FROM inbox WHERE chat_id=$1 AND payload->>'id'=$2 AND payload->>'senderId'=$3 AND status<>'failed'",[job.chat_id,source.id,source.senderId]);
      const canonical=(await db.query<{user_id:string}>("SELECT user_id FROM user_aliases WHERE alias=$1 AND evidence NOT LIKE 'conflict:%'",[source.senderId])).rows[0]?.user_id ?? source.senderId;
      expires=new Date(source.ts.getTime()+product.mediaOriginalDays*86_400_000);
      if(!accepted.rowCount || source.chatId!==job.chat_id || canonical!==job.owner_id || expires.getTime()<=Date.now())throw new Error('drive_attachment_unavailable');
      const attachment=await deps.attachment(config,source,AbortSignal.timeout(product.driveApiTimeoutMs));bytes=attachment.bytes;validateBytes(bytes,attachment.mime);
      const id=await client.generateId();await allowed(db,config,job);
      await db.query("UPDATE drive_operations SET remote_id=$2,sha256=$3,phase='creating',updated_at=clock_timestamp() WHERE job_id=$1",[job.id,id,digest(bytes)]);
      writing=true;
      await client.upload(id,folder,attachment.mime,bytes,safeName(`drive-${job.id}`,extension(attachment.mime)));
      file=await client.metadata(id);verifyFile(file,folder);
      if(file.id!==id || file.mimeType!==attachment.mime || Number(file.size)!==bytes.length || file.sha256Checksum!==digest(bytes))throw new Error('drive_upload_unverified');
      await allowed(db,config,job);
      await db.query("UPDATE drive_operations SET phase='sharing',updated_at=clock_timestamp() WHERE job_id=$1",[job.id]);
      await client.shareNew(id,email,expires);
    }else{
      const entry=(await db.query<{remote_id:string;mime:string;size:string;checksum:string}>("SELECT remote_id,mime,size,checksum FROM drive_entries WHERE id=$1 AND chat_id=$2 AND actor_id=$3 AND expires_at>clock_timestamp()",[input.entryId,job.chat_id,job.owner_id])).rows[0];
      if(!entry)throw new Error('drive_selection_expired');
      file=await client.metadata(entry.remote_id);verifyFile(file,folder);
      if(file.id!==entry.remote_id || file.mimeType!==entry.mime || file.size!==entry.size || file.md5Checksum!==entry.checksum)throw new Error('drive_selection_changed');
      if(Number(file.size)<=product.mediaInputBytes){bytes=await client.download(file);validateBytes(bytes,file.mimeType);}
    }
    await allowed(db,config,job);
    const link=input.operation==='upload' || !bytes;
    if(link && (!email || !restrictedTo(await client.permissions(file.id),client.config.ownerEmail,email)))throw new Error('drive_access_cannot_be_restricted');
    await transaction(db,async c=>{
      const current=(await c.query<{status:string}>('SELECT status FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];if(current?.status!=='running')return;
      if(!await driveAllowed(c,config,job.chat_id,job.owner_id))throw new Error('drive_not_allowed');
      let attachmentId:string|undefined;
      if(bytes){
        await capacity(c,bytes.length);
        const row=(await c.query<{id:string}>(`INSERT INTO media_attachments(chat_id,owner_id,source_message_id,job_id,is_original,mime,extension,size,sha256,data,expires_at) VALUES($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10) RETURNING id`,[job.chat_id,job.owner_id,`drive:${job.id}`,job.id,file.mimeType,extension(file.mimeType),bytes.length,digest(bytes),bytes,expires])).rows[0]!;attachmentId=row.id;
      }
      const text=link?`Archivo Drive con acceso restringido a tu cuenta configurada: https://drive.google.com/file/d/${file.id}/view`:`Archivo Drive #${job.id}.`;
      const target=link?job.owner_id:job.chat_id;
      const out=(await c.query<{id:string}>(`INSERT INTO outbox(chat_id,kind,payload,dedupe_key) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`,[target,link?'drive_link':'drive_file',JSON.stringify({text,sourceId:link?'':job.source_message_id,jobId:job.id,actorId:job.owner_id,originChatId:job.chat_id,...(!link?{attachmentId}:{})}),`drive:${job.id}:result`])).rows[0]!;
      await c.query("UPDATE jobs SET status='done',outbox_id=$2,result=$3 WHERE id=$1",[job.id,out.id,JSON.stringify({deliveryText:text,target,verifiedAt:new Date().toISOString()})]);
      await c.query("UPDATE drive_operations SET phase='done',remote_id=$2,updated_at=clock_timestamp() WHERE job_id=$1",[job.id,file.id]);
      await c.query("INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,'drive.completed',$3)",[job.owner_id,job.chat_id,JSON.stringify({jobId:job.id,operation:input.operation,delivery:'queued',bytes:bytes?.length ?? 0})]);
    });
  }catch{
    await transaction(db,async c=>{
      const current=(await c.query<{status:string}>('SELECT status FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];if(current?.status!=='running')return;
      const status=writing?'review':'failed';const message=writing?'Resultado remoto incierto; no se repite. Requiere revisión técnica.':'Drive no disponible, archivo faltante/cambiado o acceso no verificable. No se entregó ningún archivo ni enlace.';
      const out=await notify(c,job,status,message);
      await c.query("UPDATE jobs SET status='failed',error=$2,outbox_id=$3 WHERE id=$1",[job.id,`drive_${status}`,out]);
      await c.query('UPDATE drive_operations SET phase=$2,detail=$3,updated_at=clock_timestamp() WHERE job_id=$1',[job.id,status,message]);
      await c.query("INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,'drive.failed',$3)",[job.owner_id,job.chat_id,JSON.stringify({jobId:job.id,result:status})]);
    });
  }
}
