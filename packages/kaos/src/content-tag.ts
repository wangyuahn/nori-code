import { createHash } from 'node:crypto';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;

export interface ContentTagHasher {
  update(chunk: string | Uint8Array): void;
  digest(): string;
}

/**
 * Hash UTF-8 text after stripping a leading BOM and normalizing every line
 * ending to LF. The short tag is an edit anchor, not a security primitive.
 */
export function createContentTagHasher(): ContentTagHasher {
  const hash = createHash('sha256');
  let prefix = Buffer.alloc(0);
  let started = false;
  let pendingCarriageReturn = false;
  let finished = false;

  function writeNormalized(bytes: Uint8Array): void {
    const normalized = Buffer.allocUnsafe(bytes.length + 1);
    let length = 0;

    for (const byte of bytes) {
      if (pendingCarriageReturn) {
        normalized[length] = LINE_FEED;
        length += 1;
        pendingCarriageReturn = false;
        if (byte === LINE_FEED) continue;
      }

      if (byte === CARRIAGE_RETURN) {
        pendingCarriageReturn = true;
      } else {
        normalized[length] = byte;
        length += 1;
      }
    }

    if (length > 0) hash.update(normalized.subarray(0, length));
  }

  return {
    update(chunk): void {
      if (finished) throw new Error('Content tag hasher is already finalized.');
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);

      if (!started) {
        const candidate = prefix.length === 0 ? bytes : Buffer.concat([prefix, bytes]);
        if (candidate.length < UTF8_BOM.length) {
          prefix = candidate;
          return;
        }
        started = true;
        prefix = Buffer.alloc(0);
        writeNormalized(
          candidate.subarray(candidate.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? 3 : 0),
        );
        return;
      }

      writeNormalized(bytes);
    },
    digest(): string {
      if (finished) throw new Error('Content tag hasher is already finalized.');
      finished = true;
      if (!started && prefix.length > 0) writeNormalized(prefix);
      if (pendingCarriageReturn) hash.update(Buffer.from([LINE_FEED]));
      return hash.digest('hex').slice(0, 4).toUpperCase();
    },
  };
}

export function computeContentTag(content: string | Uint8Array): string {
  const hasher = createContentTagHasher();
  hasher.update(content);
  return hasher.digest();
}
