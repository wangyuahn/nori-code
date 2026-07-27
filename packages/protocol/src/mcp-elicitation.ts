import { z } from 'zod';

import { isoDateTimeSchema } from './time';

const titledOptionSchema = z.object({
  const: z.string(),
  title: z.string(),
});

const booleanFieldSchema = z.object({
  type: z.literal('boolean'),
  title: z.string().optional(),
  description: z.string().optional(),
  default: z.boolean().optional(),
});

const stringFieldSchema = z.object({
  type: z.literal('string'),
  title: z.string().optional(),
  description: z.string().optional(),
  minLength: z.number().nonnegative().optional(),
  maxLength: z.number().nonnegative().optional(),
  format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
  default: z.string().optional(),
});

const numberFieldSchema = z.object({
  type: z.enum(['number', 'integer']),
  title: z.string().optional(),
  description: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  default: z.number().optional(),
});

const singleSelectFieldSchema = z.union([
  z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    oneOf: z.array(titledOptionSchema).min(1),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string()).min(1),
    enumNames: z.array(z.string()).optional(),
    default: z.string().optional(),
  }),
]);

const multiSelectFieldSchema = z.union([
  z.object({
    type: z.literal('array'),
    title: z.string().optional(),
    description: z.string().optional(),
    minItems: z.number().nonnegative().optional(),
    maxItems: z.number().nonnegative().optional(),
    items: z.object({ anyOf: z.array(titledOptionSchema).min(1) }),
    default: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('array'),
    title: z.string().optional(),
    description: z.string().optional(),
    minItems: z.number().nonnegative().optional(),
    maxItems: z.number().nonnegative().optional(),
    items: z.object({
      type: z.literal('string'),
      enum: z.array(z.string()).min(1),
    }),
    default: z.array(z.string()).optional(),
  }),
]);

export const mcpElicitationFieldSchema = z.union([
  singleSelectFieldSchema,
  multiSelectFieldSchema,
  booleanFieldSchema,
  stringFieldSchema,
  numberFieldSchema,
]);
export type McpElicitationField = z.infer<typeof mcpElicitationFieldSchema>;

export const mcpElicitationRequestedSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), mcpElicitationFieldSchema),
  required: z.array(z.string()).optional(),
});
export type McpElicitationRequestedSchema = z.infer<typeof mcpElicitationRequestedSchema>;

const requestBaseSchema = z.object({
  elicitation_id: z.string().min(1),
  session_id: z.string().min(1),
  request_id: z.string().min(1),
  server_name: z.string().min(1),
  message: z.string(),
  status: z.enum(['pending', 'awaiting_completion']),
  created_at: isoDateTimeSchema,
});

export const mcpElicitationFormRequestSchema = requestBaseSchema.extend({
  mode: z.literal('form'),
  requested_schema: mcpElicitationRequestedSchema,
});
export type McpElicitationFormRequest = z.infer<typeof mcpElicitationFormRequestSchema>;

export const mcpElicitationUrlRequestSchema = requestBaseSchema.extend({
  mode: z.literal('url'),
  server_elicitation_id: z.string().min(1),
  url: z.url(),
});
export type McpElicitationUrlRequest = z.infer<typeof mcpElicitationUrlRequestSchema>;

export const mcpElicitationRequestSchema = z.discriminatedUnion('mode', [
  mcpElicitationFormRequestSchema,
  mcpElicitationUrlRequestSchema,
]);
export type McpElicitationRequest = z.infer<typeof mcpElicitationRequestSchema>;

export const mcpElicitationValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
export type McpElicitationValue = z.infer<typeof mcpElicitationValueSchema>;

export const mcpElicitationResponseSchema = z.object({
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.record(z.string(), mcpElicitationValueSchema).optional(),
});
export type McpElicitationResponse = z.infer<typeof mcpElicitationResponseSchema>;
