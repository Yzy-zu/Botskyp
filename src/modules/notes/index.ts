import { z } from 'zod';
import { defineTool,ok,fail,type Tool,type ToolCtx } from '../../core/tools.js';
import { permitted } from '../../core/permissions.js';
import { product } from '../../../config/product.js';
const body=z.string().trim().min(1).max(product.maxTextChars);
const id=z.string().regex(/^\d+$/);
const base={module:'notes',permission:'chat.use',scope:'both',modelCallable:true} as const;
async function editable(ctx:ToolCtx,noteId:string):Promise<boolean>{
  const row=await ctx.c.query<{author_id:string}>('SELECT author_id FROM notes WHERE id=$1 AND chat_id=$2 AND deleted_at IS NULL',[noteId,ctx.chat.id]);
  return Boolean(row.rows[0] && (row.rows[0].author_id===ctx.actor.id || (ctx.chat.isGroup && permitted(ctx.actor,ctx.chat,'notes.manage_shared'))));
}
export const noteTools:Tool[]=[
  defineTool({...base,name:'notes.create',description:'Guardar una nota en este chat.',examples:['bot nota guarda la reunión será el viernes'],risk:'write',args:z.strictObject({body}),
    async run(ctx,args){const r=await ctx.c.query<{id:string}>('INSERT INTO notes(chat_id,author_id,body) VALUES($1,$2,$3) RETURNING id',[ctx.chat.id,ctx.actor.id,args.body]);
      return ok(`Guardé la nota #${r.rows[0]!.id}. Quedó visible en este chat.`,{id:r.rows[0]!.id});}}),
  defineTool({...base,name:'notes.list',description:'Consultar o buscar notas del chat (búsqueda en español).',examples:['bot notas','bot notas busca reunión'],risk:'read',args:z.strictObject({query:z.string().max(product.maxTextChars).optional()}),
    async run(ctx,args){const r=await ctx.c.query<{id:string;body:string;author_id:string;created_at:Date}>(`SELECT id,body,author_id,created_at FROM notes WHERE chat_id=$1 AND deleted_at IS NULL
      AND ($2='' OR search @@ plainto_tsquery('spanish',$2)) AND ($3 OR author_id=$4) ORDER BY id DESC LIMIT $5`,[ctx.chat.id,args.query ?? '',ctx.chat.isGroup,ctx.actor.id,product.noteResults]);
      return ok(r.rows.map(n=>`#${n.id}: ${n.body}\nAutor: ${n.author_id} · ${n.created_at.toISOString()}`).join('\n') || 'No hay notas.',{notes:r.rows});}}),
  defineTool({...base,name:'notes.edit',description:'Editar una nota propia; administradores pueden editar notas del grupo.',examples:['bot nota edita 18 nuevo texto'],risk:'write',args:z.strictObject({id,body}),
    async run(ctx,args){if(!await editable(ctx,args.id))return fail('No.');await ctx.c.query('UPDATE notes SET body=$2,updated_at=now() WHERE id=$1',[args.id,args.body]);return ok(`Actualicé la nota #${args.id}.`);}}),
  defineTool({...base,name:'notes.delete',description:'Eliminar una nota con confirmación.',examples:['bot nota borra 18'],risk:'destructive',args:z.strictObject({id}),
    async run(ctx,args){if(!await editable(ctx,args.id))return fail('No.');await ctx.c.query('UPDATE notes SET deleted_at=now() WHERE id=$1',[args.id]);return ok(`Eliminé la nota #${args.id}.`);}}),
];
