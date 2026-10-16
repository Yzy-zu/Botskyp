import { execFileSync } from 'node:child_process';
import { mkdirSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertDedicatedTestServer,cleanupOldTestDatabases,dropTestDatabase,validateTestDatabaseName } from './test-databases.js';

export default async function setup():Promise<()=>Promise<void>> {
  // Resolve the dedicated service explicitly; never inherit another Compose project.
  process.loadEnvFile('.env');
  const root=fileURLToPath(new URL('../',import.meta.url));
  const container=execFileSync('docker',['compose','--project-directory',root,'--file',`${root}docker-compose.yml`,'--project-name','botsky','ps','-q','postgres'],{encoding:'utf8'}).trim();
  const inspect=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'})) as {Config:{Labels:Record<string,string>};NetworkSettings:{Networks:Record<string,{IPAddress:string}>}}[];
  const labels=inspect[0]?.Config.Labels;
  const ip=inspect[0]?.NetworkSettings.Networks['botsky_internal']?.IPAddress;
  if(!ip || labels?.['com.docker.compose.project']!=='botsky' || labels['com.docker.compose.service']!=='postgres')throw new Error('Dedicated test PostgreSQL unavailable');
  const url=new URL(process.env.DATABASE_URL ?? '');
  if(url.username!=='botsky' || url.pathname!=='/botsky')throw new Error('Tests require Botsky database configuration');
  url.hostname=ip;url.port='5432';url.pathname='/postgres';
  const admin=new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:5000});
  const dbName=`botsky_test_${Date.now()}_${process.pid}`;
  validateTestDatabaseName(dbName);
  let created=false;
  try {
    await assertDedicatedTestServer(admin);
    await cleanupOldTestDatabases(admin);
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);created=true;
    url.pathname=`/${dbName}`;
    mkdirSync('.local',{recursive:true,mode:0o700});
    writeFileSync('.local/test-db.json',JSON.stringify({url:url.toString()}),{mode:0o600});
  } catch(error) {
    try {if(created)await dropTestDatabase(admin,dbName);}
    finally {await admin.end();}
    throw error;
  }
  return async()=>{
    try {
      if(!await dropTestDatabase(admin,dbName))throw new Error('Test database still active; retained for next safe cleanup');
    } finally {await admin.end();}
  };
}
