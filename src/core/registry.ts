import { z } from 'zod';
import { ToolRegistry,defineTool,ok } from './tools.js';
import { noteTools } from '../modules/notes/index.js';
import { reminderTools } from '../modules/reminders/index.js';
import { memoryTools } from '../modules/memory/index.js';
import { webTools } from '../modules/web/index.js';
import { xpTools } from '../modules/xp/index.js';
import { gameTools } from '../modules/games/index.js';
import { moderationTools } from '../modules/moderation/index.js';
import { schoolTools } from '../modules/school/index.js';
import { controlTools } from './control-tools.js';
export function createRegistry():ToolRegistry{
  const registry=new ToolRegistry();
  for(const tool of [...noteTools,...reminderTools,...memoryTools,...webTools,...schoolTools,...xpTools,...gameTools,...moderationTools,...controlTools])registry.register(tool);
  registry.register(defineTool({name:'core.ping',module:'core',permission:'chat.use',scope:'both',modelCallable:false,risk:'read',description:'Comprobar que Botsky responde.',examples:['bot ping'],args:z.strictObject({}),async run(){return ok('pong');}}));
  registry.register(defineTool({name:'core.help',module:'core',permission:'chat.use',scope:'both',modelCallable:false,risk:'read',description:'Ayuda disponible por tema y permisos.',examples:['bot ayuda','bot ayuda notas'],args:z.strictObject({topic:z.string().optional()}),async run(ctx,args){return ok(registry.help(ctx,args.topic));}}));
  return registry;
}
