import type { ToolCtx } from './tools.js';
import type { ToolResult } from './tool-result.js';

/** A replay receipt from another logical turn cannot authorize a success claim in this turn. */
export async function currentResultV2(ctx:ToolCtx,result:ToolResult):Promise<ToolResult>{
  if(!['ok','queued'].includes(result.status))return result;
  const found=await ctx.c.query(`SELECT 1 FROM tool_executions WHERE turn_id=$1 AND tool_name=$2 AND status IN ('ok','queued') AND result_json=$3::jsonb`,[ctx.turnId,result.toolName,JSON.stringify(result)]);
  return found.rowCount?result:{toolName:result.toolName,domain:result.domain,status:'uncertain',code:'NO_CURRENT_TURN_RECEIPT',data:{}};
}
