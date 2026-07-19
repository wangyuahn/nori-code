export type BrowserImageMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/bmp'
  | 'image/tiff'
  | 'image/x-icon'
  | 'image/heic'
  | 'image/heif'
  | 'image/avif'
  | 'image/svg+xml';

const EXTENSION_MIME: Readonly<Record<string, BrowserImageMime>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

const FTYP_IMAGE_MIME: Readonly<Record<string, BrowserImageMime>> = {
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  heix: 'image/heif',
  hevc: 'image/heic',
  mif1: 'image/heif',
  msf1: 'image/heif',
};

function declaredMime(value: string): string {
  const normalized = value.trim().toLowerCase().split(';', 1)[0] ?? '';
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function extensionMime(name: string): BrowserImageMime | undefined {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : EXTENSION_MIME[name.slice(dot).toLowerCase()];
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function ftypImageMime(bytes: Uint8Array): BrowserImageMime | null {
  if (bytes.length < 12 || !hasPrefix(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70])) {
    return null;
  }
  const brand = String.fromCodePoint(bytes[8], bytes[9], bytes[10], bytes[11])
    .toLowerCase()
    .trim();
  return FTYP_IMAGE_MIME[brand] ?? null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  return /^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text);
}

function sniffImageMime(bytes: Uint8Array): BrowserImageMime | null {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif';
  }
  if (
    hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    hasPrefix(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp';
  }
  if (hasPrefix(bytes, [0x42, 0x4d])) return 'image/bmp';
  if (
    hasPrefix(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    hasPrefix(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return 'image/tiff';
  }
  if (hasPrefix(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  return ftypImageMime(bytes);
}

/** Return a supported image MIME only when the payload bytes confirm it. */
export function detectImageMime(bytes: Uint8Array, declared: string): BrowserImageMime | null {
  const detected = sniffImageMime(bytes);
  if (detected !== null) return detected;
  return declaredMime(declared) === 'image/svg+xml' && looksLikeSvg(bytes)
    ? 'image/svg+xml'
    : null;
}

export function isLikelyImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  const type = declaredMime(file.type);
  return type.startsWith('image/') || extensionMime(file.name) !== undefined;
}
