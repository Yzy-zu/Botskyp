import { observer } from '../../observer/index.js';
import { execFile } from 'node:child_process';
import { mkdtemp,readFile,lstat,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { product } from '../../../config/product.js';
import type { Config } from '../../config.js';
import { transaction,type Db } from '../../db/client.js';
import { discover } from './discovery.js';
import { publish } from './catalog.js';
export const libraryRoot='/run/botsky-library/source';
export const rcloneConfig='/run/botsky-rclone/rclone.conf';
export type SyncRunner=(args:string[],timeout:number)=>Promise<void>;
export const runRclone:SyncRunner=(args,timeout)=>new Promise((resolve,reject)=>{
  execFile('/usr/bin/rclone',args,{timeout,killSignal:'SIGKILL',maxBuffer:16_384,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}},error=>error?reject(new Error('rclone_failed_or_timeout')):resolve());
});
export async function checkRcloneConfig(path=rcloneConfig):Promise<void>{
  const stat=await lstat(path);if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)!==0 || stat.size>16_384)throw new Error('rclone_config_invalid');
  const text=await readFile(path,'utf8');const values=new Map<string,string>();let section=false;
  for(const raw of text.split('\n')){
    const line=raw.trim();if(!line || line.startsWith('#') || line.startsWith(';'))continue;
    if(line==='[botsky-library]' && !section){section=true;continue;}
    const m=/^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if(!section || !m || values.has(m[1]!) || !['type','scope','root_folder_id','token','client_id','client_secret','team_drive','service_account_file'].includes(m[1]!))throw new Error('rclone_config_invalid');
    values.set(m[1]!,m[2]!);
  }
  if(values.get('type')!=='drive' || values.get('scope')!=='drive.readonly' || !/^[a-zA-Z0-9_-]+$/.test(values.get('root_folder_id') ?? '') || !values.has('token') || Boolean(values.get('team_drive')) || Boolean(values.get('service_account_file')))throw new Error('rclone_config_invalid');
}
export function rcloneArgs(destination:string):string[]{
  return ['copy','botsky-library:',destination,'--config',rcloneConfig,'--drive-scope','drive.readonly','--drive-skip-shortcuts','--checkers','1','--transfers','1','--retries','1','--low-level-retries','1','--contimeout','10s','--timeout','30s','--max-duration',`${product.librarySyncTimeoutMs/1000}s`,'--max-size',`${product.libraryFileBytes}`,'--max-transfer',`${product.libraryStorageBytes}`,'--max-depth',`${product.libraryMaxDepth+1}`,'--max-backlog',`${product.libraryMaxItems}`,'--buffer-size','1M','--stats','0','--log-level','ERROR'];
}
/** Session lock spans external I/O; no inbox/tick transaction waits for Drive. */
export async function syncLibrary(db:Db,config:Config,options:{root?:string;runner?:SyncRunner;checkConfig?:()=>Promise<void>}={}):Promise<boolean>{
  const lock=await db.connect();let staging:string|undefined,id:string|undefined;
  try{
    const held=(await lock.query<{held:boolean}>("SELECT pg_try_advisory_lock(hashtext('library-sync')) held")).rows[0]?.held;
    if(!held)return false;
    const request=(await lock.query<{id:string;source:'local'|'drive';actor_id:string}>("SELECT id,source,actor_id FROM library_syncs WHERE status='queued' ORDER BY id LIMIT 1")).rows[0];
    if(!request)return false;
    const flags=await lock.query<{key:string}>("SELECT key FROM system_flags WHERE key IN ('emergency','maintenance') AND value='true'::jsonb");
    if(flags.rows.some(f=>f.key==='emergency' || (f.key==='maintenance' && request.actor_id==='system:library')))return false;
    id=request.id;
    observer.emit(()=>({eventType:'JOB_STARTED',stage:'library.sync',jobId:`library:${id}`,payload:{syncId:id,request}}));
    if(request.actor_id!=='system:library' && (request.actor_id.endsWith('@lid') || !config.OWNER_JIDS.includes(request.actor_id)))throw new Error('sync_not_authorized');
    await lock.query("UPDATE library_syncs SET status='running',started_at=clock_timestamp() WHERE id=$1",[id]);
    let root=options.root ?? libraryRoot;
    if(request.source==='drive'){
      if(!config.LIBRARY_DRIVE_ENABLED)throw new Error('drive_not_configured');
      await (options.checkConfig ?? checkRcloneConfig)();
      staging=await mkdtemp(join(tmpdir(),'botsky-library-'));root=staging;
      await (options.runner ?? runRclone)(rcloneArgs(staging),product.librarySyncTimeoutMs);
    }
    const files=await discover(root);
    await transaction(db,async c=>{
      await publish(c,request.source,files);
      await c.query("UPDATE library_syncs SET status='done',item_count=$2,finished_at=clock_timestamp() WHERE id=$1",[id,files.length]);
      observer.emit(()=>({eventType:'JOB_COMPLETED',stage:'library.sync',jobId:`library:${id}`,payload:{syncId:id,itemCount:files.length,transaction:'pending_commit'}}));
    });
    return true;
  }catch(error){
    observer.emit({eventType:'JOB_FAILED',stage:'library.sync',...(id?{jobId:`library:${id}`} : {}),payload:{syncId:id,error}});
    if(id)await lock.query("UPDATE library_syncs SET status='failed',error='sync_unavailable_or_invalid',finished_at=clock_timestamp() WHERE id=$1",[id]);
    return Boolean(id);
  }finally{
    if(staging)await rm(staging,{recursive:true,force:true});
    await lock.query("SELECT pg_advisory_unlock(hashtext('library-sync'))");lock.release();
  }
}
export async function recoverLibrarySync(db:Db):Promise<void>{await db.query("UPDATE library_syncs SET status='failed',error='interrupted',finished_at=clock_timestamp() WHERE status='running'");}
export async function scheduleSync(db:Db,config:Config):Promise<void>{
  if(!config.LIBRARY_DRIVE_ENABLED)return;
  await db.query(`INSERT INTO library_syncs(source,actor_id) SELECT 'drive','system:library'
    WHERE NOT EXISTS(SELECT 1 FROM library_syncs WHERE source='drive' AND requested_at>clock_timestamp()-$1::int*interval '1 millisecond')
    ON CONFLICT DO NOTHING`,[product.librarySyncIntervalMs]);
}
