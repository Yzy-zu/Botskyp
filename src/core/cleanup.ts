import type { PoolClient } from 'pg';
import { product } from '../../config/product.js';
/** Only ephemeral input/context/quota rows; durable effect dedupe is never purged. */
export async function cleanupEphemeral(c:PoolClient):Promise<void>{
  const claimed=await c.query(`INSERT INTO system_flags(key,value) VALUES('cleanup_last_run','true')
    ON CONFLICT(key) DO UPDATE SET updated_at=clock_timestamp()
    WHERE system_flags.updated_at<clock_timestamp()-$1::int*interval '1 millisecond' RETURNING key`,[product.cleanupIntervalMs]);
  if(!claimed.rowCount)return;
  const args=[product.ephemeralRetentionDays,product.cleanupBatch];
  // Do not remove accepted source evidence while a job could still need it.
  await c.query(`DELETE FROM inbox WHERE id IN (SELECT i.id FROM inbox i WHERE i.status='done'
    AND i.received_at<clock_timestamp()-$1::int*interval '1 day'
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.chat_id=i.chat_id AND j.status IN ('queued','running'))
    ORDER BY i.received_at,i.id LIMIT $2 FOR UPDATE SKIP LOCKED)`,args);
  await c.query(`DELETE FROM seen_events WHERE provider_msg_id IN (SELECT s.provider_msg_id FROM seen_events s
    WHERE s.seen_at<clock_timestamp()-$1::int*interval '1 day'
    AND NOT EXISTS(SELECT 1 FROM inbox i WHERE i.provider_msg_id=s.provider_msg_id)
    ORDER BY s.seen_at,s.provider_msg_id LIMIT $2 FOR UPDATE SKIP LOCKED)`,args);
  await c.query(`DELETE FROM llm_usage WHERE id IN (SELECT id FROM llm_usage
    WHERE at<clock_timestamp()-$1::int*interval '1 day' ORDER BY at,id LIMIT $2 FOR UPDATE SKIP LOCKED)`,args);
  await c.query(`DELETE FROM context_msgs WHERE id IN (SELECT id FROM context_msgs
    WHERE created_at<clock_timestamp()-$1::int*interval '1 day' ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)`,[product.contextRetentionDays,product.cleanupBatch]);
}
