/**
 * SSRF guards for user-supplied or catalog-supplied Shopify store domains.
 * Rejects localhost, private suffixes, raw IP literals, ports, credentials, and non-HTTPS URLs.
 */

export function isSafePublicHost(host: string): boolean {
  const clean = host.toLowerCase().trim().replace(/\.$/, '');
  if (!clean || !clean.includes('.') || clean.length > 253) return false;
  if (
    clean === 'localhost' ||
    clean.endsWith('.localhost') ||
    clean.endsWith('.local') ||
    clean.endsWith('.internal') ||
    clean.endsWith('.arpa') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(clean) ||
    /^(?:0x[0-9a-f]+|\d+)$/i.test(clean) ||
    clean.includes(':') ||
    !/^[a-z0-9.-]+$/.test(clean)
  ) {
    return false;
  }
  return true;
}

export function assertSafeHttpsUrl(raw: string): URL {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new Error('Endpoint must be a clean HTTPS URL without credentials or custom ports.');
  }
  if (!isSafePublicHost(parsed.hostname)) {
    throw new Error('Endpoint host is not a valid public store domain.');
  }
  return parsed;
}

export function normalizeHost(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}
