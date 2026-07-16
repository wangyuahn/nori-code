export const BROWSER_REFERENCE_EVENT = 'nori:browser-reference';

export function dispatchBrowserReference(input: {
  readonly id: string;
  readonly ref: string;
  readonly text: string;
  readonly tag: string;
  readonly url: string;
  readonly note?: string;
}): void {
  const text = `[Browser annotation ${input.id}]\nURL: ${input.url}\nElement: ref=${input.ref} <${input.tag}>\nContent: ${input.text}${input.note ? `\nUser note: ${input.note}` : ''}`;
  window.dispatchEvent(new CustomEvent(BROWSER_REFERENCE_EVENT, { detail: { text } }));
}
