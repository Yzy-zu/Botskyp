import {it,expect,vi} from 'vitest';
import {qualifyModel} from '../scripts/llm-qualify.js';
import {createRegistry} from '../src/core/registry.js';
import {createToolRegistryV2,fullCatalogDeclarations} from '../src/core/tool-registry-v2.js';
import type {LlmProviderAdapter} from '../src/core/llm/provider-adapter.js';
const tools=fullCatalogDeclarations(createToolRegistryV2(createRegistry()));
it.each([true,false])('qualification accepts only valid current-catalog calls (valid=%s)',async valid=>{
  const generate=vi.fn<LlmProviderAdapter['generate']>();
  const content={role:'model',parts:[{functionCall:{name:valid?'minecraft_status':'unknown_function',args:{}}}]};
  generate.mockResolvedValueOnce({text:'hola',calls:[],content:{}})
    .mockResolvedValueOnce({text:'',calls:[{name:valid?'minecraft_status':'unknown_function',args:{}}],content})
    .mockResolvedValueOnce({text:'',calls:[{name:valid?'video_search':'notes_create',args:valid?{query:'minecraft',source:'dailymotion'}:{body:'minecraft'}}],content:{}});
  if(valid)generate.mockResolvedValueOnce({text:'El servidor está en línea.',calls:[],content:{}});
  const adapter={id:'gemini',generate} as unknown as LlmProviderAdapter;
  const result=await qualifyModel(adapter,'fixture','fixture-key',tools,true);
  expect(result.agentCompatible).toBe(valid);expect(result.fullCatalogCompatible).toBe(valid);
  for(const [request] of generate.mock.calls.slice(1))expect(request.tools).toEqual(tools);
});
