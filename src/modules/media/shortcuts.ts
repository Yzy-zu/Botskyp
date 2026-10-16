import type { Shortcut } from '../../core/shortcuts.js';
export function mediaShortcut(t:string):Shortcut|undefined{
  let m:RegExpExecArray|null;
  if((m=/^(?:descarga|descargar|baja)\s+(https:\/\/\S+)$/iu.exec(t)))return {name:'media.process',args:{operation:'download',url:m[1]}};
  if((m=/^busca(?:r)?\s+(m[uú]sica|audio|video|videos)\s+(.+)$/isu.exec(t)))return {name:'media.search',args:{type:/m[uú]sica|audio/iu.test(m[1]!)?'audio':'video',query:m[2]}};
  if(/^(?:junta|re[uú]ne) (?:estas |las )?(?:fotos|im[aá]genes)(?: en (?:un )?pdf)?$/iu.test(t))return {name:'media.collect',args:{operation:'images_pdf'}};
  if(/^(?:une|unir|junta) (?:estos |los )?pdfs?$/iu.test(t))return {name:'media.collect',args:{operation:'pdf_merge'}};
  if((m=/^(?:convierte|convertir)(?: este archivo)? (?:a )?(mp3|ogg|wav|mp4|png|jpeg|webp)$/iu.exec(t)))return {name:'media.process',args:{operation:m[1]!.toLowerCase()}};
  if((m=/^(?:crea )?qr\s+(.+)$/isu.exec(t)))return {name:'media.process',args:{operation:'qr_create',text:m[1]}};
  if((m=/^(?:voz|lee literalmente)\s+(.+)$/isu.exec(t)))return {name:'media.process',args:{operation:'speak',text:m[1]}};
  if((m=/^(?:recorta pdf|pdf recorta) (\d+)-(\d+)$/iu.exec(t)))return {name:'media.process',args:{operation:'pdf_crop',start:Number(m[1]),end:Number(m[2])}};
  const ops:Record<string,string>={'sticker':'sticker','sticker animado':'animated_sticker','lee qr':'qr_read','ocr':'ocr','lee documento':'read','oficina a pdf':'office_pdf','comprime pdf':'pdf_compress','pdf a imágenes':'pdf_images','pdf a imagenes':'pdf_images','transcribe':'transcribe','transcribe este audio':'transcribe','efecto graves':'bass','efecto rápido':'fast','efecto lento':'slow'};
  const op=ops[t.toLowerCase()];if(op)return {name:'media.process',args:{operation:op}};
  if(/^trabajos$/iu.test(t))return {name:'media.status',args:{}};
  return undefined;
}
