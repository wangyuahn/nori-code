import { describe, expect, it } from 'vitest';

import { detectImageMime, isLikelyImageFile } from '../src/utils/image-mime';

describe('image MIME detection', () => {
  it('uses PNG magic bytes over a text/plain browser declaration', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectImageMime(bytes, 'text/plain; charset=utf-8')).toBe('image/png');
  });

  it('recognizes image candidates from an extension when the browser type is wrong', () => {
    expect(isLikelyImageFile({ name: 'screenshot.png', type: 'text/plain; charset=utf-8' })).toBe(true);
    expect(isLikelyImageFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });

  it('rejects an unknown payload instead of inventing an image MIME', () => {
    expect(detectImageMime(new Uint8Array([1, 2, 3]), 'text/plain')).toBeNull();
    expect(detectImageMime(new TextEncoder().encode('not a png'), 'image/png')).toBeNull();
  });

  it('recognizes AVIF and HEIF-family ftyp brands', () => {
    const avif = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x61, 0x76, 0x69, 0x66,
    ]);
    expect(detectImageMime(avif, '')).toBe('image/avif');
  });

  it('accepts SVG only when the payload contains an SVG document', () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    expect(detectImageMime(svg, 'image/svg+xml')).toBe('image/svg+xml');
    expect(detectImageMime(new TextEncoder().encode('<html></html>'), 'image/svg+xml')).toBeNull();
  });
});
