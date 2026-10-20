import {it,expect} from 'vitest';
import {collectTurnResult,deliveryOutbox} from '../qa/e2e/result-collector.js';

it.each(['failed','queued','sending'])('delivered terminal media supersedes %s progress', async progress => {
  const rows=[{kind:'media_progress',status:progress,payload:{jobId:'1'}},{kind:'media_result',status:'sent',payload:{jobId:'1'}}];
  expect(deliveryOutbox(rows)).toHaveLength(1);
  const result=await collect('done',rows);
  expect(result.status).toBe('PASS');
  expect(result.terminalState).toBe('DELIVERED');
});
it('does not ignore failed terminal results or another job progress',async()=>{
  const rows=[{kind:'media_progress',status:'failed',payload:{jobId:'2'}},{kind:'media_result',status:'sent',payload:{jobId:'1'}}];
  expect(deliveryOutbox(rows)).toHaveLength(2);
  expect((await collect('done',[{kind:'media_result',status:'failed',payload:{jobId:'1'}}])).status).toBe('FAIL');
});
it('failed processing with delivered error is a worker failure',async()=>{
  const result=await collect('failed',[{kind:'text',status:'sent',payload:{text:'No pude procesarlo.',sourceId:'TEST'}}]);
  expect(result.status).toBe('FAIL');
  expect(result.failureClass).toBe('JOB_FAILED');
});
async function collect(jobStatus:string,rows:{kind:string;status:string;payload:Record<string,unknown>}[]){
  const db={query:async(sql:string)=>({rows:sql.includes('FROM inbox')?[{turn_id:'T',status:'done'}]
    :sql.includes('FROM jobs')?[{id:'1',kind:'media',status:jobStatus,payload:{}}]
    :sql.includes('FROM outbox')?rows:[]})} as unknown as Parameters<typeof collectTurnResult>[0];
  return collectTurnResult(db,0,'TEST','test@g.us','test@s.whatsapp.net','test',200,{},undefined,{timeoutMs:50,pollIntervalMs:5});
}
