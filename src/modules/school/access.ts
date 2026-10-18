import { defineTool,fail,type Tool,type ToolCtx } from '../../core/tools.js';
import { product } from '../../../config/product.js';
import { z } from 'zod';
/** Group membership and administrative role are rechecked at execution, including confirmations. */
export async function schoolAccess(ctx:ToolCtx,manage=false):Promise<boolean>{
  if(!ctx.chat.isGroup || !ctx.chat.enabled)return false;
  if(ctx.actor.role==='owner')return true;
  const r=await ctx.c.query<{is_admin:boolean}>(`SELECT is_admin FROM group_memberships WHERE chat_id=$1 AND user_id=$2
    AND active AND last_seen_at>clock_timestamp()-$3::int*interval '1 millisecond'`,[ctx.chat.id,ctx.actor.id,product.membershipMaxAgeMs]);
  return Boolean(r.rows[0] && (!manage || (r.rows[0].is_admin && ctx.actor.role==='group_admin')));
}
export function schoolTool<A extends z.ZodType>(tool:Omit<Tool<A>,'module'|'scope'>):Tool{
  return defineTool({capability:{produces:'datos/preview escolar'},...tool,module:'school',scope:'group',async run(ctx,args){
    if(!await schoolAccess(ctx,tool.permission==='school.manage'))return fail('No.');
    return tool.run(ctx,args);
  }});
}
