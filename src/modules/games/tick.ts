import { expireAirdrop } from '../packs/airdrop.js';
import { transaction,type Db } from '../../db/client.js';
import type { Config } from '../../config.js';
import { moduleEnabled,type Chat } from '../../core/permissions.js';
import { product } from '../../../config/product.js';
import { beginBlackjack,advance,describe,finishBlackjack } from './blackjack.js';
import { cancelGame,gameNotice,resolveRoulette } from './service.js';
import { loadGame,saveGame } from './state.js';
export async function tickGames(db:Db,config:Config):Promise<void>{
  const due=await db.query<{id:string;chat_id:string}>("SELECT id,chat_id FROM games WHERE status IN ('lobby','playing','open') AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT $1",[product.gameTickBatch]);
  for(const row of due.rows)await transaction(db,async c=>{
    const lock=await c.query<{held:boolean}>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held',[`games:${row.chat_id}`]);
    if(!lock.rows[0]?.held)return;
    await c.query('SELECT user_id FROM wallets WHERE user_id IN (SELECT user_id FROM game_players WHERE chat_id=$1 AND active) ORDER BY user_id FOR UPDATE NOWAIT',[row.chat_id]);
    const g=await loadGame(c,row.chat_id,row.id);
    if(!g || g.expires_at.getTime()>Date.now())return;
    const ch=(await c.query<{enabled:boolean;settings:Chat['settings']}>('SELECT enabled,settings FROM chats WHERE id=$1',[g.chat_id])).rows[0];
    const flags=await c.query("SELECT 1 FROM system_flags WHERE key IN ('emergency','maintenance') AND value='true'::jsonb");
    if(flags.rowCount)return;
    const allowed=ch?.enabled && moduleEnabled({id:g.chat_id,isGroup:true,...ch},'games',config);
    if(!allowed){
      if(g.kind==='airdrop'){await expireAirdrop(c,g.id);g.status='expired';await saveGame(c,g);}else await cancelGame({c},g);
      return;
    }
    if(g.kind==='airdrop'){await expireAirdrop(c,g.id);g.status='expired';await saveGame(c,g);await gameNotice({c},g,`Airdrop ${g.id} vencido sin ganador.`);return;}
    if(g.kind==='roulette'){await gameNotice({c},g,await resolveRoulette({c},g));return;}
    const now=new Date();
    if(g.status==='lobby')beginBlackjack(g,now);
    else{const p=g.state.players[g.state.turn];if(p)p.stood=true;g.state.turn++;advance(g,now);}
    await finishBlackjack(c,g);await saveGame(c,g);await gameNotice({c},g,describe(g));
  }).catch((error:unknown)=>{
    if(typeof error==='object' && error!==null && 'code' in error && error.code==='55P03')return;
    throw error;
  });
}
