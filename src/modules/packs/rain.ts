import { z } from 'zod';
import { product } from '../../../config/product.js';
import { transaction,type Db } from '../../db/client.js';
import type { Config } from '../../config.js';
import type { ToolCtx } from '../../core/tools.js';
import { EconomyError } from '../xp/service.js';
import { chatLock } from '../games/state.js';
import { nextSummary,summarySchema,schoolZone } from '../school/schemas.js';
import { libraryAllowed } from '../library/access.js';
import { safeComponent } from '../library/discovery.js';
import { reserve,release } from './orders.js';
export const rainSchema=z.strictObject({schedule:summarySchema,count:z.number().int().min(1).max(product.rainMaxItems),category:z.string().refine(safeComponent).optional()});
export async function configureRain(ctx:ToolCtx,enabled:boolean,args?:z.infer<typeof rainSchema>):Promise<string>{
  await chatLock(ctx.c,ctx.chat.id);
  if(!await libraryAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id,true))throw new EconomyError('No.');
  if(!enabled){
    await ctx.c.query("UPDATE automations SET enabled=false WHERE chat_id=$1 AND kind='content_rain'",[ctx.chat.id]);
    await ctx.c.query(`UPDATE outbox o SET status='failed',last_error='rain_disabled' FROM pack_order_items i JOIN pack_orders p ON p.id=i.order_id
      WHERE o.id=i.outbox_id AND p.chat_id=$1 AND p.kind='rain' AND o.status='queued'`,[ctx.chat.id]);
    return 'Lluvia apagada; publicaciones aún no iniciadas canceladas.';
  }
  const parsed=rainSchema.parse(args),next=nextSummary(parsed.schedule,ctx.now);
  await ctx.c.query(`INSERT INTO automations(chat_id,kind,owner_id,enabled,config,next_run_at,catch_up) VALUES($1,'content_rain',$2,true,$3,$4,false)
    ON CONFLICT(chat_id,kind) DO UPDATE SET owner_id=excluded.owner_id,enabled=true,config=excluded.config,next_run_at=excluded.next_run_at`,[ctx.chat.id,ctx.actor.id,JSON.stringify(parsed),next]);
  return `Lluvia configurada: ${parsed.count} archivos; días ${parsed.schedule.days.join(',')}, ${parsed.schedule.time} (${schoolZone}). Siguiente ${next.toISOString()}. Ejecuciones atrasadas se omiten.`;
}
export async function tickRain(db:Db,config:Config,now=new Date()):Promise<void>{
  const rows=(await db.query<{id:string;chat_id:string;owner_id:string;config:unknown;next_run_at:Date}>("SELECT * FROM automations WHERE kind='content_rain' AND enabled AND next_run_at<=$1 ORDER BY next_run_at LIMIT $2",[now,product.libraryResults])).rows;
  for(const row of rows)await transaction(db,async c=>{
    const held=(await c.query<{held:boolean}>('SELECT pg_try_advisory_xact_lock(hashtext($1)) held',[`games:${row.chat_id}`])).rows[0]?.held;if(!held)return;
    const a=(await c.query<typeof row>("SELECT * FROM automations WHERE id=$1 AND kind='content_rain' AND enabled AND next_run_at<=$2 FOR UPDATE",[row.id,now])).rows[0];if(!a)return;
    const parsed=rainSchema.safeParse(a.config);if(!parsed.success){await c.query('UPDATE automations SET enabled=false WHERE id=$1',[a.id]);return;}
    // Advance first, in the same transaction; entertainment never catches up after an outage.
    await c.query('UPDATE automations SET next_run_at=$2,last_run_at=$3 WHERE id=$1',[a.id,nextSummary(parsed.data.schedule,now),now]);
    if(+now-+a.next_run_at>product.rainGraceMs || !await libraryAllowed(c,config,a.chat_id,a.owner_id,true))return;
    if((await c.query("SELECT 1 FROM pack_orders WHERE chat_id=$1 AND kind='rain' AND (status IN ('queued','pending_review') OR created_at>clock_timestamp()-$2::int*interval '1 minute')",[a.chat_id,product.rainMinIntervalMinutes])).rowCount)return;
    await c.query('SAVEPOINT rain_reservation');
    try{
      const order=await reserve(c,{chat:a.chat_id,user:a.owner_id,source:`rain:${a.id}:${a.next_run_at.toISOString()}`,kind:'rain',count:parsed.data.count,...(parsed.data.category?{category:parsed.data.category}:{})});
      await release(c,order,a.chat_id);await c.query('RELEASE SAVEPOINT rain_reservation');
    }catch(error){
      await c.query('ROLLBACK TO SAVEPOINT rain_reservation');await c.query('RELEASE SAVEPOINT rain_reservation');
      if(!(error instanceof EconomyError))throw error;
      await c.query("INSERT INTO error_log(where_,detail) VALUES('library.rain','Lluvia omitida: biblioteca no disponible')");
    }
  });
}
