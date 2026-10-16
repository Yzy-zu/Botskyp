import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
import { safeLibraryPath,verifyFile,type LibraryFile } from './discovery.js';
export async function publish(c:PoolClient,source:'local'|'drive',files:LibraryFile[]):Promise<void>{
  await c.query("SELECT pg_advisory_xact_lock(hashtext('library-catalog'))");
  const size=(await c.query<{n:string}>('SELECT coalesce(sum(size),0) n FROM library_blobs')).rows[0]!;
  const existing=new Set((await c.query<{sha256:string}>('SELECT sha256 FROM library_blobs')).rows.map(r=>r.sha256));
  const unique=new Map(files.map(f=>[f.sha256,f]));
  if(Number(size.n)+[...unique.values()].filter(f=>!existing.has(f.sha256)).reduce((sum,f)=>sum+f.size,0)>product.libraryStorageBytes)throw new Error('library_storage_limit');
  if(files.length>product.libraryMaxItems)throw new Error('library_item_limit');
  for(const f of files){
    if(!safeLibraryPath(f.path) || f.category!==f.path.split('/')[0] || !verifyFile(f.data,f.mime,f.sha256,f.size))throw new Error('library_invalid_file');
    await c.query('INSERT INTO library_blobs(sha256,mime,size,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[f.sha256,f.mime,f.size,f.data]);
    await c.query(`INSERT INTO library_items(source,path,category,sha256) VALUES($1,$2,$3,$4)
      ON CONFLICT(source,path) DO UPDATE SET category=excluded.category,sha256=excluded.sha256,enabled=true,updated_at=clock_timestamp()`,[source,f.path,f.category,f.sha256]);
  }
  await c.query('UPDATE library_items SET enabled=false,updated_at=clock_timestamp() WHERE source=$1 AND NOT(path=ANY($2::text[]))',[source,files.map(f=>f.path)]);
}
export async function categories(c:PoolClient):Promise<string>{
  const rows=await c.query<{category:string;n:number}>('SELECT category,count(DISTINCT sha256)::int n FROM library_items WHERE enabled GROUP BY category ORDER BY category LIMIT $1',[product.libraryResults]);
  return rows.rows.map(r=>`${r.category}: ${r.n} elementos`).join('\n') || 'Biblioteca sin contenido disponible.';
}
