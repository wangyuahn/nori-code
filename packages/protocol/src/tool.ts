import { z } from 'zod';

export const toolSourceSchema = z.enum(['builtin', 'skill', 'mcp']);
export type ToolSource = z.infer<typeof toolSourceSchema>;

export const toolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.unknown(),
  source: toolSourceSchema,
  mcp_server_id: z.string().min(1).optional(),
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

export const mcpServerStatusSchema = z.enum([
  'connected',
  'connecting',
  'disconnected',
  'error',
]);
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpServerTransport = z.infer<typeof mcpServerTransportSchema>;

const mcpServerCommonConfigShape = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
  toolTimeoutMs: z.number().int().positive().optional(),
  enabledTools: z.array(z.string().min(1)).optional(),
  disabledTools: z.array(z.string().min(1)).optional(),
} as const;

export const mcpServerStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  ...mcpServerCommonConfigShape,
});

export const mcpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...mcpServerCommonConfigShape,
});

export const mcpServerSseConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...mcpServerCommonConfigShape,
});

export const mcpServerConfigSchema = z.discriminatedUnion('transport', [
  mcpServerStdioConfigSchema,
  mcpServerHttpConfigSchema,
  mcpServerSseConfigSchema,
]);
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: mcpServerTransportSchema,
  status: mcpServerStatusSchema,
  last_error: z.string().optional(),
  tool_count: z.number().int().nonnegative(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;
