import { z } from 'zod';
export const msgSchema = z.object({
  id:z.string().min(1), chatId:z.string().regex(/^\d+@(g\.us|s\.whatsapp\.net|lid)$/),
  senderId:z.string().regex(/^\d+@(s\.whatsapp\.net|lid)$/), isGroup:z.boolean(),
  ts:z.coerce.date(), text:z.string(), fromMe:z.boolean(), mentions:z.array(z.string()),
  quoted:z.object({id:z.string(), text:z.string().optional(), senderId:z.string().optional(), fromBot:z.boolean()}).optional(),
  attachments:z.array(z.object({kind:z.string(),ref:z.string(),mime:z.string().optional()})),
});
export type Msg = z.infer<typeof msgSchema>;
export type Delivery = {id:string;chatId:string;text:string;sourceId:string};
export type SendResult = {status:'sent';id:string} | {status:'retry'|'failed'|'uncertain';reason:string};
export type ReconcileResult = {status:'found';id:string} | {status:'absent'|'unknown'};
export interface Transport {
  state():Promise<boolean>;
  send(delivery:Delivery):Promise<SendResult>;
  reconcile(delivery:Delivery, providerId?:string):Promise<ReconcileResult>;
}
