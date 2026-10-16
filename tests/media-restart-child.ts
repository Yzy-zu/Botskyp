import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db,config } from './school-harness.js';
import { claimMedia,processMedia } from '../src/modules/media/worker.js';
const job=await claimMedia(db);
if(!job || !process.env.MEDIA_TEST_ROOT)throw new Error('Isolated media test setup missing');
await processMedia(db,config,job,{
  root:process.env.MEDIA_TEST_ROOT,
  download:async()=>{throw new Error('unused');},attachment:async()=>{throw new Error('unused');},
  process:async cwd=>{
    await writeFile(join(cwd,'partial-result'),'incomplete');
    process.send?.('processing');
    await new Promise(()=>{});return {files:[]};
  },
});
await db.end();
