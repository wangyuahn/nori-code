import { z } from 'zod';

export const lspPositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
export type LspPosition = z.infer<typeof lspPositionSchema>;

export const lspOperationSchema = z.enum([
  'diagnostics',
  'hover',
  'definition',
  'references',
  'document_symbols',
  'workspace_symbols',
  'rename',
  'format',
]);
export type LspOperation = z.infer<typeof lspOperationSchema>;

export const lspRequestSchema = z.object({
  operation: lspOperationSchema,
  path: z.string().min(1),
  position: lspPositionSchema.optional(),
  query: z.string().optional(),
  new_name: z.string().min(1).optional(),
});
export type LspRequest = z.infer<typeof lspRequestSchema>;

export const lspStatusSchema = z.object({
  available: z.boolean(),
  running: z.boolean(),
  server_id: z.string(),
  language_id: z.string(),
  capabilities: z.array(lspOperationSchema),
  reason: z.string().optional(),
});
export type LspStatus = z.infer<typeof lspStatusSchema>;

export const lspResultSchema = z.object({
  server_id: z.string(),
  language_id: z.string(),
  operation: lspOperationSchema,
  result: z.unknown(),
});
export type LspResult = z.infer<typeof lspResultSchema>;
