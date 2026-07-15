export const OFFICIAL_KIMI_CODING_INPUT_CAPABILITIES = ['image_in', 'video_in'] as const;

export function isOfficialKimiCodingEndpoint(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'api.kimi.com') return false;
    const pathname = url.pathname.replace(/\/+$/, '');
    return pathname === '/coding' || pathname === '/coding/v1';
  } catch {
    return false;
  }
}
