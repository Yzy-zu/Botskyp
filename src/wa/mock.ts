import type { Delivery, ReconcileResult, SendResult, Transport } from './types.js';
export class MockEvolution implements Transport {
  readonly deliveries=new Map<string,{delivery:Delivery;id:string}>();
  next:'sent'|'retry'|'failed'|'timeout-before'|'timeout-after'='sent';
  connected=true;
  async state():Promise<boolean> {return this.connected;}
  async send(delivery:Delivery):Promise<SendResult> {
    const mode=this.next;this.next='sent';
    if (mode==='retry' || mode==='failed') return {status:mode,reason:'mock_injected'};
    if (mode==='timeout-before') return {status:'uncertain',reason:'mock_timeout'};
    const id=`mock-${delivery.id}`;
    this.deliveries.set(delivery.id,{delivery,id});
    if (mode==='timeout-after') return {status:'uncertain',reason:'mock_timeout'};
    return {status:'sent',id};
  }
  async reconcile(delivery:Delivery):Promise<ReconcileResult> {
    const sent=this.deliveries.get(delivery.id);
    return sent ? {status:'found',id:sent.id} : {status:'absent'};
  }
}
