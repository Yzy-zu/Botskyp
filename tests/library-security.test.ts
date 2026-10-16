import { beforeAll,beforeEach,afterAll,afterEach,expect,it } from 'vitest';
import { mkdtemp,mkdir,writeFile,symlink,link,rm,chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transaction } from '../src/db/client.js';
import { discover,safeLibraryPath,safeComponent } from '../src/modules/library/discovery.js';
import { publish,categories } from '../src/modules/library/catalog.js';
import { syncLibrary,rcloneArgs,checkRcloneConfig,recoverLibrarySync } from '../src/modules/library/sync.js';
import { db,config,owner,initialize,resetSchool } from './school-harness.js';
import { libraryFiles,seedLibrary } from './library-harness.js';
beforeAll(initialize);let root:string;
beforeEach(async()=>{await resetSchool();root=await mkdtemp(join(tmpdir(),'botsky-library-test-'));});
afterEach(()=>rm(root,{recursive:true,force:true}));afterAll(()=>db.end());
async function file(path='Carpeta nueva/subcarpeta/uno.txt',text='Texto autorizado'){const target=join(root,path);await mkdir(join(target,'..'),{recursive:true});await writeFile(target,text);}
async function queue(source='local'){await db.query('INSERT INTO library_syncs(source,actor_id) VALUES($1,$2)',[source,owner]);}
const state=async()=>(await db.query<{status:string;error:string|null}>('SELECT * FROM library_syncs ORDER BY id DESC LIMIT 1')).rows[0]!;
it('discovers categories from folder names, including accents and nested folders',async()=>{
  await file();await file('Música/dos.txt');const items=await discover(root);expect(items.map(i=>i.category)).toEqual(['Carpeta nueva','Música']);
  await transaction(db,c=>publish(c,'local',items));expect(await transaction(db,c=>categories(c))).toContain('Música: 1');
});
it('idempotent publication preserves item ids and deduplicates immutable bytes',async()=>{
  await seedLibrary();const ids=(await db.query('SELECT id FROM library_items ORDER BY id')).rows;
  await seedLibrary();expect((await db.query('SELECT id FROM library_items ORDER BY id')).rows).toEqual(ids);expect((await db.query('SELECT * FROM library_blobs')).rowCount).toBe(8);
});
it('identical items from both sources have one blob and count once per category',async()=>{
  await seedLibrary();await transaction(db,c=>publish(c,'drive',libraryFiles()));expect((await db.query('SELECT * FROM library_blobs')).rowCount).toBe(8);
  expect(await transaction(db,c=>categories(c))).toContain('Memes: 8');
});
it.each(['../x','/etc/passwd','C:\\x','a/../b','a//b','a/%2f','a/\u202ex','a/.secreto','a/x\n.txt','a/x.rclonelink/../b'])('rejects malicious path %s',path=>{expect(safeLibraryPath(path)).toBe(false);});
it.each(['../a','-flag','a\nb','a:b','a\\b','.hidden','a..b','a/otra','a\u0000b'])('rejects manipulated component %s',name=>{expect(safeComponent(name)).toBe(false);});
it('rejects file symlinks even when pointing inside the allowed root',async()=>{await file('Memes/uno.txt');await symlink(join(root,'Memes/uno.txt'),join(root,'Memes/dos.txt'));await expect(discover(root)).rejects.toThrow();});
it('rejects directory symlinks and a symlink root',async()=>{
  await mkdir(join(root,'Memes'));await symlink('/etc',join(root,'Memes/enlace'));await expect(discover(root)).rejects.toThrow();
  const alias=`${root}-alias`;await symlink(root,alias);try{await expect(discover(alias)).rejects.toThrow();}finally{await rm(alias);}
});
it('rejects hard links and invalid signatures',async()=>{
  await file('Memes/uno.txt');await link(join(root,'Memes/uno.txt'),join(root,'Memes/dos.txt'));await expect(discover(root)).rejects.toThrow('unsafe_file');
  await rm(join(root,'Memes/dos.txt'));await file('Memes/falsa.png');await expect(discover(root)).rejects.toThrow();
});
it('rejects oversize and empty files without publishing a partial catalog',async()=>{
  await file('Memes/vacio.txt','');await expect(discover(root)).rejects.toThrow('size_limit');
  await file('Memes/vacio.txt','x'.repeat(4_000_001));await expect(discover(root)).rejects.toThrow('size_limit');
});
it('ignores unsupported extensions and root files; categories never come from code',async()=>{
  await file('Nuevo/uno.txt');await file('Nuevo/programa.exe');await file('root.txt');expect(await discover(root)).toHaveLength(1);
});
it('reimport disables missing entries but retains historical blobs',async()=>{
  await seedLibrary();await transaction(db,c=>publish(c,'local',libraryFiles(3)));expect((await db.query('SELECT * FROM library_items WHERE enabled')).rowCount).toBe(3);expect((await db.query('SELECT * FROM library_blobs')).rowCount).toBe(8);
});
it('invalid publication rolls back the entire catalog change',async()=>{
  await seedLibrary();const items=libraryFiles(1);items[0]!.sha256='0'.repeat(64);
  await expect(transaction(db,c=>publish(c,'local',items))).rejects.toThrow();expect((await db.query('SELECT * FROM library_items WHERE enabled')).rowCount).toBe(8);
});
it('local sync records status and imports a complete snapshot',async()=>{
  await file();await queue();expect(await syncLibrary(db,config,{root})).toBe(true);expect((await state()).status).toBe('done');expect((await db.query('SELECT * FROM library_items')).rowCount).toBe(1);
});
it('missing source files produce a sanitized failure preserving the last library',async()=>{
  await seedLibrary();await queue();await syncLibrary(db,config,{root:join(root,'missing')});expect(await state()).toMatchObject({status:'failed',error:'sync_unavailable_or_invalid'});expect((await db.query('SELECT * FROM library_items WHERE enabled')).rowCount).toBe(8);
});
it.each(['rclone_down','timeout','malicious/credential/error'])('Drive failure %s preserves local stock',async reason=>{
  await seedLibrary();await queue('drive');let duration=0;
  await syncLibrary(db,{...config,LIBRARY_DRIVE_ENABLED:true},{checkConfig:async()=>{},runner:async(_args,timeout)=>{duration=timeout;throw new Error(reason);}});
  expect(duration).toBe(180_000);expect((await state()).status).toBe('failed');expect((await db.query('SELECT * FROM library_items WHERE enabled')).rowCount).toBe(8);expect((await state()).error).not.toContain(reason);
});
it('Drive download is invisible until completion and publication is atomic',async()=>{
  await queue('drive');await syncLibrary(db,{...config,LIBRARY_DRIVE_ENABLED:true},{checkConfig:async()=>{},runner:async args=>{
    expect((await db.query('SELECT * FROM library_items')).rowCount).toBe(0);
    await mkdir(join(args[2]!,'Nueva'));await writeFile(join(args[2]!,'Nueva/uno.txt'),'Autorizado');
  }});expect((await state()).status).toBe('done');expect((await db.query('SELECT category FROM library_items')).rows[0]?.category).toBe('Nueva');
});
it('concurrent sync attempts never launch two rclone processes',async()=>{
  await queue('drive');let started!:()=>void,finish!:()=>void;const ready=new Promise<void>(r=>{started=r;}),done=new Promise<void>(r=>{finish=r;});let runs=0;
  const pending=syncLibrary(db,{...config,LIBRARY_DRIVE_ENABLED:true},{checkConfig:async()=>{},runner:async()=>{runs++;started();await done;}});
  await ready;expect(await syncLibrary(db,config,{root})).toBe(false);finish();await pending;expect(runs).toBe(1);
});
it('sync lock recovers and execution rechecks owner permissions without deleting catalog',async()=>{
  await queue();await syncLibrary(db,config,{root:join(root,'absent')});await queue();await file();await syncLibrary(db,config,{root});expect((await state()).status).toBe('done');
  await db.query("UPDATE library_syncs SET status='running' WHERE id=(SELECT max(id) FROM library_syncs)");await recoverLibrarySync(db);expect((await state()).status).toBe('failed');
  await queue();await syncLibrary(db,{...config,OWNER_JIDS:['900@s.whatsapp.net']},{root});expect((await state()).status).toBe('failed');expect((await db.query('SELECT * FROM library_items WHERE enabled')).rowCount).toBe(1);
});
it('rclone arguments only copy FROM the fixed remote, with bounded resources and no shell',()=>{
  const args=rcloneArgs('/tmp/staging');expect(args.slice(0,3)).toEqual(['copy','botsky-library:','/tmp/staging']);expect(args).toContain('drive.readonly');expect(args).toContain('--drive-skip-shortcuts');expect(args).not.toContain('sync');expect(args).not.toContain('--copy-links');
});
it('rclone config must be private, one readonly Drive remote and an explicit root folder',async()=>{
  const path=join(root,'rclone.conf');const valid='[botsky-library]\ntype = drive\nscope = drive.readonly\nroot_folder_id = test_folder\ntoken = {}\n';
  await writeFile(path,valid,{mode:0o600});await expect(checkRcloneConfig(path)).resolves.toBeUndefined();
  await chmod(path,0o644);await expect(checkRcloneConfig(path)).rejects.toThrow();await chmod(path,0o600);
  for(const text of [valid.replace('drive.readonly','drive'),valid+'[other]\ntype = local\n',valid+'config_refresh_token = $(id)\n',valid.replace('root_folder_id = test_folder\n','')]){await writeFile(path,text);await expect(checkRcloneConfig(path)).rejects.toThrow();}
});
it('a slow Drive sync does not block a bot ping or expose a partial catalog',async()=>{
  const { command }=await import('./school-harness.js');await queue('drive');let started!:()=>void,finish!:()=>void;
  const ready=new Promise<void>(r=>{started=r;}),done=new Promise<void>(r=>{finish=r;});
  const pending=syncLibrary(db,{...config,LIBRARY_DRIVE_ENABLED:true},{checkConfig:async()=>{},runner:async()=>{started();await done;}});
  try{await ready;const before=Date.now();expect(await command('bot ping')).toBe('pong');expect(Date.now()-before).toBeLessThan(1500);expect((await db.query('SELECT * FROM library_items')).rowCount).toBe(0);}finally{finish();await pending;}
});

it('rejects a FIFO without blocking discovery',async()=>{
  const { execFile }=await import('node:child_process');const { promisify }=await import('node:util');await mkdir(join(root,'Memes'));await promisify(execFile)('mkfifo',[join(root,'Memes/pipe.txt')]);
  await expect(discover(root)).rejects.toThrow('unsafe_file');
});
