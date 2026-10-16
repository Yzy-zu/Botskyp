import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { minecraft } from '../../../config/minecraft.js';
import { product } from '../../../config/product.js';
import { parseResponse,requestSchema,writeAction,type Request,type Response } from './protocol.js';
const exec=promisify(execFile);
export type Runner=(file:string,args:string[],options:{timeout:number;maxBuffer:number;encoding:'utf8';killSignal:'SIGKILL'})=>Promise<{stdout:string}>;
export class MinecraftError extends Error {
  constructor(public readonly kind:'timeout'|'ssh'|'protocol'|'disabled'){super(`Minecraft ${kind}`);}
}
export function sshArguments(request:Request,id:string):string[]{
  // The remote login shell only sees this fixed alphabet, never interpolated text.
  const token=Buffer.from(JSON.stringify(request)).toString('base64url');
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid operation ID');
  return ['-F','/dev/null','-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes',
    '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${minecraft.knownHosts}`,
    '-o','GlobalKnownHostsFile=/dev/null','-o','ConnectTimeout=5',
    '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','ClearAllForwardings=yes',
    '-i',minecraft.identity,`${minecraft.user}@${minecraft.host}`,`v1 ${id} ${token}`];
}
export async function callMinecraft(input:Request,id:string=randomUUID(),runner:Runner=exec):Promise<Response>{
  const request=requestSchema.parse(input);
  let stdout:string;
  try{({stdout}=await runner('/usr/bin/ssh',sshArguments(request,id),{
    timeout:writeAction(request.action)?product.minecraftWriteTimeoutMs:product.minecraftTimeoutMs,
    maxBuffer:product.minecraftMaxOutputBytes,encoding:'utf8',killSignal:'SIGKILL',
  }));}
  catch(error){throw new MinecraftError(error!==null && typeof error==='object' && 'killed' in error && error.killed?'timeout':'ssh');}
  try{return parseResponse(stdout,id,request.action);}
  catch{throw new MinecraftError('protocol');}
}
export type MinecraftClient=typeof callMinecraft;
