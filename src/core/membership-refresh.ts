import type { FastifyBaseLogger } from 'fastify';
import { product } from '../../config/product.js';

/** Provider outages must not prevent HTTP startup or later membership recovery. */
export async function startMembershipRefresh(refresh:()=>Promise<void>,log:Pick<FastifyBaseLogger,'warn'>):Promise<()=>void> {
  let running=false;
  async function run():Promise<void> {
    if(running)return;
    running=true;
    try {await refresh();}
    catch {log.warn({where:'membership'},'Evolution no disponible para actualizar miembros; se reintentará');}
    finally {running=false;}
  }
  await run();
  const timer=setInterval(()=>{void run();},product.membershipRefreshMs);
  return ()=>clearInterval(timer);
}
