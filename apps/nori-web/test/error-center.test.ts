import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAppErrors,
  getAppErrors,
  reportAppError,
} from '../src/utils/error-center';
import { reportGlobalFailure } from '../src/hooks/useGlobalErrors';

describe('global error reporting', () => {
  beforeEach(() => {
    clearAppErrors();
  });

  it('surfaces a failed background turn with its provider details', () => {
    reportGlobalFailure({
      type: 'turn.ended',
      epoch: 'epoch-1',
      seq: 7,
      session_id: 'session-member',
      payload: {
        reason: 'failed',
        turnId: 3,
        agentId: 'agent-member',
        error: {
          code: 'provider.api_error',
          message: 'Provider returned error',
          details: { statusCode: 403, requestId: 'req-1' },
          retryable: true,
        },
      },
    });

    expect(getAppErrors()).toEqual([
      expect.objectContaining({
        source: 'agent',
        message: 'Provider returned error',
        code: 'provider.api_error',
        sessionId: 'session-member',
        agentId: 'agent-member',
        turnId: 3,
        eventId: 'epoch-1:session-member:7',
        details: { statusCode: 403, requestId: 'req-1' },
        count: 1,
      }),
    ]);
  });

  it('surfaces tool.result failures from payload.isError', () => {
    reportGlobalFailure({
      type: 'tool.result',
      epoch: 'epoch-1',
      seq: 8,
      session_id: 'session-member',
      payload: {
        turnId: 4,
        toolCallId: 'call-1',
        agentId: 'agent-member',
        name: 'TeamChat',
        output: 'delivery failed',
        isError: true,
      },
    });

    expect(getAppErrors()).toEqual([
      expect.objectContaining({
        source: 'tool',
        message: 'delivery failed',
        sessionId: 'session-member',
        agentId: 'agent-member',
        turnId: 4,
        toolCallId: 'call-1',
        operation: 'TeamChat',
        eventId: 'epoch-1:session-member:8',
        count: 1,
      }),
    ]);
  });

  it('does not increase the count when current and global sockets report one event', () => {
    const eventId = 'epoch-1:session-member:9';
    reportAppError({
      source: 'agent',
      eventId,
      message: 'Provider returned error',
      code: 'provider.api_error',
      sessionId: 'session-member',
      agentId: 'agent-member',
      turnId: 5,
      operation: 'turn',
    });
    reportGlobalFailure({
      type: 'error',
      epoch: 'epoch-1',
      seq: 9,
      session_id: 'session-member',
      payload: {
        code: 'provider.api_error',
        message: 'Provider returned error',
        agentId: 'agent-member',
        details: { turnId: 5 },
        retryable: true,
      },
    });

    expect(getAppErrors()).toHaveLength(1);
    expect(getAppErrors()[0]).toMatchObject({
      eventId,
      count: 1,
    });
  });

  it('merges turn.ended and trailing error events for one failed turn', () => {
    reportAppError({
      source: 'agent',
      eventId: 'epoch-1:session-member:10',
      message: 'Provider returned error',
      code: 'provider.api_error',
      sessionId: 'session-member',
      agentId: 'agent-member',
      turnId: 6,
      operation: 'turn',
    });
    reportGlobalFailure({
      type: 'error',
      epoch: 'epoch-1',
      seq: 11,
      session_id: 'session-member',
      payload: {
        code: 'provider.api_error',
        message: 'Provider returned error',
        agentId: 'agent-member',
        details: { turnId: 6 },
        retryable: true,
      },
    });

    expect(getAppErrors()).toHaveLength(1);
    expect(getAppErrors()[0]).toMatchObject({
      count: 2,
      eventId: 'epoch-1:session-member:10',
    });
  });
});
