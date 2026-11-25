import { DEFAULT_UCP_PROFILE } from './catalog.js';
import { assertSafeHttpsUrl, isSafePublicHost } from './security.js';
import type {
  ShippingAddress,
  ShippingCheckResult,
  UcpCheckoutLine,
  UcpCheckoutMessage,
  UcpCheckoutSnapshot,
  UcpCheckoutStatus,
  UcpClientConfig,
  UcpLineInput,
} from './types.js';

const TIMEOUT_MS = 12_000;

const VALID_STATUSES: ReadonlySet<string> = new Set<UcpCheckoutStatus>([
  'incomplete',
  'requires_escalation',
  'ready_for_complete',
  'complete_in_progress',
  'completed',
  'canceled',
  'error',
]);

const UNSHIPPABLE_CODES = new Set([
  'delivery_no_delivery_available_for_merchandise_line',
  'delivery_no_delivery_available',
  'shipping_not_available',
  'fulfillment_unavailable',
]);

const NOISE_MESSAGE_CODES = new Set([
  'extension_interaction_required',
  'buyer_identity_contact_method_required',
  'delivery_address_required',
  'delivery_address1_required',
  'delivery_first_name_required',
  'delivery_last_name_required',
  'delivery_city_required',
  'delivery_zone_required',
  'shipping_address_required',
  'fulfillment_address_required',
]);

export function isUnshippableMessage(msg: { code?: string; content: string }): boolean {
  if (msg.code && UNSHIPPABLE_CODES.has(msg.code)) return true;
  const lower = (msg.content || '').toLowerCase();
  return (
    lower.includes("can't be shipped") ||
    lower.includes('can\u2019t be shipped') ||
    lower.includes('cannot be shipped') ||
    lower.includes('does not ship to') ||
    lower.includes('shipping is not available')
  );
}

/**
 * Safely resolves a Shopify merchant's Storefront UCP MCP endpoint.
 * Fast-paths verified *.myshopify.com domains to /api/ucp/mcp and resolves
 * custom domains through /.well-known/ucp without following redirects.
 */
export async function resolveStoreUcpEndpoint(
  shopUcpDomain: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const cleanHost = shopUcpDomain
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase();

  if (!isSafePublicHost(cleanHost)) {
    throw new Error('Store does not expose a valid public domain.');
  }

  if (cleanHost.endsWith('.myshopify.com')) {
    return `https://${cleanHost}/api/ucp/mcp`;
  }

  try {
    const res = await fetcher(`https://${cleanHost}/.well-known/ucp`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const manifest = (await res.json()) as {
        ucp?: {
          services?: {
            'dev.ucp.shopping'?: Array<{ transport?: string; endpoint?: string }>;
          };
        };
      };
      const mcp = manifest?.ucp?.services?.['dev.ucp.shopping']?.find(
        (svc) => svc.transport === 'mcp' && typeof svc.endpoint === 'string',
      );
      if (mcp?.endpoint) {
        return assertSafeHttpsUrl(mcp.endpoint).href;
      }
    }
  } catch {
    // Fall back to standard storefront path below.
  }

  return `https://${cleanHost}/api/ucp/mcp`;
}

