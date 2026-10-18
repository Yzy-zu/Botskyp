export const eventTypes = [
  'INBOUND_ACCEPTED','INBOUND_NORMALIZED','TURN_STARTED','CONTEXT_BUILT',
  'LLM_REQUEST','LLM_RESPONSE','LLM_ERROR','LLM_ATTEMPT_STARTED','LLM_ATTEMPT_RESPONSE','LLM_ATTEMPT_ERROR',
  'CAPABILITY_LOAD','TOOL_PROPOSED','POLICY_EVALUATED','TOOL_STARTED','TOOL_RESULT','TOOL_ERROR',
  'SESSION_BEFORE','SESSION_AFTER','SESSION_UPDATED','ARTIFACT_REGISTERED','ARTIFACT_CONTEXT_LOADED',
  'BUSINESS_MUTATION','TRANSACTION_STARTED','TRANSACTION_COMMIT','TRANSACTION_ROLLBACK',
  'JOB_QUEUED','JOB_CLAIMED','JOB_STARTED','JOB_OUTPUT','JOB_COMPLETED','JOB_FAILED','JOB_RECOVERED',
  'PROCESS_STARTED','PROCESS_OUTPUT','PRESENTER_INPUT','OUTPUT_SANITIZED','ROUTER_METRICS',
  'OUTBOX_QUEUED','OUTBOX_STARTED','OUTBOX_SENT','OUTBOX_FAILED','OUTBOX_RECONCILED',
  'EVOLUTION_REQUEST','EVOLUTION_RESPONSE','EVOLUTION_ERROR','TURN_COMPLETED','TURN_FAILED','PROCESS_LIFECYCLE',
] as const;
export type EventType = typeof eventTypes[number];
export type Correlation = {turnId?:string;chatId?:string;actorId?:string;providerMsgId?:string;inboxId?:string;jobId?:string;sourceMessageId?:string;routerMode?:string;processing?:boolean};
export type ObserverEvent = Correlation & {eventId:string;timestamp:string;sequence:string;eventType:EventType;stage:string;payload:unknown;processInstance:string;gitCommit:string};
export type EventInput = Correlation & {eventType:EventType;stage:string;payload?:unknown};
