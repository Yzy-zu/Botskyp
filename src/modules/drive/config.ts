import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { product } from '../../../config/product.js';
const remoteId=z.string().regex(/^[A-Za-z0-9_-]{10,160}$/);
const email=z.email().max(254).transform(s=>s.toLowerCase());
export const driveConfigSchema=z.strictObject({
  clientId:z.string().min(1).max(512),clientSecret:z.string().min(1).max(512),refreshToken:z.string().min(1).max(2048),ownerEmail:email,
  folders:z.record(z.string().regex(/^\d+@(g\.us|s\.whatsapp\.net)$/),remoteId),
  recipients:z.record(z.string().regex(/^\d+@s\.whatsapp\.net$/),email),
});
export type DriveConfig=z.infer<typeof driveConfigSchema>;
export async function loadDriveConfig():Promise<DriveConfig>{
  const file=await open('/run/botsky-drive/config.json',constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const st=await file.stat();if(!st.isFile() || st.nlink!==1 || (st.mode&0o077)!==0 || st.size>product.driveConfigBytes)throw new Error('drive_configuration_unavailable');return driveConfigSchema.parse(JSON.parse(await file.readFile('utf8')));}
  finally{await file.close();}
}
