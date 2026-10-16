import { it,expect,vi,afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
const state=vi.hoisted(()=>({child:undefined as unknown,command:'',args:[] as string[],options:{} as Record<string,unknown>}));
vi.mock('node:child_process',()=>({spawn:(command:string,args:string[],options:Record<string,unknown>)=>{
  state.command=command;state.args=args;state.options=options;
  const child=new EventEmitter() as EventEmitter & Record<string,unknown>;
  child.pid=12345;child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  (child.stdin as Record<string,unknown>).end=vi.fn();state.child=child;return child;
}}));
import { runProcess } from '../src/modules/media/process.js';
afterEach(()=>vi.restoreAllMocks());
it('runs only the fixed processor with arrays, a minimal environment and no user CLI arguments',async()=>{
  const process=runProcess('/tmp/test',{operation:'speak',inputs:[],text:'$(touch pwned); --help'});
  const child=state.child as EventEmitter & {stdout:EventEmitter};
  expect(state.command).toBe('/usr/bin/python3');expect(state.args).toEqual(['-I','/app/scripts/media/runner.py']);
  expect(state.options['env']).not.toHaveProperty('GEMINI_API_KEY');expect(state.options['env']).not.toHaveProperty('DATABASE_URL');
  vi.spyOn(global.process,'kill').mockReturnValue(true);child.stdout.emit('data',Buffer.from('{"files":["result.ogg"]}'));child.emit('close',0);
  await expect(process).resolves.toEqual({files:['result.ogg']});
});
it('kills the whole process group on timeout and waits for its close before returning',async()=>{
  const controller=new AbortController();const kill=vi.spyOn(process,'kill').mockReturnValue(true);
  const task=runProcess('/tmp/test',{operation:'mp3',inputs:['input-0.mp3']},controller.signal);
  controller.abort();expect(kill).toHaveBeenCalledWith(-12345,'SIGKILL');
  (state.child as EventEmitter).emit('close',null);await expect(task).rejects.toThrow('process_timeout');
});
it('rejects ffmpeg/processor failures without exposing stderr',async()=>{
  vi.spyOn(process,'kill').mockReturnValue(true);const task=runProcess('/tmp/test',{operation:'mp3',inputs:['input-0.mp3']});
  (state.child as EventEmitter).emit('close',1);await expect(task).rejects.toThrow('process_failed');
});
