import { normalizeHost } from './security.js';
import type {
  CatalogProduct,
  CatalogSearchOptions,
  CatalogSearchResult,
  UcpClientConfig,
} from './types.js';

export const DEFAULT_CATALOG_ENDPOINT = 'https://catalog.shopify.com/api/ucp/mcp';
export const DEFAULT_UCP_PROFILE =
  'https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [350, 900];
const TIMEOUT_MS = 10_000;

type RawPrice = { amount?: unknown; currency?: unknown };
type RawMedia = { type?: unknown; url?: unknown };
type RawSeller = { id?: unknown; name?: unknown; url?: unknown; domain?: unknown };
type RawVariant = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  checkout_url?: unknown;
  price?: RawPrice;
  list_price?: RawPrice;
  availability?: { available?: unknown };
  media?: RawMedia[];
  seller?: RawSeller;
  eligible?: { native_checkout?: unknown };
};
type RawProduct = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  price?: RawPrice;
  list_price?: RawPrice;
  media?: RawMedia[];
  variants?: RawVariant[];
  seller?: RawSeller;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function minorAmount(raw: RawPrice | undefined): number | null {
  return typeof raw?.amount === 'number' && Number.isInteger(raw.amount) && raw.amount >= 0
    ? raw.amount
    : null;
}

export function formatMoney(minor: number | null, currency = 'USD'): string {
  if (minor == null || !Number.isFinite(minor)) return '';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(minor / 100);
  } catch {
    return `$${(minor / 100).toFixed(2)}`;
  }
}

export function computeSavings(
  priceAmountMinor: number | null,
  originalPriceMinor: number | null,
): { savingsMinor: number; savingsPercent: number } {
  if (
    priceAmountMinor == null ||
    originalPriceMinor == null ||
    originalPriceMinor <= priceAmountMinor ||
    originalPriceMinor <= 0
  ) {
    return { savingsMinor: 0, savingsPercent: 0 };
  }
  const savingsMinor = originalPriceMinor - priceAmountMinor;
  const savingsPercent = Math.round((savingsMinor / originalPriceMinor) * 100);
  return { savingsMinor, savingsPercent };
}

function firstHttpsImage(...lists: Array<RawMedia[] | undefined>): string {
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.type !== 'image') continue;
      const url = str(item.url);
      if (url.startsWith('https://')) return url;
    }
  }
  return '';
}

function normalizeProduct(raw: RawProduct): CatalogProduct | null {
  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  const available = variants.filter((v) => v?.availability?.available !== false && str(v?.id));
  const discountedVariant = available.find((v) => {
    const p = minorAmount(v.price);
    const lp = minorAmount(v.list_price);
    return p != null && lp != null && lp > p;
  });
  const chosen = discountedVariant ?? available[0] ?? variants[0] ?? null;

  const title = str(raw.title) || str(chosen?.title);
  if (!title) return null;

  const url = str(chosen?.url) || str(raw.url);
  if (!url.startsWith('https://') && !url.startsWith('http://')) return null;

  const imageUrl = firstHttpsImage(chosen?.media, raw.media);
  const price = chosen?.price ?? raw.price;
  const priceAmountMinor = minorAmount(price);
  const priceCurrency = (str(price?.currency) || 'USD').toUpperCase();

  const rawOriginalMinor = minorAmount(chosen?.list_price ?? raw.list_price);
  const originalPriceMinor =
    rawOriginalMinor != null && priceAmountMinor != null && rawOriginalMinor > priceAmountMinor
      ? rawOriginalMinor
      : null;
  const { savingsMinor, savingsPercent } = computeSavings(priceAmountMinor, originalPriceMinor);

  const seller = chosen?.seller ?? raw.seller;
  const shopId = str(seller?.id);
  const shopUcpDomain = str(seller?.domain).toLowerCase();
  const sellerUrl = str(seller?.url) || url;
  const merchantDomain = normalizeHost(sellerUrl);
  const merchantName = str(seller?.name) || merchantDomain;
  const providerProductId = str(raw.id);
  const providerVariantId = str(chosen?.id);
  const key = providerVariantId || providerProductId || url;

  return {
    key,
    title,
    url,
    imageUrl,
    priceAmountMinor,
    originalPriceMinor,
    savingsMinor,
    savingsPercent,
    savingsSource: savingsMinor > 0 ? 'list_price' : null,
    priceCurrency,
    priceLabel: formatMoney(priceAmountMinor, priceCurrency),
    originalPriceLabel: formatMoney(originalPriceMinor, priceCurrency),
    merchantName,
    merchantDomain,
    shopUcpDomain,
    ...(shopId ? { shopId } : {}),
    providerProductId,
    providerVariantId,
    checkoutUrl: str(chosen?.checkout_url),
    nativeCheckout: chosen?.eligible?.native_checkout === true,
  };
}

/**
 * Matches a shop GID strictly by exact domain first so stores with identical
 * display names never hijack a store-scoped search.
 */