async function callStoreUcp(
  endpoint: string,
  profile: string,
  toolName: 'create_checkout' | 'get_checkout' | 'update_checkout',
  args: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const safeEndpoint = assertSafeHttpsUrl(endpoint);
  const res = await fetcher(safeEndpoint.href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: {
          meta: { 'ucp-agent': { profile } },
          ...args,
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Shopify store checkout returned HTTP ${res.status}.`);
  }

  const envelope = (await res.json()) as {
    error?: { message?: string };
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type?: string; text?: string }>;
    };
  };

  if (envelope.error || envelope.result?.isError) {
    const errText =
      envelope.error?.message ||
      envelope.result?.content?.[0]?.text ||
      'Shopify store rejected the checkout request.';
    throw new Error(errText.slice(0, 200));
  }

  let raw = envelope.result?.structuredContent;
  if (!raw) {
    const txt = envelope.result?.content?.[0]?.text;
    if (!txt) throw new Error('Shopify store returned an empty checkout response.');
    raw = JSON.parse(txt) as Record<string, unknown>;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Unexpected checkout response from Shopify store.');
  }
  return raw;
}

function parseCheckoutSnapshot(
  raw: Record<string, unknown>,
  options?: { hasShippingAddress?: boolean },
): UcpCheckoutSnapshot {
  const hasShippingAddress = Boolean(options?.hasShippingAddress);
  const id = typeof raw.id === 'string' ? raw.id : '';
  const continueUrl = typeof raw.continue_url === 'string' ? raw.continue_url : '';
  if (!id || !continueUrl) {
    throw new Error('Store checkout did not return a valid session link.');
  }
  assertSafeHttpsUrl(continueUrl);

  const rawStatus = String(raw.status ?? raw.checkout_status ?? 'requires_escalation');
  const status: UcpCheckoutStatus = VALID_STATUSES.has(rawStatus)
    ? (rawStatus as UcpCheckoutStatus)
    : 'requires_escalation';
  const currency = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : 'USD';

  let subtotalMinor = 0;
  let discountMinor = 0;
  let taxMinor = 0;
  let totalMinor = 0;
  if (Array.isArray(raw.totals)) {
    for (const t of raw.totals as Array<{ type?: string; amount?: number }>) {
      if (typeof t?.amount !== 'number') continue;
      if (t.type === 'subtotal') subtotalMinor = t.amount;
      else if (t.type === 'items_discount' || t.type === 'discount') {
        discountMinor += Math.abs(t.amount);
      } else if (t.type === 'tax') taxMinor = t.amount;
      else if (t.type === 'total') totalMinor = t.amount;
    }
  }
  if (totalMinor === 0 && subtotalMinor > 0) {
    totalMinor = Math.max(0, subtotalMinor - discountMinor + taxMinor);
  }

  const discountsObj = raw.discounts as { codes?: unknown } | undefined;
  const promoCodes = Array.isArray(discountsObj?.codes)
    ? discountsObj.codes.filter((c): c is string => typeof c === 'string')
    : [];

  const messages: UcpCheckoutMessage[] = [];
  if (Array.isArray(raw.messages)) {
    for (const m of raw.messages as Array<{ code?: unknown; content?: unknown; type?: unknown }>) {
      if (typeof m?.content !== 'string') continue;
      const code = typeof m.code === 'string' ? m.code : '';
      const lower = m.content.toLowerCase();
      if (NOISE_MESSAGE_CODES.has(code) || lower.includes('enter a shipping address')) {
        continue;
      }
      if (isUnshippableMessage({ code: code || undefined, content: m.content }) && !hasShippingAddress) {
        continue;
      }
      messages.push({
        code: code || undefined,
        content: m.content,
        type: typeof m.type === 'string' ? m.type : undefined,
      });
    }
  }

  const unshippable = hasShippingAddress && messages.some(isUnshippableMessage);

  const lineItems: UcpCheckoutLine[] = [];
  if (Array.isArray(raw.line_items)) {
    for (const line of raw.line_items as Array<{
      id?: unknown;
      quantity?: unknown;
      item?: { id?: unknown };
    }>) {
      const lineId = typeof line?.id === 'string' ? line.id : '';
      const variantId = typeof line?.item?.id === 'string' ? line.item.id : '';
      const quantity = typeof line?.quantity === 'number' ? line.quantity : 1;
      if (lineId && variantId) {
        lineItems.push({ lineId, variantId, quantity });
      }
    }
  }

  return {
    providerCheckoutId: id,
    continueUrl,
    status,
    currency,
    subtotalMinor,
    discountMinor,
    taxMinor,
    totalMinor,
    promoCodes,
    messages,
    unshippable,
    lineItems,
    expiresAt: typeof raw.expires_at === 'string' ? raw.expires_at : null,
  };
}

export async function createStoreCheckout(
  config: UcpClientConfig,
  params: {
    shopUcpDomain: string;
    currency: string;
    lines: UcpLineInput[];
    buyerEmail?: string;
    shippingAddress?: ShippingAddress | null;
    promoCode?: string;
  },
): Promise<UcpCheckoutSnapshot> {
  const fetcher = config.fetcher ?? fetch;
  const profile = config.ucpProfile || DEFAULT_UCP_PROFILE;
  const endpoint = await resolveStoreUcpEndpoint(params.shopUcpDomain, fetcher);

  const checkoutPayload: Record<string, unknown> = {
    currency: params.currency.toUpperCase(),
    line_items: params.lines.map((line) => ({
      quantity: line.quantity,
      item: { id: line.variantId },
    })),
  };

  if (params.buyerEmail) {
    checkoutPayload.buyer = { email: params.buyerEmail };
  }

  const hasShippingAddress = Boolean(
    params.shippingAddress?.postalCode?.trim() || params.shippingAddress?.country?.trim(),
  );
  if (hasShippingAddress && params.shippingAddress) {
    const addr = params.shippingAddress;
    const dest: Record<string, string> = {
      id: 'dest_1',
      address_country: (addr.country || 'US').toUpperCase(),
    };
    if (addr.postalCode?.trim()) dest.postal_code = addr.postalCode.trim();
    if (addr.firstName?.trim()) dest.first_name = addr.firstName.trim();
    if (addr.lastName?.trim()) dest.last_name = addr.lastName.trim();
    if (addr.street?.trim()) dest.street_address = addr.street.trim();
    if (addr.apt?.trim()) dest.extended_address = addr.apt.trim();
    if (addr.city?.trim()) dest.address_locality = addr.city.trim();
    if (addr.region?.trim()) dest.address_region = addr.region.trim();

    checkoutPayload.fulfillment = {
      methods: [
        {
          type: 'shipping',
          selected_destination_id: 'dest_1',
          destinations: [dest],
        },
      ],
    };
  }

  if (params.promoCode) {
    checkoutPayload.discounts = { codes: [params.promoCode.trim()] };
  }

  const raw = await callStoreUcp(
    endpoint,
    profile,
    'create_checkout',
    { checkout: checkoutPayload },
    fetcher,
  );
  return parseCheckoutSnapshot(raw, { hasShippingAddress });
}

export async function updateStoreCheckoutDiscount(
  config: UcpClientConfig,
  params: {
    shopUcpDomain: string;
    providerCheckoutId: string;
    currency: string;
    lineItems: UcpCheckoutLine[];
    codes: string[];
    hasShippingAddress?: boolean;
  },
): Promise<UcpCheckoutSnapshot> {
  const fetcher = config.fetcher ?? fetch;
  const profile = config.ucpProfile || DEFAULT_UCP_PROFILE;
  const endpoint = await resolveStoreUcpEndpoint(params.shopUcpDomain, fetcher);

  const raw = await callStoreUcp(
    endpoint,
    profile,
    'update_checkout',
    {
      id: params.providerCheckoutId,
      checkout: {
        currency: params.currency.toUpperCase(),
        line_items: params.lineItems.map((line) => ({
          id: line.lineId,
          quantity: line.quantity,
          item: { id: line.variantId },
        })),
        discounts: { codes: params.codes },
      },
    },
    fetcher,
  );

  return parseCheckoutSnapshot(raw, { hasShippingAddress: params.hasShippingAddress });
}

export async function getStoreCheckout(
  config: UcpClientConfig,
  params: {
    shopUcpDomain: string;
    providerCheckoutId: string;
    hasShippingAddress?: boolean;
  },
): Promise<UcpCheckoutSnapshot> {
  const fetcher = config.fetcher ?? fetch;
  const profile = config.ucpProfile || DEFAULT_UCP_PROFILE;
  const endpoint = await resolveStoreUcpEndpoint(params.shopUcpDomain, fetcher);

  const raw = await callStoreUcp(
    endpoint,
    profile,
    'get_checkout',
    { id: params.providerCheckoutId },
    fetcher,
  );
  return parseCheckoutSnapshot(raw, { hasShippingAddress: params.hasShippingAddress });
}

export async function checkProductShipping(
  config: UcpClientConfig,
  params: {
    shopUcpDomain: string;
    variantId: string;
    currency?: string;
    shippingAddress: ShippingAddress;
    timeoutMs?: number;
  },
): Promise<ShippingCheckResult> {
  const baseFetcher = config.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 8500);

  try {
    const boundedConfig: UcpClientConfig = {
      ...config,
      fetcher: (input, init) => baseFetcher(input, { ...init, signal: controller.signal }),
    };

    const snapshot = await createStoreCheckout(boundedConfig, {
      shopUcpDomain: params.shopUcpDomain,
      currency: params.currency || 'USD',
      lines: [{ variantId: params.variantId, quantity: 1 }],
      shippingAddress: params.shippingAddress,
    });

    if (snapshot.unshippable) {
      const hit = snapshot.messages.find(isUnshippableMessage);
      return { status: 'unshippable', message: hit?.content || null };
    }
    return { status: 'ok', message: null };
  } catch {
    return { status: 'unknown', message: null };
  } finally {
    clearTimeout(timer);
  }
}
