import { describe,it,expect,vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp,writeFile,readFile,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptedUrl,checkedAddress,publicIPv4,fetchPublic } from '../src/modules/media/network.js';
import { validateBytes,safeName } from '../src/modules/media/catalog.js';
import { jobDirectory,cleanTemporary,cleanOrphanTemporaries,readArtifacts } from '../src/modules/media/process.js';
const state=vi.hoisted(()=>({responses:[] as {status:number;headers:Record<string,string>;data?:string;complete?:boolean}[],pins:[] as unknown[]}));
vi.mock('node:https',()=>({request:(_url:URL,options:Record<string,unknown>,callback:(res:unknown)=>void)=>{
  state.pins.push(options);const req=new EventEmitter() as EventEmitter & {end:()=>void};
  req.end=()=>queueMicrotask(()=>{
    const config=state.responses.shift();if(!config){req.emit('error',new Error('missing mock'));return;}
    const res=new EventEmitter() as EventEmitter & Record<string,unknown>;
    res.statusCode=config.status;res.headers=config.headers;res.complete=config.complete ?? true;res.destroy=(err?:Error)=>{if(err)queueMicrotask(()=>res.emit('error',err));};
    callback(res);queueMicrotask(()=>{res.emit('data',Buffer.from(config.data ?? 'x'));res.emit('end');});
  });return req;
}}));
const url='https://upload.wikimedia.org/wikipedia/commons/a/ab/Test.ogg';
describe('bounded network policy',()=>{
  it.each(['file:///etc/passwd','http://localhost/a','https://127.0.0.1/a','https://[::1]/a','https://169.254.169.254/latest/meta-data','https://10.0.0.1/a','https://youtube.com/watch?v=x','https://upload.wikimedia.org.evil.test/a','https://evil.test/a','https://user:pw@upload.wikimedia.org/wikipedia/commons/a/ab/a.ogg',url+'#x',url+'?token=secret',url.replace('https:','ftp:'),url.replace('.org/','.org:444/'),url.replace('Test.ogg','a%2fb.ogg'),url.replace('Test.ogg','a%5cb.ogg'),'garbage'])('rejects unapproved URL %s',value=>expect(()=>acceptedUrl(value)).toThrow());
  it.each(['0.0.0.0','10.1.2.3','127.0.0.1','169.254.169.254','172.16.0.1','172.31.1.1','192.168.1.1','100.64.1.1','100.127.255.255','198.18.0.1','198.19.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1'])('blocks nonpublic address %s',ip=>expect(publicIPv4(ip)).toBe(false));
  it('accepts exact Commons files and removes only approved tracking',()=>expect(acceptedUrl(url+'?utm_source=test').href).toBe(url));
  it('rejects mixed public/private DNS answers',async()=>expect(checkedAddress(new URL(url),async()=>['8.8.8.8','10.0.0.1'])).rejects.toThrow('unsafe_dns'));
  it('pins DNS to the validated IPv4 socket',async()=>{
    state.responses=[{status:200,headers:{'content-type':'audio/ogg','content-length':'1'},data:'x'}];state.pins=[];
    expect((await fetchPublic(url,{}, {dns:async()=>['8.8.8.8']})).bytes.toString()).toBe('x');
    const lookup=state.pins[0] as {lookup:(host:string,opts:unknown,cb:(err:unknown,ip:string,family:number)=>void)=>void};
    const cb=vi.fn();lookup.lookup('ignored',{},cb);expect(cb).toHaveBeenCalledWith(null,'8.8.8.8',4);
  });
  it('revalidates redirect URLs before requesting another destination',async()=>{
    state.responses=[{status:302,headers:{location:'https://127.0.0.1/file.ogg'}}];
    await expect(fetchPublic(url,{}, {dns:async()=>['8.8.8.8']})).rejects.toThrow('source_not_allowed');
  });
  it('blocks rebinding on a redirect to an allowed host',async()=>{
    state.responses=[{status:302,headers:{location:url}}];const dns=vi.fn().mockResolvedValueOnce(['8.8.8.8']).mockResolvedValueOnce(['10.0.0.1']);
    await expect(fetchPublic(url,{}, {dns})).rejects.toThrow('unsafe_dns');expect(dns).toHaveBeenCalledTimes(2);
  });
  it('limits redirect loops',async()=>{
    state.responses=Array.from({length:4},()=>({status:302,headers:{location:url}}));
    await expect(fetchPublic(url,{}, {dns:async()=>['8.8.8.8']})).rejects.toThrow('redirect_limit');
  });
  it('rejects oversized Content-Length',async()=>{
    state.responses=[{status:200,headers:{'content-length':'9000000'}}];await expect(fetchPublic(url,{}, {dns:async()=>['8.8.8.8']})).rejects.toThrow('size_or_encoding_limit');
  });
  it('rejects too many actual bytes with no Content-Length',async()=>{
    state.responses=[{status:200,headers:{},data:'xx'}];await expect(fetchPublic(url,{maxBytes:1}, {dns:async()=>['8.8.8.8']})).rejects.toThrow('size_limit');
  });
  it('rejects truncated bodies',async()=>{
    state.responses=[{status:200,headers:{'content-length':'2'},data:'x'}];await expect(fetchPublic(url,{}, {dns:async()=>['8.8.8.8']})).rejects.toThrow('truncated_download');
  });
  it('rejects compressed bodies rather than accepting unbounded decompression',async()=>{
    state.responses=[{status:200,headers:{'content-encoding':'gzip'}}];await expect(fetchPublic(url,{}, {dns:async()=>['8.8.8.8']})).rejects.toThrow('size_or_encoding_limit');
  });
  it('bounds a hung DNS lookup with the job signal',async()=>{
    await expect(fetchPublic(url,{signal:AbortSignal.timeout(20)}, {dns:()=>new Promise(()=>{})})).rejects.toThrow('download_timeout');
  });
});
describe('file boundary',()=>{
  it('rejects fake MIME and oversized actual bytes',()=>{
    expect(()=>validateBytes(Buffer.from('<script>'), 'image/png')).toThrow('mime_mismatch');
    expect(()=>validateBytes(Buffer.alloc(8_000_001), 'audio/mpeg')).toThrow('size_limit');
    expect(()=>validateBytes(Buffer.from('abc'), 'application/x-sh')).toThrow('unsupported_mime');
  });
  it.each(['../../etc/passwd','a/b','a\\b','$(touch pwned)',';rm -rf x','x\nfoo','-option'])('rejects malicious generated names %s',id=>expect(()=>safeName(id,'png')).toThrow());
  it('cleans only owned temporaries, preserves neighbors and originals',async()=>{
    const root=await mkdtemp(join(tmpdir(),'botsky-test-'));try{
      await writeFile(join(root,'original.txt'),'keep');const cwd=await jobDirectory('123',root);await writeFile(join(cwd,'scratch'),'data');
      await cleanOrphanTemporaries(root);await cleanOrphanTemporaries(root);expect(await readFile(join(root,'original.txt'),'utf8')).toBe('keep');
      await expect(jobDirectory('../outside',root)).rejects.toThrow('unsafe_job_path');await expect(cleanTemporary('../../outside',root)).rejects.toThrow('unsafe_job_path');
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('rejects symlink workdirs and output traversal',async()=>{
    const root=await mkdtemp(join(tmpdir(),'botsky-test-'));try{
      await symlink(tmpdir(),join(root,'123'));await expect(jobDirectory('123',root)).rejects.toThrow('unsafe_job_path');
      await expect(readArtifacts(root,'123',['../../etc/passwd'],'read')).rejects.toThrow('unsafe_output_path');
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
