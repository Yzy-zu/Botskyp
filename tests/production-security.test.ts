import { execFileSync } from 'node:child_process';
import { expect,it } from 'vitest';
import { z } from 'zod';
import { createRegistry } from '../src/core/registry.js';
import { moduleEnabled } from '../src/core/permissions.js';
import { modules } from '../src/core/control-tools.js';
import { context,message,config } from './school-harness.js';
it('backup retention, corruption, checksums and secret scanner pass Python checks',()=>{
  expect(()=>execFileSync('python3',['tests/backup-security.py'],{stdio:'pipe'})).not.toThrow();
});
it('versioned files pass the secret and personal JID audit',()=>{
  const result=execFileSync('python3',['scripts/security-scan.py'],{encoding:'utf8'});expect(result).toContain('0 archivo(s)');
});
it('every known module defaults off in a new production group',()=>{
  const chat={id:'999@g.us',isGroup:true,enabled:true,settings:{}};
  for(const module of modules)expect(moduleEnabled(chat,module,config),module).toBe(false);
  expect(modules).toContain('media');expect(modules).toContain('polls');
});
// Registry schema/permission checks with no database: available() is pure.
it('sensitive tools never become model callable and schemas reject backend identity fields',async()=>{
  const {db,initialize,resetSchool}=await import('./school-harness.js');
  try{
    await initialize();await resetSchool();
    await context(message('bot ayuda'),async ctx=>{
      const tools=createRegistry().available(ctx);
      for(const t of tools){
        if(['polls','messaging','drive','moderation','xp','games','core'].includes(t.module) || t.permission==='infra.minecraft')expect(t.modelCallable,t.name).toBe(false);
        const schema=z.toJSONSchema(t.args);expect(schema['additionalProperties'],t.name).toBe(false);
        for(const field of ['actor','actorId','chatId','roles'])expect((schema['properties'] as object | undefined) ?? {},t.name).not.toHaveProperty(field);
      }
      for(const t of tools.filter(t=>['minecraft','messaging'].includes(t.module) && t.risk!=='read'))expect(['infra.minecraft','bulk.broadcast','bulk.nuclear']).toContain(t.permission);
    });
  }finally{await db.end();}
});
