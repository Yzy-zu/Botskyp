import type { ExecutionContextV2 } from './types.js';

// These historical services dedupe by source message, rather than by provider call/args.
const games=['games.blackjack','games.roulette','games.join','games.play','games.status','games.cancel','games.airdrop','games.claim'];
const drive=['drive.search','drive.download','drive.upload'];
const single=new Set(['media.process','polls.create','polls.vote','school.task_create','packs.buy','cooperacha.open','cooperacha.contribute']);
/** Read-only admission. Exact replays still return their original R3 receipt; distinct actions cannot alias it. */
export async function sourceAdmissionV2(ctx:ExecutionContextV2,name:string):Promise<string|null>{
  const group=games.includes(name)?games:drive.includes(name)?drive:single.has(name)?[name]:undefined;
  if(!group)return null;
  const previous=await ctx.legacy.c.query(`SELECT 1 FROM tool_executions WHERE turn_id=$1 AND chat_id=$2 AND actor_id=$3
    AND source_message_id=$5 AND tool_name=ANY($4::text[]) AND status IN ('ok','queued','uncertain')`,[ctx.turnId,ctx.chatId,ctx.actorId,group,ctx.sourceMessageId]);
  return previous.rowCount?name==='media.process'?'DENIED_MEDIA_TURN_LIMIT':'DENIED_SOURCE_MESSAGE_CONFLICT':null;
}
