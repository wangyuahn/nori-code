/**
 * `request_id` resolution at the server's REST boundary.
 *
 * Delegates to `parseOrGenerateRequestId` from `@nori-code/protocol`, which:
 *   - returns a bare 26-char ULID (no `req_` prefix);
 *   - validates client-supplied `X-Request-Id` is a real ULID and regenerates
 *     a fresh one on malformed input so operator logs do not carry
 *     attacker-controlled strings verbatim.
 */

import { parseOrGenerateRequestId } from '@nori-code/protocol';

const REQUEST_ID_HEADER = 'x-request-id';

export function resolveRequestId(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw = headers[REQUEST_ID_HEADER];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  return parseOrGenerateRequestId(supplied);
}
