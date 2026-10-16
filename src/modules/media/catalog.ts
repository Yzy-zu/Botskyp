import { z } from 'zod';
import { product } from '../../../config/product.js';
export const operation=z.enum(['download','mp3','ogg','wav','mp4','png','jpeg','webp','sticker','animated_sticker','bass','fast','slow','qr_create','qr_read','ocr','read','office_pdf','pdf_compress','pdf_crop','pdf_merge','pdf_images','images_pdf','transcribe','speak']);
export type Operation=z.infer<typeof operation>;
export const requestSchema=z.strictObject({
  operation, url:z.string().max(2048).optional(), text:z.string().max(product.mediaTextChars).optional(),
  start:z.number().int().min(1).max(product.mediaPdfPages).optional(),end:z.number().int().min(1).max(product.mediaPdfPages).optional(),
  summary:z.boolean().optional(),
});
export const payloadSchema=requestSchema.extend({sources:z.array(z.unknown()).max(product.mediaMaxFiles)}).strict();
export const extensions:Record<string,string>={
  'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif',
  'audio/mpeg':'mp3','audio/ogg':'ogg','application/ogg':'ogg','audio/wav':'wav','audio/x-wav':'wav','audio/mp4':'m4a',
  'video/mp4':'mp4','video/webm':'webm','video/ogg':'ogv','application/pdf':'pdf','text/plain':'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
};
export function extension(mime:string):string{const ext=extensions[mime];if(!ext)throw new Error('unsupported_mime');return ext;}
export function validateBytes(bytes:Buffer,mime:string):void{
  const ext=extension(mime);if(!bytes.length || bytes.length>product.mediaInputBytes)throw new Error('size_limit');
  const prefix=bytes.subarray(0,16);const ascii=prefix.toString('latin1');
  const valid:Record<string,boolean>={png:prefix.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),jpg:prefix[0]===255 && prefix[1]===216 && prefix[2]===255,
    webp:ascii.startsWith('RIFF') && ascii.slice(8,12)==='WEBP',gif:ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'),
    pdf:ascii.startsWith('%PDF-'),ogg:ascii.startsWith('OggS'),ogv:ascii.startsWith('OggS'),
    mp3:ascii.startsWith('ID3') || (prefix[0]===255 && ((prefix[1] ?? 0)&224)===224),
    wav:ascii.startsWith('RIFF') && ascii.slice(8,12)==='WAVE',mp4:ascii.slice(4,8)==='ftyp',m4a:ascii.slice(4,8)==='ftyp',webm:prefix.subarray(0,4).equals(Buffer.from('1a45dfa3','hex')),
    docx:ascii.startsWith('PK\x03\x04'),xlsx:ascii.startsWith('PK\x03\x04'),pptx:ascii.startsWith('PK\x03\x04'),
    txt:!bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes),
  };
  if(!valid[ext])throw new Error('mime_mismatch');
}
export function safeName(id:string,ext:string):string{
  if(!/^[a-z0-9][a-z0-9-]*$/i.test(id) || !/^[a-z0-9]{2,5}$/.test(ext))throw new Error('unsafe_filename');
  return `botsky-${id}.${ext}`;
}
export const outputMime:Record<string,string>={mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',mp4:'video/mp4',png:'image/png',jpg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',txt:'text/plain'};
// A closed conversion matrix, shared by validation and operator documentation.
const images=['png','jpg','webp','gif'];
const audio=['mp3','ogg','wav','m4a'];
const video=['mp4','webm','ogv'];
type Policy={inputs:string[];outputs:string[];maxBytes:number;maxSeconds:number;timeoutMs:number};
function policy(inputs:string[],outputs:string[],maxBytes:number=product.mediaOutputBytes,maxSeconds:number=0):Policy{
  return {inputs,outputs,maxBytes,maxSeconds,timeoutMs:product.mediaTimeoutMs};
}
const av=[...audio,...video];
export const conversions:Record<Operation,Policy>={
  download:policy([...images,...av],['png','mp3','mp4'],product.mediaOutputBytes,product.mediaDurationSeconds),
  mp3:policy(av,['mp3'],product.mediaOutputBytes,product.mediaDurationSeconds),
  ogg:policy(av,['ogg'],product.mediaOutputBytes,product.mediaDurationSeconds),
  wav:policy(av,['wav'],product.mediaOutputBytes,product.mediaDurationSeconds),
  bass:policy(av,['mp3'],product.mediaOutputBytes,product.mediaDurationSeconds),
  fast:policy(av,['mp3'],product.mediaOutputBytes,product.mediaDurationSeconds),
  slow:policy(av,['mp3'],product.mediaOutputBytes,product.mediaDurationSeconds),
  transcribe:policy(av,['txt'],product.mediaOutputBytes,product.mediaDurationSeconds),
  mp4:policy(video,['mp4'],product.mediaVideoBytes,product.mediaVideoSeconds),
  png:policy(images,['png'],product.mediaImageBytes),jpeg:policy(images,['jpg'],product.mediaImageBytes),
  webp:policy(images,['webp'],product.mediaImageBytes),sticker:policy(images,['webp'],product.mediaStickerBytes),
  animated_sticker:policy([...video,'gif'],['webp'],product.mediaAnimatedStickerBytes,product.mediaStickerSeconds),
  qr_create:policy([],['png'],product.mediaImageBytes),qr_read:policy(images,['txt']),
  speak:policy([],['ogg'],product.mediaOutputBytes,product.mediaDurationSeconds),
  read:policy(['pdf','txt'],['txt']),office_pdf:policy(['docx','xlsx','pptx'],['pdf']),ocr:policy([...images,'pdf'],['txt']),
  pdf_compress:policy(['pdf'],['pdf']),pdf_crop:policy(['pdf'],['pdf']),pdf_merge:policy(['pdf'],['pdf']),
  pdf_images:policy(['pdf'],['png']),images_pdf:policy(images,['pdf']),
};
