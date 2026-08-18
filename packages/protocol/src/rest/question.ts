/**
 *   GET    /v1/sessions/{sid}/questions?status=pending
 *     Reply: { items: QuestionRequest[] }
 *
 *   POST   /v1/sessions/{sid}/questions/{qid}             (resolve)
 *     Body:  QuestionResponse (answers map + method? + note?)
 *     Reply: QuestionResolveResult { resolved: true, resolved_at }
 *     Errors: 40001 / 40404 / 40902 / 41002
 *
 *   POST   /v1/sessions/{sid}/questions/{qid}:dismiss     (dismiss)
 *     Body:  empty
 *     Reply: envelope code: 40909 + data { dismissed: true, dismissed_at }
 */

import { z } from 'zod';

import { questionRequestSchema, questionResponseSchema } from '../question';
import { isoDateTimeSchema } from '../time';

export const listPendingQuestionsQuerySchema = z.object({
  status: z.literal('pending'),
  agent_id: z.string().min(1).optional(),
});
export type ListPendingQuestionsQuery = z.infer<typeof listPendingQuestionsQuerySchema>;

export const listPendingQuestionsResponseSchema = z.object({
  items: z.array(questionRequestSchema),
});
export type ListPendingQuestionsResponse = z.infer<typeof listPendingQuestionsResponseSchema>;

export const questionResolveRequestSchema = questionResponseSchema.extend({
  agent_id: z.string().min(1).optional(),
});

export const questionDismissRequestSchema = z.preprocess(
  (value) => value === undefined ? {} : value,
  z.object({ agent_id: z.string().min(1).optional() }),
);
export type QuestionDismissRequest = z.infer<typeof questionDismissRequestSchema>;
export type QuestionResolveRequest = z.infer<typeof questionResolveRequestSchema>;

export const questionResolveResultSchema = z.object({
  resolved: z.literal(true),
  resolved_at: isoDateTimeSchema,
});
export type QuestionResolveResult = z.infer<typeof questionResolveResultSchema>;

export const questionAlreadyResolvedDataSchema = z.object({
  resolved: z.literal(false),
});
export type QuestionAlreadyResolvedData = z.infer<typeof questionAlreadyResolvedDataSchema>;

export const questionDismissResultSchema = z.object({
  dismissed: z.literal(true),
  dismissed_at: isoDateTimeSchema,
});
export type QuestionDismissResult = z.infer<typeof questionDismissResultSchema>;
