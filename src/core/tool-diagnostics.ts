import type { ToolMetadataV2 } from './tool-registry-v2.js';
import type { Config } from '../config.js';
import type { Actor, Chat } from './permissions.js';
import { permitted, moduleEnabled } from './permissions.js';
import { adapterAvailable } from './policy-v2/arguments.js';

export interface ToolDiagnosticsSummary {
  publicToolsTotal: number;
  exposed: number;
  rolePermitted: number;
  moduleEnabled: number;
  configured: number;
  staticEligible: number;
  currentlyExecutable: null;
  preconditionDependent: string[];
  temporarilyGated: number;
  disabledByModule: Record<string, string[]>;
  missingConfig: Record<string, string[]>;
  permissionConstrained: {
    ownerOnly: string[];
    adminOnly: string[];
    otherConstrained: string[];
  };
}

/**
 * Diagnostic analysis enumerating public tools, availability, module states,
 * configuration requirements, and permission boundaries.
 * Strictly guarantees no secrets, API keys, or credentials are exposed.
 */
export function diagnoseTools(
  catalog: readonly ToolMetadataV2[],
  config: Config,
  rawChat: { id: string; isGroup: boolean; enabled: boolean; settings?: { modules?: Record<string, boolean> } },
  actor: Actor,
): ToolDiagnosticsSummary {
  const chat: Chat = {
    id: rawChat.id,
    isGroup: rawChat.isGroup,
    enabled: rawChat.enabled,
    settings: rawChat.settings ?? {},
  };
  const publicTools = catalog.filter(t => t.exposure !== 'internal');

  let staticEligible = 0;
  let rolePermitted = 0;
  let enabled = 0;
  let configured = 0;
  let temporarilyGated = 0;
  const disabledByModule: Record<string, string[]> = {};
  const missingConfig: Record<string, string[]> = {};
  const ownerOnly: string[] = [];
  const adminOnly: string[] = [];
  const otherConstrained: string[] = [];

  for (const tool of publicTools) {
    if (tool.permission === 'config.global') {
      ownerOnly.push(tool.name);
    } else if (tool.permission === 'chat.configure' || tool.permission === 'polls.manage' || tool.permission === 'school.manage') {
      adminOnly.push(tool.name);
    } else if (tool.permission !== 'chat.use') {
      otherConstrained.push(tool.name);
    }

    if (tool.requiredModule === 'minecraft' && !config.MINECRAFT_ENABLED) {
      const list = missingConfig.minecraft ?? (missingConfig.minecraft = []);
      list.push(tool.name);
    }
    if (tool.requiredModule === 'drive' && !config.DRIVE_ENABLED) {
      const list = missingConfig.drive ?? (missingConfig.drive = []);
      list.push(tool.name);
    }

    if (!moduleEnabled(chat, tool.requiredModule, config)) {
      const list = disabledByModule[tool.requiredModule] ?? (disabledByModule[tool.requiredModule] = []);
      list.push(tool.name);
    }

    if (tool.hiddenReason && tool.exposure !== 'internal') {
      temporarilyGated++;
    }

    const isModuleOn = moduleEnabled(chat, tool.requiredModule, config)
      && (tool.requiredModule !== 'minecraft' || config.MINECRAFT_ENABLED)
      && (tool.requiredModule !== 'drive' || config.DRIVE_ENABLED);
    const isScopeOk = tool.scope === 'both' || (tool.scope === 'group') === chat.isGroup;
    const isPermitted = permitted(actor, chat, tool.permission);
    const isAdapterOk = adapterAvailable(tool.name);

    if (isPermitted && isScopeOk) rolePermitted++;
    if (moduleEnabled(chat, tool.requiredModule, config)) enabled++;
    if ((tool.requiredModule !== 'minecraft' || config.MINECRAFT_ENABLED)
      && (tool.requiredModule !== 'drive' || config.DRIVE_ENABLED)) configured++;
    if (chat.enabled && isModuleOn && isScopeOk && isPermitted && isAdapterOk
      && !(tool.name === 'memory.list' && chat.isGroup)
      && !(tool.name.startsWith('drive.') && (chat.settings as Record<string,unknown>).drive !== true)) staticEligible++;
  }

  return {
    publicToolsTotal: publicTools.length,
    exposed: publicTools.filter(t => t.llmVisible).length,
    rolePermitted,
    moduleEnabled: enabled,
    configured,
    staticEligible,
    // Only Policy with concrete arguments and live DB state can establish executability.
    currentlyExecutable: null,
    preconditionDependent: publicTools.map(t => t.name),
    temporarilyGated,
    disabledByModule,
    missingConfig,
    permissionConstrained: {
      ownerOnly,
      adminOnly,
      otherConstrained,
    },
  };
}
