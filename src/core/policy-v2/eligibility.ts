import { sourceAdmissionV2 } from './source-admission.js';
import { privateLibraryDestination } from '../../modules/library/access.js';
import { driveAllowed } from '../../modules/drive/service.js';
import { product } from '../../../config/product.js';
import type { ExecutionContextV2 } from './types.js';
import { sensitiveMemory } from '../../modules/memory/index.js';

/** Read-only counterparts of historical admission checks. Domain transactions remain authoritative. */
export async function businessEligibility(ctx: ExecutionContextV2, name: string, args: Record<string, unknown>): Promise<string | null> {
  const c = ctx.legacy.c;
  if (['bulk.nuclear','bulk.broadcast','messaging.send'].includes(name) && (await c.query("SELECT 1 FROM system_flags WHERE key='maintenance' AND value='true'::jsonb")).rowCount) return 'DENIED_MAINTENANCE';
  const sourceConflict=await sourceAdmissionV2(ctx,name);
  if(sourceConflict)return sourceConflict;
  if (name === 'memory.list' && ctx.chat.isGroup) return 'DENIED_PRIVATE_ONLY';
  if (name === 'memory.remember') {
    if (sensitiveMemory(String(args.body))) return 'DENIED_SENSITIVE_MEMORY';
    const n = (await c.query<{ n: number }>('SELECT count(*)::int n FROM user_memories WHERE user_id=$1', [ctx.actorId])).rows[0]!.n;
    if (n >= product.memoryLimit) return 'DENIED_MEMORY_LIMIT';
  }
  if (name === 'messaging.send' && (!Array.isArray(args.destinations) || args.destinations.length !== 1)) return 'INVALID_DESTINATION_COUNT';
  if (name.startsWith('drive.') && ['drive.search','drive.download'].includes(name)
    && !await driveAllowed(c, ctx.legacy.config, ctx.chatId, ctx.actorId)) return 'DENIED_DRIVE_DISABLED';
  if (name === 'packs.buy' && !await privateLibraryDestination(c, ctx.legacy.config, ctx.actorId)) return 'DENIED_PRIVATE_DESTINATION';
  if (name === 'library.rain' && args.enabled && !args.config) return 'INVALID_RAIN_CONFIG';
  if (name === 'school.task_edit' && args.title === undefined && args.dueAt === undefined) return 'INVALID_ARGUMENTS';
  if (name === 'polls.vote') {
    const poll = (await c.query<{ status: string; closes_at: Date }>('SELECT status,closes_at FROM polls WHERE chat_id=$1 AND id::text=$2', [ctx.chatId, args.id])).rows[0];
    if (!poll || poll.status !== 'open' || poll.closes_at <= ctx.now) return 'DENIED_POLL_CLOSED';
    if (!(await c.query('SELECT 1 FROM poll_options WHERE poll_id=$1 AND idx=$2', [args.id, args.option])).rowCount) return 'INVALID_POLL_OPTION';
  }
  if (['games.blackjack','games.roulette'].includes(name)) {
    if ((await c.query("SELECT 1 FROM games WHERE chat_id=$1 AND status='lobby'", [ctx.chatId])).rowCount) return 'DENIED_GAME_LOBBY';
    if ((await c.query('SELECT 1 FROM game_players WHERE chat_id=$1 AND user_id=$2 AND active', [ctx.chatId, ctx.actorId])).rowCount) return 'DENIED_GAME_ACTIVE';
    if ((await c.query("SELECT 1 FROM sessions WHERE chat_id=$1 AND owner_id=$2 AND status='active' AND expires_at>clock_timestamp()", [ctx.chatId, ctx.actorId])).rowCount) return 'DENIED_SESSION_ACTIVE';
  }
  return null;
}
export async function economicEligibility(ctx: ExecutionContextV2, name: string, args: Record<string, unknown>): Promise<string | null> {
  const c = ctx.legacy.c;
  let cost = 0;
  if (['games.blackjack','games.roulette'].includes(name)) cost = Number(args.bet ?? product.gameBet);
  if (name === 'games.join') {
    const lobby = (await c.query<{ state: { bet: number } }>("SELECT state FROM games WHERE chat_id=$1 AND status='lobby' AND expires_at>clock_timestamp()", [ctx.chatId])).rows[0];
    if (!lobby) return 'DENIED_GAME_LOBBY_NOT_FOUND';
    cost = lobby.state.bet;
  }
  if (name === 'games.play' && args.move === 'doblar') {
    const game = (await c.query<{ state: { players: { id: string; bet: number }[] } }>(`SELECT g.state FROM games g JOIN game_players p ON p.game_id=g.id
      WHERE g.chat_id=$1 AND p.user_id=$2 AND p.active AND g.status='playing'`, [ctx.chatId, ctx.actorId])).rows[0];
    const player = game?.state.players.find(p => p.id === ctx.actorId);
    if (!player) return 'DENIED_GAME_NOT_FOUND';
    cost = player.bet;
  }
  if (name === 'packs.buy') {
    const happy = (await c.query<{ happy: boolean }>("SELECT coalesce((settings->>'happy_hour_until')::timestamptz>clock_timestamp(),false) happy FROM chats WHERE id=$1", [ctx.chatId])).rows[0]?.happy;
    cost = happy ? product.packHappyPrice : product.packPrice;
  }
  if (name === 'cooperacha.contribute') {
    const co = (await c.query<{ goal: number; total: number }>("SELECT goal,total FROM cooperachas WHERE chat_id=$1 AND status='open' AND expires_at>clock_timestamp()", [ctx.chatId])).rows[0];
    if (!co) return 'DENIED_COOPERACHA_NOT_FOUND';
    cost = Math.min(Number(args.amount), co.goal - co.total);
  }
  if (!cost) return null;
  const balance = (await c.query<{ balance: number }>('SELECT balance FROM wallets WHERE user_id=$1', [ctx.actorId])).rows[0]?.balance ?? 0;
  return balance < cost ? 'DENIED_INSUFFICIENT_XP' : null;
}
export async function cooldownEligibility(ctx: ExecutionContextV2, name: string, args: Record<string, unknown>): Promise<string | null> {
  const c = ctx.legacy.c;
  if (name === 'xp.daily') {
    const last = (await c.query<{ last_daily_at: Date | null }>('SELECT last_daily_at FROM wallets WHERE user_id=$1', [ctx.actorId])).rows[0]?.last_daily_at;
    if (last && ctx.now.getTime() - last.getTime() < product.dailyCooldownMs) return 'DENIED_DAILY_COOLDOWN';
  }
  if (name.startsWith('minecraft.') && !['minecraft.status','minecraft.players','minecraft.resources','minecraft.worlds','minecraft.addons','minecraft.logs','minecraft.config-get','minecraft.operations'].includes(name)) {
    if ((await c.query("SELECT 1 FROM minecraft_operations WHERE status IN ('queued','sending','review')")).rowCount) return 'DENIED_MINECRAFT_BUSY';
  }
  if (['drive.search','drive.download'].includes(name)) {
    if (((await c.query("SELECT 1 FROM jobs WHERE owner_id=$1 AND status IN ('queued','running')", [ctx.actorId])).rowCount ?? 0) >= product.mediaMaxJobs
      || ((await c.query("SELECT 1 FROM jobs WHERE status IN ('queued','running')")).rowCount ?? 0) >= product.mediaQueueLimit) return 'DENIED_JOB_LIMIT';
  }
  if (name === 'games.airdrop' && (await c.query("SELECT 1 FROM games WHERE chat_id=$1 AND kind='airdrop' AND created_at>clock_timestamp()-$2::int*interval '1 millisecond'", [ctx.chatId, product.airdropCooldownMs])).rowCount) return 'DENIED_AIRDROP_COOLDOWN';
  if (name === 'bulk.nuclear') {
    if ((await c.query(`SELECT 1 FROM bulk_ops WHERE kind='nuclear' AND chat_id=$1 AND
      (status IN ('queued','running','paused') OR confirmed_at>clock_timestamp()-$2::int*interval '1 millisecond')`, [ctx.chatId, product.nuclearCooldownMs])).rowCount) return 'DENIED_NUCLEAR_COOLDOWN';
    if (((await c.query("SELECT 1 FROM bulk_ops WHERE kind='nuclear' AND confirmed_at>clock_timestamp()-interval '1 hour'")).rowCount ?? 0) >= product.nuclearHourlyOps) return 'DENIED_NUCLEAR_HOURLY';
  }
  if (['bulk.nuclear','bulk.broadcast','messaging.send'].includes(name)) {
    const recent = (await c.query<{ n: number; targets: number }>(`SELECT count(*) FILTER(WHERE confirmed_at>clock_timestamp()-interval '1 hour')::int n,
      coalesce(sum((params->>'count')::int),0)::int targets FROM bulk_ops WHERE confirmed_at>clock_timestamp()-interval '1 day'`)).rows[0]!;
    if (recent.n >= product.bulkHourlyOps || recent.targets + (name === 'bulk.nuclear' ? Number(args.count) : Array.isArray(args.destinations) ? args.destinations.length : 0) > product.bulkDailyTargets) return 'DENIED_BULK_LIMIT';
    if (((await c.query("SELECT 1 FROM bulk_ops WHERE status IN ('draft','queued','running','paused') AND (status<>'draft' OR expires_at>clock_timestamp())")).rowCount ?? 0) >= product.bulkMaxActive) return 'DENIED_BULK_BUSY';
    if (((await c.query("SELECT 1 FROM jobs WHERE owner_id=$1 AND status IN ('queued','running')", [ctx.actorId])).rowCount ?? 0) >= product.mediaMaxJobs
      || ((await c.query("SELECT 1 FROM jobs WHERE status IN ('queued','running')")).rowCount ?? 0) >= product.mediaQueueLimit) return 'DENIED_JOB_LIMIT';
  }
  return null;
}
