import { digest } from '../src/modules/media/storage.js';
import { publish } from '../src/modules/library/catalog.js';
import { transaction } from '../src/db/client.js';
import { db } from './school-harness.js';
export function libraryFiles(count=8,category='Memes'){
  return Array.from({length:count},(_,i)=>{const data=Buffer.from(`Contenido autorizado ${category} ${i}`);return {path:`${category}/archivo-${i}.txt`,category,sha256:digest(data),mime:'text/plain',size:data.length,data};});
}
export async function seedLibrary(count=8,category='Memes'):Promise<void>{await transaction(db,c=>publish(c,'local',libraryFiles(count,category)));}
