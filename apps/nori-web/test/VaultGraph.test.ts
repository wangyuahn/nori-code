import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../src/api/client';
import { forceSameType, VaultGraph } from '../src/components/VaultGraph';
import { I18nProvider } from '../src/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

beforeEach(() => {
  localStorage.setItem('nori-ui-language', 'en');
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  Element.prototype.setPointerCapture = vi.fn();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => { root.unmount(); });
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('vault graph node interaction', () => {
  it('opens a note after a click within the movement threshold', async () => {
    const { node, onOpenNote } = await renderGraph();

    await pointerSequence(node, [100, 100], [103, 104]);

    expect(onOpenNote).toHaveBeenCalledOnce();
    expect(onOpenNote).toHaveBeenCalledWith(expect.objectContaining({ title: 'Linked note' }));
  });

  it('does not open a note when releasing after dragging the node', async () => {
    const { node, onOpenNote } = await renderGraph();

    await pointerSequence(node, [100, 100], [112, 100]);

    expect(onOpenNote).not.toHaveBeenCalled();
  });
});

describe('vault graph type clustering', () => {
  it('accelerates same-type nodes toward each other without affecting a different type', () => {
    const first = graphNode('First analysis', 'analysis', 0, 20);
    const second = graphNode('Second analysis', 'analysis', 100, 80);
    const different = graphNode('Decision', 'decision', 50, 50);
    const force = forceSameType();

    force.initialize([first, second, different]);
    force(1);

    expect(first.vx).toBeGreaterThan(0);
    expect(first.vy).toBeGreaterThan(0);
    expect(second.vx).toBeLessThan(0);
    expect(second.vy).toBeLessThan(0);
    expect(different.vx).toBe(0);
    expect(different.vy).toBe(0);
  });
});

async function renderGraph() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onOpenNote = vi.fn();
  const note: Note = {
    title: 'Linked note',
    type: 'analysis',
    folder: 'notes',
    preview: 'A linked note',
    date: '2026-07-15',
    path: 'notes/linked-note.md',
    links: ['Related note'],
  };
  const related: Note = {
    ...note,
    title: 'Related note',
    path: 'notes/related-note.md',
    links: ['Linked note'],
  };

  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(VaultGraph, {
      notes: [note, related],
      onOpenNote,
    })));
  });

  const node = container.querySelector<SVGGElement>('[role="button"][aria-label="Linked note"]');
  expect(node).not.toBeNull();
  return { node: node!, onOpenNote };
}

async function pointerSequence(
  node: SVGGElement,
  start: [number, number],
  end: [number, number],
) {
  await act(async () => {
    node.dispatchEvent(pointerEvent('pointerdown', ...start));
    node.dispatchEvent(pointerEvent('pointermove', ...end));
    node.dispatchEvent(pointerEvent('pointerup', ...end));
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: end[0], clientY: end[1] }));
  });
}

function pointerEvent(type: string, clientX: number, clientY: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

function graphNode(title: string, type: Note['type'], x: number, y: number) {
  return {
    id: title,
    note: {
      title,
      type,
      folder: 'notes',
      preview: '',
      date: '2026-07-15',
      path: `notes/${title}.md`,
      links: [],
    },
    x,
    y,
    vx: 0,
    vy: 0,
  };
}
