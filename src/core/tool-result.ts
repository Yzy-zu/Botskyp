import { z } from 'zod';

export const toolStatuses = ['ok', 'denied', 'needs_confirmation', 'needs_clarification', 'not_found', 'queued', 'uncertain', 'error'] as const;
export const toolStatusSchema = z.enum(toolStatuses);
export type ToolStatus = z.infer<typeof toolStatusSchema>;

/** R1 contract; the v1 ToolRegistry keeps its existing result until explicitly migrated. */
export function toolResultSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({
    status: toolStatusSchema,
    toolName: z.string().min(1),
    domain: z.string().min(1),
    code: z.string().min(1),
    data,
    presentation: z.string().optional(),
    artifactProduced: z.string().uuid().optional(),
    requiresLlmSynthesis: z.boolean().optional(),
  });
}
export type ToolResult<T = unknown> = {
  status: ToolStatus;
  toolName: string;
  domain: string;
  code: string;
  data: T;
  /** Backend-only local template; excluded from raw data projection. */
  presentation?: string;
  artifactProduced?: string;
  requiresLlmSynthesis?: boolean;
};