export function matchProductShopGid(
  products: CatalogProduct[],
  params: { shopDomain?: string | null; merchantDomain?: string | null; shopName?: string | null },
): string | null {
  const targetDomains = new Set(
    [params.shopDomain, params.merchantDomain]
      .filter((v): v is string => Boolean(v && v.trim()))
      .map(normalizeHost)
      .filter(Boolean),
  );

  if (targetDomains.size > 0) {
    const domainHit = products.find((p) => {
      if (!p.shopId) return false;
      const ucp = normalizeHost(p.shopUcpDomain || '');
      const dom = normalizeHost(p.merchantDomain || '');
      return (ucp && targetDomains.has(ucp)) || (dom && targetDomains.has(dom));
    });
    return domainHit?.shopId ?? null;
  }

  const targetName = (params.shopName || '').trim().toLowerCase();
  if (!targetName) return null;
  const nameHit = products.find(
    (p) => Boolean(p.shopId) && p.merchantName.trim().toLowerCase() === targetName,
  );
  return nameHit?.shopId ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res;
      lastStatus = res.status;
      if (!RETRYABLE_STATUSES.has(res.status) || attempt === RETRY_DELAYS_MS.length) {
        return res;
      }
    } catch (err) {
      if (attempt === RETRY_DELAYS_MS.length) throw err;
    }
  }
  throw new Error(`Shopify catalog failed with status ${lastStatus}`);
}

export async function searchGlobalCatalog(
  config: UcpClientConfig,
  options: CatalogSearchOptions,
): Promise<CatalogSearchResult> {
  const started = Date.now();
  const fetcher = config.fetcher ?? fetch;
  const endpoint = config.catalogEndpoint || DEFAULT_CATALOG_ENDPOINT;
  const profile = config.ucpProfile || DEFAULT_UCP_PROFILE;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 40);

  let resolvedShopId: string | null =
    options.shopId && options.shopId.startsWith('gid://shopify/Shop/')
      ? options.shopId.trim()
      : null;

  if (!resolvedShopId && (options.shopDomain || options.merchantDomain || options.shopName)) {
    const probeQuery = (options.shopName || options.merchantDomain || options.shopDomain || '').trim();
    if (probeQuery) {
      const probeRes = await searchGlobalCatalog(config, {
        query: probeQuery,
        limit: 24,
        shipsToCountry: options.shipsToCountry,
      });
      resolvedShopId = matchProductShopGid(probeRes.products, {
        shopDomain: options.shopDomain,
        merchantDomain: options.merchantDomain,
        shopName: options.shopName,
      });
    }
  }

  const shipsTo: Record<string, string> = {
    country: (options.shipsToCountry || 'US').toUpperCase(),
  };
  if (options.shipsToRegion?.trim()) shipsTo.region = options.shipsToRegion.trim();
  if (options.shipsToPostalCode?.trim()) shipsTo.postal_code = options.shipsToPostalCode.trim();

  const context: Record<string, string> = {
    address_country: shipsTo.country,
  };
  if (shipsTo.region) context.address_region = shipsTo.region;
  if (shipsTo.postal_code) context.postal_code = shipsTo.postal_code;

  const filters: Record<string, unknown> = {
    available: true,
    ships_to: shipsTo,
  };
  if (resolvedShopId) filters.shops = [resolvedShopId];

  const priceFilter: Record<string, number> = {};
  if (options.minPriceUsd != null && options.minPriceUsd > 0) {
    priceFilter.min = Math.round(options.minPriceUsd * 100);
  }
  if (options.maxPriceUsd != null && options.maxPriceUsd > 0) {
    priceFilter.max = Math.round(options.maxPriceUsd * 100);
  }
  if (Object.keys(priceFilter).length > 0) {
    filters.price = priceFilter;
  }

  const pagination: Record<string, unknown> = { limit };
  if (options.cursor?.trim()) pagination.cursor = options.cursor.trim();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (config.catalogToken) {
    headers.Authorization = `Bearer ${config.catalogToken}`;
  }

  const res = await fetchWithRetry(
    endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: {
          name: 'search_catalog',
          arguments: {
            meta: { 'ucp-agent': { profile } },
            catalog: {
              query: options.query.trim(),
              context,
              filters,
              pagination,
            },
          },
        },
      }),
    },
    fetcher,
  );

  if (!res.ok) {
    throw new Error(`Shopify Global Catalog returned HTTP ${res.status}.`);
  }

  type RawPagination = { has_next_page?: boolean; total_count?: number; cursor?: string };
  const payload = (await res.json()) as {
    error?: { message?: string };
    result?: {
      isError?: boolean;
      structuredContent?: { products?: RawProduct[]; pagination?: RawPagination };
      content?: Array<{ type?: string; text?: string }>;
    };
  };

  if (payload.error || payload.result?.isError) {
    throw new Error(payload.error?.message || 'Shopify catalog search failed.');
  }

  let rawProducts = payload.result?.structuredContent?.products;
  let rawPagination = payload.result?.structuredContent?.pagination;
  if (!Array.isArray(rawProducts)) {
    const txt = payload.result?.content?.[0]?.text;
    if (txt) {
      const parsed = JSON.parse(txt) as { products?: RawProduct[]; pagination?: RawPagination };
      rawProducts = parsed.products;
      rawPagination = parsed.pagination;
    }
  }

  const products = (Array.isArray(rawProducts) ? rawProducts : [])
    .map(normalizeProduct)
    .filter((p): p is CatalogProduct => p !== null);

  return {
    products,
    nextCursor: typeof rawPagination?.cursor === 'string' ? rawPagination.cursor : null,
    hasNextPage: Boolean(rawPagination?.has_next_page),
    totalCount: typeof rawPagination?.total_count === 'number' ? rawPagination.total_count : null,
    durationMs: Date.now() - started,
    resolvedShopId,
  };
}
