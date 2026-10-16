import pg from 'pg';

const testName=/^botsky_test_(\d{13})_([1-9]\d{0,9})$/;
const staleAfterMs=24*60*60*1000;

export function validateTestDatabaseName(name:string):void {
  if(!testName.test(name))throw new Error('Refusing a non-test database');
}

export function isStaleTestDatabase(name:string,now=Date.now()):boolean {
  const match=testName.exec(name);
  return Boolean(match && Number(match[1])<=now-staleAfterMs);
}

export async function assertDedicatedTestServer(admin:pg.Pool):Promise<void> {
  const result=await admin.query<{safe:boolean}>(`SELECT current_user='botsky'
    AND current_database()='postgres'
    AND current_setting('server_version_num')::int BETWEEN 170000 AND 179999
    AND EXISTS(SELECT 1 FROM pg_database WHERE datname='botsky' AND pg_get_userbyid(datdba)=current_user) AS safe`);
  if(result.rows[0]?.safe!==true)throw new Error('Tests require the dedicated Botsky PostgreSQL 17');
}

/** Never terminate connections or force a drop; recheck ownership and activity. */
export async function dropTestDatabase(admin:pg.Pool,name:string):Promise<boolean> {
  validateTestDatabaseName(name);
  const eligible=await admin.query(`SELECT 1 FROM pg_database WHERE datname=$1
    AND NOT datistemplate AND pg_get_userbyid(datdba)=current_user
    AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=$1)`,[name]);
  if(eligible.rowCount!==1)return false;
  try {await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`);return true;}
  catch(error) {
    // A connection can race with the activity check. Leave that database intact.
    if(typeof error==='object' && error!==null && 'code' in error && error.code==='55006')return false;
    throw error;
  }
}

export async function cleanupOldTestDatabases(admin:pg.Pool,now=Date.now()):Promise<void> {
  const candidates=await admin.query<{datname:string}>(`SELECT datname FROM pg_database
    WHERE NOT datistemplate AND pg_get_userbyid(datdba)=current_user`);
  for(const {datname} of candidates.rows){
    if(isStaleTestDatabase(datname,now))await dropTestDatabase(admin,datname);
  }
}
