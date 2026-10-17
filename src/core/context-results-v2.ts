import type { PoolClient } from 'pg';
import type { Config } from '../config.js';
import { product } from '../../config/product.js';
import { sensitiveMemory } from '../modules/memory/index.js';
import { contextData } from './context-data-v2.js';
export type ContextResultKind = 'ocr' | 'qr_read' | 'transcribe' | 'read';
export async function rememberContextResultV2(c: PoolClient, mode: Config['ROUTER_MODE'], input: {
  chatId: string; actorId: string; key: string; kind: ContextResultKind; text: string;
}): Promise<void> {
  if (mode !== 'v1_1' || sensitiveMemory(input.text)) return;
  await c.query(`INSERT INTO context_msgs(chat_id,user_id,role,text,result_kind,result_key)
    VALUES($1,$2,'bot',$3,$4,$5) ON CONFLICT DO NOTHING`, [input.chatId, input.actorId,
    contextData(input.text).slice(0, product.contextV2ResultChars), input.kind, input.key]);
}
