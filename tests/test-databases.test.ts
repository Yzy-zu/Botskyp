import { readFileSync } from 'node:fs';
import pg from 'pg';
import { it,expect } from 'vitest';
import { assertDedicatedTestServer,cleanupOldTestDatabases,dropTestDatabase,isStaleTestDatabase,validateTestDatabaseName } from './test-databases.js';

it('accepts only strict generated test names and never treats production names as stale',()=>{
  for(const name of ['botsky','postgres','evolution_db','botsky_test_old','botsky_test_1234567890123_0','botsky_test_1234567890123_1_extra','botsky_test_1234567890123_1;DROP DATABASE botsky']){
    expect(()=>validateTestDatabaseName(name)).toThrow('non-test');
    expect(isStaleTestDatabase(name)).toBe(false);
  }
  expect(()=>validateTestDatabaseName('botsky_test_1234567890123_1')).not.toThrow();
});

it('retains recent and future test databases, cleaning stale names after 24 hours',()=>{
  const now=Date.now();const day=24*60*60*1000;
  expect(isStaleTestDatabase(`botsky_test_${now}_1`,now)).toBe(false);
  expect(isStaleTestDatabase(`botsky_test_${now+day}_1`,now)).toBe(false);
  expect(isStaleTestDatabase(`botsky_test_${now-day+1}_1`,now)).toBe(false);
  expect(isStaleTestDatabase(`botsky_test_${now-day}_1`,now)).toBe(true);
});

it('drops stale inactive test databases, preserves active ones and rejects production drops',async()=>{
  const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
  const connection=new URL(url);connection.pathname='/postgres';
  const admin=new pg.Pool({connectionString:connection.toString(),max:1});
  const stamp=Date.now()-2*24*60*60*1000;
  const idleName=`botsky_test_${stamp}_${process.pid}`;
  const activeName=`botsky_test_${stamp+1}_${process.pid}`;
  const created:string[]=[];let active:pg.Pool|undefined;
  try {
    await assertDedicatedTestServer(admin);
    for(const name of [idleName,activeName]){
      validateTestDatabaseName(name);
      await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);created.push(name);
    }
    connection.pathname=`/${activeName}`;
    active=new pg.Pool({connectionString:connection.toString(),max:1});await active.query('SELECT 1');
    await cleanupOldTestDatabases(admin);
    const remaining=await admin.query<{datname:string}>('SELECT datname FROM pg_database WHERE datname=ANY($1)',[[idleName,activeName,'botsky']]);
    expect(remaining.rows.map(row=>row.datname).sort()).toEqual(['botsky',activeName].sort());
    for(const name of ['botsky','postgres','evolution_db','botsky_test_invalid'])await expect(dropTestDatabase(admin,name)).rejects.toThrow('non-test');
    await active.end();active=undefined;
    expect(await dropTestDatabase(admin,activeName)).toBe(true);
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[activeName])).rowCount).toBe(0);
  } finally {
    try {await active?.end();for(const name of created)await dropTestDatabase(admin,name);}
    finally {await admin.end();}
  }
});
