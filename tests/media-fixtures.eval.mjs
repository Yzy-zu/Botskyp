// Run inside the deployed worker: docker exec -i botsky-worker node --input-type=module < tests/media-fixtures.eval.mjs
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
const {runProcess,readArtifacts}=await import('/app/dist/src/modules/media/process.js');
for(const [fixture,operation,mime] of [['sample.png','sticker','image/webp'],['sample.ogg','mp3','audio/mpeg'],['sample.pdf','pdf_compress','application/pdf']]){
  const root=await mkdtemp('/tmp/botsky-fixture-');
  try{
    const name=`input-0.${fixture.split('.').pop()}`;
    await copyFile(`/app/qa/e2e/fixtures/${fixture}`,join(root,name));
    const result=await runProcess(root,{operation,inputs:[name]});
    const artifacts=await readArtifacts(root,'1',result.files,operation);
    assert(artifacts.length>0);assert.equal(artifacts[0].mime,mime);assert(artifacts[0].bytes.length>0);
    globalThis.console.log(`${fixture} -> ${operation} PASS (${artifacts[0].bytes.length} bytes)`);
  }finally{await rm(root,{recursive:true,force:true});}
}
