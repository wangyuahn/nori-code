import type {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserExecutionScope,
  BrowserProvider,
} from '@nori-code/agent-core';
import { createDecorator } from '@nori-code/agent-core';

export interface BrowserBridgeAction {
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly createdAt: string;
  readonly request: BrowserActionRequest;
}

export interface IBrowserAutomationService extends BrowserProvider {
  readonly _serviceBrand: undefined;
  registerClient(clientId: string): void;
  heartbeat(clientId: string, paused?: boolean): void;
  unregisterClient(clientId: string): void;
  nextAction(clientId: string, waitMs: number): Promise<BrowserBridgeAction | null>;
  resolveAction(clientId: string, actionId: string, result: BrowserActionResult): boolean;
  setPaused(clientId: string, paused: boolean): void;
  getState(): { readonly connected: boolean; readonly paused: boolean; readonly pending: number };
  dispose(): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IBrowserAutomationService = createDecorator<IBrowserAutomationService>('browserAutomationService');

export interface PendingBrowserAction extends BrowserBridgeAction {
  readonly scope: BrowserExecutionScope;
}
