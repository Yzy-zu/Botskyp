import { stateSchema } from '../../modules/games/state.js';
import { total, cardText } from '../../modules/games/rules.js';
import { sanitizeOutputV2 } from '../output-sanitizer-v2.js';
import { product } from '../../../config/product.js';
import { level } from '../../modules/xp/service.js';
import type { ToolResult as LegacyResult } from '../tools.js';
import type { ToolResult } from '../tool-result.js';
import type { ToolMetadataV2 } from '../tool-registry-v2.js';
import type { ExecutionContextV2 } from './types.js';

/** Facts are authoritative. Never infer a successful effect by parsing human reply text. */
export async function normalizeLegacyResult(ctx: ExecutionContextV2, tool: ToolMetadataV2, result: LegacyResult, args: Record<string, unknown>): Promise<ToolResult> {
  const base = { toolName: tool.name, domain: tool.domain, ...(result.ok ? {presentation:sanitizeOutputV2(result.reply)} : {}) };
  if (!result.ok) return { ...base, status: 'error', code: 'LEGACY_REJECTED', data: { kind: result.kind }, presentation:sanitizeOutputV2(result.message === 'No.' ? 'No pude realizar esa operación con los datos disponibles.' : result.message) };
  const code = tool.name.replace(/[.-]/gu, '_').toUpperCase();
  const c = ctx.legacy.c;
  if (tool.name === 'xp.balance' || tool.name === 'xp.daily') {
    const w = (await c.query<{ balance: number; streak: number }>('SELECT balance,streak FROM wallets WHERE user_id=$1', [ctx.actorId])).rows[0]!;
    return { ...base, status: 'ok', code, data: { balance: w.balance, level: level(w.balance), streak: w.streak } };
  }
  if (tool.name === 'notes.list') {
    const notes = result.facts.notes as { id: string; body: string }[];
    return { ...base, status: 'ok', code, data: { notes: notes.map(n => ({ id: n.id, body: n.body })) } };
  }
  if (tool.name === 'memory.list') {
    const memories = (await c.query('SELECT id,body FROM user_memories WHERE user_id=$1 ORDER BY id', [ctx.actorId])).rows;
    return { ...base, status: 'ok', code, data: { memories } };
  }
  if (tool.name === 'reminders.list') {
    const reminders = (await c.query(`SELECT id,body,due_at,timezone,status FROM reminders WHERE chat_id=$1 AND owner_id=$2
      AND status IN ('pending','queued') ORDER BY due_at LIMIT $3`, [ctx.chatId, ctx.actorId, product.reminderResults])).rows;
    return { ...base, status: 'ok', code, data: { reminders } };
  }
  if (tool.name === 'polls.results') return { ...base, status: 'ok', code, data: result.facts };
  if (tool.name === 'polls.vote') {
    const vote=(await c.query<{label:string;option_idx:number}>(`SELECT o.label,v.option_idx FROM poll_votes v JOIN poll_options o ON o.poll_id=v.poll_id AND o.idx=v.option_idx
      WHERE v.poll_id=$1 AND v.voter_id=$2`,[args.id,ctx.actorId])).rows[0];
    if(!vote || vote.option_idx!==args.option)return {...base,status:'uncertain',code:'VOTE_NOT_MATCHED',data:{}};
    return { ...base, status: 'ok', code, data: { pollId: args.id, option: vote.option_idx,label:vote.label } };
  }
  if(tool.name.startsWith('games.')){
    const game=(await c.query<{kind:string;status:string;state:unknown}>(`SELECT g.kind,g.status,g.state FROM games g JOIN game_actions a ON a.game_id=g.id
      WHERE a.chat_id=$1 AND a.user_id=$2 AND a.source_id=$3`,[ctx.chatId,ctx.actorId,ctx.sourceMessageId])).rows[0];
    const state=stateSchema.safeParse(game?.state);
    if(game?.kind==='blackjack' && state.success){
      const player=state.data.players.find(p=>p.id===ctx.actorId);
      if(player)return {...base,status:'ok',code,data:{hand:cardText(player.hand),total:total(player.hand),bet:player.bet,closed:game.status==='done',dealer:cardText(game.status==='done'?state.data.dealer:state.data.dealer.slice(0,1)),returnedXp:state.data.results?.[ctx.actorId]}};
    }
  }
  if(tool.name.startsWith('cooperacha.')){
    const co=(await c.query<{total:number;goal:number;status:string}>('SELECT total,goal,status FROM cooperachas WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 1',[ctx.chatId])).rows[0];
    if(co)return {...base,status:'ok',code,data:{total:co.total,goal:co.goal,open:co.status==='open'},presentation:`La cooperacha lleva ${co.total} de ${co.goal} XP.${co.status==='open'?' Sigue abierta.':' Ya terminó.'}`};
  }
  if (tool.name === 'media.status') {
    const jobs = (await c.query(`SELECT id,status FROM jobs WHERE kind='media' AND chat_id=$1 AND owner_id=$2 ORDER BY id DESC LIMIT $3`, [ctx.chatId, ctx.actorId, product.mediaMaxFiles])).rows;
    return { ...base, status: 'ok', code, data: { jobs } };
  }
  if (tool.name === 'minecraft.status') return { ...base, status: 'ok', code, data: { observed: true, adapter: 'legacy_status' } };
  if (tool.name === 'web.search') return {...base,status:'ok',code,data:{searchResults:result.reply.split('\n\n').slice(0,product.searchResults).map(block=>{const lines=block.split('\n');return {title:lines[0],snippet:lines.slice(1,-1).join(' '),url:lines.at(-1)};})},requiresLlmSynthesis:true};
  if (tool.name === 'media.process') return {...base,status:result.facts.jobId || result.facts.deliveryRequested?'queued':'ok',code,data:result.facts};
  if (tool.domain === 'minecraft' && ['start','stop','restart','backup','config-set','console'].includes(tool.name.slice('minecraft.'.length)) && !['minecraft.operations'].includes(tool.name)) {
    const op = (await c.query<{ id: string; status: string }>('SELECT id,status FROM minecraft_operations WHERE chat_id=$1 AND actor_id=$2 AND source_id=$3', [ctx.chatId, ctx.actorId, ctx.sourceMessageId])).rows[0];
    if (!op) return { ...base, status: 'uncertain', code: 'MINECRAFT_UNCERTAIN', data: {} };
    return { ...base, status: op.status === 'queued' ? 'queued' : 'uncertain', code, data: { operationId: op.id, operationStatus: op.status } };
  }
  if (['bulk.nuclear','bulk.broadcast','messaging.send'].includes(tool.name)) {
    const op = (await c.query<{ id: string; status: string }>('SELECT id,status FROM bulk_ops WHERE chat_id=$1 AND actor_id=$2 AND source_id=$3 AND kind=$4', [ctx.chatId, ctx.actorId, ctx.sourceMessageId, tool.name === 'bulk.nuclear' ? 'nuclear' : tool.name === 'bulk.broadcast' ? 'broadcast' : 'message'])).rows[0];
    return { ...base, status: op?.status === 'queued' ? 'queued' : 'uncertain', code, data: { operationId: op?.id, operationStatus: op?.status, count: args.count ?? (Array.isArray(args.destinations) ? args.destinations.length : 1) } };
  }
  if(tool.name==='reminders.create')return {...base,status:'ok',code,data:{body:args.body,dueAt:args.dueAt}};
  if(tool.name==='notes.create')return {...base,status:'ok',code,data:{body:args.body}};
  if (['memory.remember','notes.delete'].includes(tool.name)) return { ...base, status: 'ok', code, data: result.facts };
  if (tool.name.startsWith('drive.') && result.facts.jobId) return { ...base, status: 'queued', code: 'LEGACY_JOB_QUEUED', data: { jobId: result.facts.jobId } };
  if (tool.name === 'library.sync') {
    const sync = (await c.query<{ id: string; status: string }>("SELECT id,status FROM library_syncs WHERE actor_id=$1 AND status IN ('queued','running') ORDER BY id DESC LIMIT 1", [ctx.actorId])).rows[0];
    if (sync) return { ...base, status: 'queued', code: 'LEGACY_SYNC_QUEUED', data: sync };
  }
  if (tool.name === 'packs.buy') {
    const order = (await c.query<{ id: string; price: number; status: string }>("SELECT id,price,status FROM pack_orders WHERE chat_id=$1 AND user_id=$2 AND source_id=$3 AND kind='purchase'", [ctx.chatId, ctx.actorId, ctx.sourceMessageId])).rows[0];
    if (order) return { ...base, status: order.status === 'pending_review' ? 'uncertain' : order.status === 'confirmed' ? 'ok' : ['refunded','failed','cancelled'].includes(order.status) ? 'error' : 'queued', code: 'LEGACY_PACK_ORDER', data: order };
  }
  // Transitional canonical reply is kept out of LLM-facing data: v1 replies may contain JIDs/paths.
  return { ...base, status: 'ok', code: 'LEGACY_ADAPTER_OK', data: { adapter: 'legacy', factsAvailable: Object.keys(result.facts).length > 0 }, requiresLlmSynthesis: false };
}
