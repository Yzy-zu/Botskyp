import { mediaFailure } from './messages.js';
import { z } from 'zod';
import { defineTool,ok } from '../../core/tools.js';
import { product } from '../../../config/product.js';
import { enqueueMedia,beginSearch,beginCollection } from './service.js';
import { requestSchema } from './catalog.js';
const base={module:'media',permission:'chat.use',scope:'both',modelCallable:true,risk:'write'} as const;
export const mediaTools=[
  defineTool({...base,name:'media.process',description:'Convertir el archivo actual/citado/propio reciente. Operaciones: audio mp3/ogg/wav, video mp4, imagen png/jpeg/webp, sticker estático/animado, efectos bass/fast/slow, QR, OCR, lectura, oficina a PDF, PDF comprimir/recortar/páginas, transcribir y voz literal. Todo va a cola. No recibe rutas ni IDs de archivos.',examples:['bot convierte a mp3','bot sticker','bot transcribe','bot voz Hola'],args:requestSchema,run:enqueueMedia}),
  defineTool({...base,name:'media.search',description:'Buscar audio/música o videos en Wikimedia Commons y seleccionar un resultado; sin YouTube.',examples:['bot busca música Beethoven','bot busca video Luna'],args:z.strictObject({query:z.string().min(1).max(product.searchQueryChars),type:z.enum(['audio','video'])}),run:(ctx,a)=>beginSearch(ctx,a.query,a.type)}),
  defineTool({...base,name:'media.collect',description:'Reunir imágenes en PDF o unir PDFs mediante una colección propia de este chat; terminar inicia el trabajo.',examples:['bot junta estas fotos en un PDF','bot une PDF'],args:z.strictObject({operation:z.enum(['images_pdf','pdf_merge'])}),run:(ctx,a)=>beginCollection(ctx,a.operation)}),
  defineTool({...base,risk:'read',name:'media.status',description:'Consultar los últimos trabajos propios de este chat y si su entrega fue confirmada.',examples:['bot trabajos'],args:z.strictObject({}),async run(ctx){
    const rows=(await ctx.c.query<{id:string;status:string;error:string|null;delivery:string|null}>(`SELECT j.id,j.status,j.error,CASE WHEN j.status<>'done' THEN o.status
      WHEN EXISTS(SELECT 1 FROM outbox m WHERE m.kind IN ('media_result','media_text') AND m.payload->>'jobId'=j.id::text AND m.status='uncertain') THEN 'uncertain'
      WHEN EXISTS(SELECT 1 FROM outbox m WHERE m.kind IN ('media_result','media_text') AND m.payload->>'jobId'=j.id::text AND m.status='failed') THEN 'failed'
      WHEN EXISTS(SELECT 1 FROM outbox m WHERE m.kind IN ('media_result','media_text') AND m.payload->>'jobId'=j.id::text AND m.status<>'sent') THEN 'queued'
      ELSE 'sent' END delivery FROM jobs j LEFT JOIN outbox o ON o.id=j.outbox_id
      WHERE j.kind='media' AND j.owner_id=$1 AND j.chat_id=$2 ORDER BY j.id DESC LIMIT $3`,[ctx.actor.id,ctx.chat.id,product.mediaMaxFiles])).rows;
    return ok(rows.map(r=>`#${r.id}: ${r.status==='done'?'procesado':r.status==='running'?'procesando':r.status==='queued'?'en cola':'falló'}; entrega: ${r.delivery==='sent'?'confirmada':r.delivery==='uncertain'?'incierta, sin repetir':r.delivery==='failed'?'fallida':r.delivery ?? 'sin iniciar'}${r.error?`; ${mediaFailure(r.error)}`:''}`).join('\n') || 'No tienes trabajos en este chat.');
  }}),
];
