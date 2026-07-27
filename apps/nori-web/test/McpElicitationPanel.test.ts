import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type {
  McpElicitationRequest,
  McpElicitationResponse,
} from '../src/api/client';
import { McpElicitationPanel } from '../src/components/McpElicitationPanel';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('McpElicitationPanel', () => {
  it('validates required fields and submits typed form content', async () => {
    const onResolve = vi.fn();
    const { container, root } = await renderPanel(formRequest(), onResolve);
    try {
      await clickButton(container, 'Submit');
      expect(onResolve).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Complete all required fields.');

      const name = container.querySelector<HTMLInputElement>('input[type="text"]')!;
      await act(async () => setInputValue(name, 'Nori'));
      await clickButton(container, 'Submit');

      await vi.waitFor(() => {
        expect(onResolve).toHaveBeenCalledWith('elicitation-form', {
          action: 'accept',
          content: {
            name: 'Nori',
            retries: 3,
            confirmed: true,
          },
        });
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('opens a URL once and does not resolve it again while awaiting completion', async () => {
    const onResolve = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const initial = urlRequest('pending');
    const { container, root } = await renderPanel(initial, onResolve);
    try {
      await clickButton(container, 'Open and continue');
      expect(open).toHaveBeenCalledWith(
        'https://accounts.example.com/authorize',
        '_blank',
        'noopener,noreferrer',
      );
      await vi.waitFor(() => {
        expect(onResolve).toHaveBeenCalledWith('elicitation-url', { action: 'accept' });
      });

      await act(async () => {
        root.render(createElement(I18nProvider, null, createElement(McpElicitationPanel, {
          requests: [urlRequest('awaiting_completion')],
          onResolve,
        })));
      });
      await clickButton(container, 'Open again');

      expect(open).toHaveBeenCalledTimes(2);
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('Waiting for the MCP server to finish');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      open.mockRestore();
    }
  });
});

async function renderPanel(
  request: McpElicitationRequest,
  onResolve: (elicitationId: string, response: McpElicitationResponse) => void,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(McpElicitationPanel, {
      requests: [request],
      onResolve,
    })));
  });
  return { container, root };
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(label));
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function formRequest(): McpElicitationRequest {
  return {
    elicitation_id: 'elicitation-form',
    session_id: 'session-a',
    request_id: 'request-a',
    server_name: 'test-server',
    message: 'Configure the operation.',
    status: 'pending',
    created_at: '2026-07-24T00:00:00.000Z',
    mode: 'form',
    requested_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', title: 'Name' },
        retries: { type: 'integer', title: 'Retries', default: 3 },
        confirmed: { type: 'boolean', title: 'Confirmed', default: true },
      },
    },
  };
}

function urlRequest(status: 'pending' | 'awaiting_completion'): McpElicitationRequest {
  return {
    elicitation_id: 'elicitation-url',
    session_id: 'session-a',
    request_id: 'request-b',
    server_name: 'oauth-server',
    message: 'Authorize access.',
    status,
    created_at: '2026-07-24T00:00:00.000Z',
    mode: 'url',
    server_elicitation_id: 'server-elicitation',
    url: 'https://accounts.example.com/authorize',
  };
}
