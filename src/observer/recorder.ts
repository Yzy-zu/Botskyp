import { randomUUID } from 'node:crypto';
import { appendFileSync,closeSync,fsyncSync,mkdirSync,openSync,readdirSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { ObserverEvent, EventInput, Correlation } from './types.js';
import { redact } from './redact.js';
export type Sink = {insert:(events:ObserverEvent[])=>Promise<void>;cleanup?:(days:number)=>Promise<void>};
export type RecorderOptions={dir:string;gitCommit:string;retentionDays:number;maxSpoolMb:number;secrets?:string[];rotateBytes?:number};
let lastWarning=0;
export function observerWarning():void {
  try{if(Date.now()-lastWarning>60_000){lastWarning=Date.now();process.stderr.write('{"observer":"degraded","message":"Observer sink unavailable; business continues"}\n');}}
  catch{/* No remaining safe diagnostic sink. */}
}
/** emit never throws or awaits a DB connection. Each process owns its append file. */
export class Recorder {
  readonly instance=`${hostname()}-${process.pid}-${randomUUID()}`;
  private ordinal=0;private fd:number|undefined;private file='';private size=0;private spoolSize=0;
  private draining:Promise<void>|undefined;private timer:NodeJS.Timeout|undefined;private lastCleanup=0;
  private fallback:ObserverEvent[]=[];private fallbackBytes=0;
  readonly health={spool:false,postgres:false,lastPersistedAt:null as string|null,failures:0};
  constructor(private options:RecorderOptions,private sink:Sink){}
  start():void {
    try{mkdirSync(this.options.dir,{recursive:true,mode:0o700});this.spoolSize=this.files().reduce((n,f)=>n+statSync(join(this.options.dir,f)).size,0);this.health.spool=true;}
    catch{this.fail();}
    this.timer=setInterval(()=>{void this.flush();},2000);this.timer.unref();void this.flush();
  }
  emit(input:EventInput,context:Correlation={}):void {
    try{
      const event:ObserverEvent={...context,...input,eventId:randomUUID(),timestamp:new Date().toISOString(),
        sequence:`${BigInt(Math.floor((performance.timeOrigin+performance.now())*1e6)).toString().padStart(20,'0')}:${this.instance}:${String(++this.ordinal).padStart(12,'0')}`,
        payload:redact(input.payload ?? {},this.options.secrets),processInstance:this.instance,gitCommit:this.options.gitCommit};
      try{this.append(event);this.health.spool=true;}
      catch{this.health.spool=false;this.fail();const bytes=Buffer.byteLength(JSON.stringify(event));if(this.fallback.length<1000 && this.fallbackBytes+bytes<=2*1024*1024){this.fallback.push(event);this.fallbackBytes+=bytes;}}
      void this.flush();
    }catch{this.fail();}
  }
  private fail():void{this.health.failures++;observerWarning();}
  private files():string[]{return readdirSync(this.options.dir).filter(f=>/^\d{4}-\d{2}-\d{2}-.+\.jsonl$/.test(f)).sort();}
  private append(event:ObserverEvent):void {
    const line=Buffer.from(JSON.stringify(event)+'\n');
    if(this.spoolSize+line.length>this.options.maxSpoolMb*1024*1024)throw new Error('observer_spool_limit');
    const date=event.timestamp.slice(0,10);
    if(this.fd===undefined || !this.file.startsWith(date) || this.size+line.length>(this.options.rotateBytes ?? 16*1024*1024)){
      if(this.fd!==undefined){closeSync(this.fd);this.fd=undefined;}
      mkdirSync(this.options.dir,{recursive:true,mode:0o700});
      this.file=`${date}-${this.instance}-${this.ordinal}.jsonl`;this.size=0;
      this.fd=openSync(join(this.options.dir,this.file),'ax',0o600);this.syncDirectory();
    }
    try{appendFileSync(this.fd,line);fsyncSync(this.fd);this.size+=line.length;this.spoolSize+=line.length;}
    catch(error){try{closeSync(this.fd);}catch{this.fail();}this.fd=undefined;throw error;}
  }
  private syncDirectory():void{const fd=openSync(this.options.dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
  private checkpoint(path:string,offset:number):void {
    const tmp=`${path}.${this.instance}.tmp`;const fd=openSync(tmp,'w',0o600);
    try{writeFileSync(fd,String(offset));fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(tmp,path);this.syncDirectory();
  }
  flush():Promise<void> {
    if(this.draining)return this.draining;
    this.draining=this.drain().catch(()=>{this.health.postgres=false;this.fail();}).finally(()=>{this.draining=undefined;});
    return this.draining;
  }
  private async persist(events:ObserverEvent[]):Promise<void>{
    await this.sink.insert(events);this.health.postgres=true;this.health.lastPersistedAt=new Date().toISOString();
  }
  private async drain():Promise<void> {
    if(this.fallback.length){const batch=this.fallback.slice(0,100);await this.persist(batch);this.fallback.splice(0,batch.length);this.fallbackBytes=this.fallback.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e)),0);}
    this.spoolSize=this.files().reduce((n,f)=>n+statSync(join(this.options.dir,f)).size,0);
    let budget=1000;
    for(const file of this.files()){
      if(budget<=0)break;
      const path=join(this.options.dir,file),size=statSync(path).size;
      let offset=0;
      try{offset=Number(readFileSync(path+'.ack','utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(!Number.isSafeInteger(offset) || offset<0 || offset>size)throw new Error('invalid_observer_checkpoint');
      if(offset===size)continue;
      const stream=createReadStream(path,{start:offset,end:size-1});
      const lines=createInterface({input:stream,crlfDelay:Infinity});
      let readError:Error|undefined;
      const failed=(error:Error)=>{readError=error;lines.close();};
      stream.on('error',failed);lines.on('error',failed);
      let batch:ObserverEvent[]=[];let batchBytes=0;let bytes=offset;
      try{
        for await(const line of lines){
          const next=bytes+Buffer.byteLength(line)+1;
          if(next>size)break;
          const event=JSON.parse(line) as ObserverEvent;
          if(!event.eventId || !event.sequence || !event.eventType)throw new SyntaxError('invalid_observer_record');
          batch.push(event);batchBytes+=Buffer.byteLength(line);bytes=next;budget--;
          if(batch.length>=100 || batchBytes>=512*1024 || budget<=0){await this.persist(batch);this.checkpoint(path+'.ack',bytes);batch=[];batchBytes=0;}
          if(budget<=0)break;
        }
        if(readError)throw readError;
        if(batch.length){await this.persist(batch);this.checkpoint(path+'.ack',bytes);}
      }catch(error){if(error instanceof SyntaxError){this.fail();continue;}throw error;}finally{lines.close();stream.destroy();}
    }
    if(Date.now()-this.lastCleanup>3600_000){
      this.lastCleanup=Date.now();await this.sink.cleanup?.(this.options.retentionDays);
      const cutoff=Date.now()-this.options.retentionDays*86400_000;
      for(const file of this.files()){
        const path=join(this.options.dir,file);if(file===this.file || statSync(path).mtimeMs>=cutoff)continue;
        try{if(Number(readFileSync(path+'.ack','utf8'))===statSync(path).size){unlinkSync(path);unlinkSync(path+'.ack');}}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      this.spoolSize=this.files().reduce((n,f)=>n+statSync(join(this.options.dir,f)).size,0);
    }
  }
  async close():Promise<void>{
    if(this.timer)clearInterval(this.timer);
    try{await this.flush();}catch{this.fail();}
    try{if(this.fd!==undefined){closeSync(this.fd);this.fd=undefined;}}catch{this.fail();}
  }
}
