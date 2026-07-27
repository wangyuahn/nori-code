import { z } from 'zod';

import {
  mcpElicitationRequestSchema,
  mcpElicitationResponseSchema,
} from '../mcp-elicitation';
import { isoDateTimeSchema } from '../time';

export const listPendingMcpElicitationsQuerySchema = z.object({
  status: z.literal('pending'),
});

export const listPendingMcpElicitationsResponseSchema = z.object({
  items: z.array(mcpElicitationRequestSchema),
});
export type ListPendingMcpElicitationsResponse = z.infer<
  typeof listPendingMcpElicitationsResponseSchema
>;

export const mcpElicitationResolveRequestSchema = mcpElicitationResponseSchema;
export type McpElicitationResolveRequest = z.infer<
  typeof mcpElicitationResolveRequestSchema
>;

export const mcpElicitationResolveResultSchema = z.object({
  resolved: z.literal(true),
  status: z.enum(['resolved', 'awaiting_completion']),
  resolved_at: isoDateTimeSchema,
});
export type McpElicitationResolveResult = z.infer<
  typeof mcpElicitationResolveResultSchema
>;
