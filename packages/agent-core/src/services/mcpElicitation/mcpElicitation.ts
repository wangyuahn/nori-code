import { createDecorator } from '../../di';
import type {
  McpElicitationComplete,
  McpElicitationRequest,
  McpElicitationResult,
} from '../../rpc';
import type {
  McpElicitationRequest as ProtocolMcpElicitationRequest,
  McpElicitationRequestedSchema,
  McpElicitationResponse as ProtocolMcpElicitationResponse,
} from '@nori-code/protocol';

export type SessionMcpElicitationRequest = McpElicitationRequest & {
  readonly sessionId: string;
  readonly agentId: string;
};

export type SessionMcpElicitationComplete = McpElicitationComplete & {
  readonly sessionId: string;
  readonly agentId: string;
};

export interface IMcpElicitationService {
  readonly _serviceBrand: undefined;

  request(
    request: SessionMcpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult>;

  complete(notification: SessionMcpElicitationComplete): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IMcpElicitationService =
  createDecorator<IMcpElicitationService>('mcpElicitationService');

export interface McpElicitationToBrokerRequestParams {
  readonly elicitationId: string;
  readonly createdAt: string;
}

export function toBrokerRequest(
  request: SessionMcpElicitationRequest,
  params: McpElicitationToBrokerRequestParams,
): ProtocolMcpElicitationRequest {
  const base = {
    elicitation_id: params.elicitationId,
    session_id: request.sessionId,
    request_id: request.requestId,
    server_name: request.serverName,
    message: request.message,
    status: 'pending' as const,
    created_at: params.createdAt,
  };
  if (request.mode === 'url') {
    return {
      ...base,
      mode: 'url',
      server_elicitation_id: request.serverElicitationId,
      url: request.url,
    };
  }
  return {
    ...base,
    mode: 'form',
    requested_schema: request.requestedSchema as McpElicitationRequestedSchema,
  };
}

export function toAgentCoreResponse(
  response: ProtocolMcpElicitationResponse,
): McpElicitationResult {
  return {
    action: response.action,
    content: response.content,
  };
}
