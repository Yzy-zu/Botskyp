import { readFileSync } from 'node:fs';
import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { createDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { syncLabMembers } from '../src/core/membership.js';
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
const db=createDb(url);
const fixture=JSON.parse(readFileSync('tests/fixtures/participants.json','utf8')) as unknown;
beforeAll(()=>migrate(db));afterAll(()=>db.end());
beforeEach(async()=>{await db.query('TRUNCATE users,user_aliases,group_memberships,chats CASCADE');await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true)");});
it('uses the real participant fixture as explicit identity evidence',async()=>{
  await syncLabMembers(db,'300@g.us',fixture);
  const alias=await db.query("SELECT user_id FROM user_aliases WHERE alias='111@lid'");expect(alias.rows[0]?.user_id).toBe('100@s.whatsapp.net');
  const member=await db.query("SELECT is_admin FROM group_memberships WHERE user_id='100@s.whatsapp.net'");expect(member.rows[0]?.is_admin).toBe(true);
  await syncLabMembers(db,'300@g.us',{id:'300@g.us',participants:[]});
  expect((await db.query('SELECT * FROM group_memberships WHERE active')).rowCount).toBe(0);
});
it('preserves an unresolved LID as a separate identity',async()=>{
  await syncLabMembers(db,'300@g.us',{id:'300@g.us',participants:[{id:'999@lid'}]});
  expect((await db.query('SELECT * FROM user_aliases')).rowCount).toBe(0);
});
it('rejects conflicting alias evidence and out-of-lab snapshots',async()=>{
  await syncLabMembers(db,'300@g.us',fixture);
  await expect(syncLabMembers(db,'300@g.us',{id:'300@g.us',participants:[{id:'111@lid',phoneNumber:'999@s.whatsapp.net'}]})).rejects.toThrow('Conflicting');
  expect((await db.query("SELECT user_id FROM user_aliases WHERE alias='111@lid'")).rows[0]?.user_id).toBe('100@s.whatsapp.net');
  expect((await db.query("SELECT evidence FROM user_aliases WHERE alias='111@lid'")).rows[0]?.evidence).toMatch(/^conflict:/);
  await expect(syncLabMembers(db,'300@g.us',{id:'999@g.us',participants:[]})).rejects.toThrow('outside');
});
