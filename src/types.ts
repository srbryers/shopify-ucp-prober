export type SavingsSource = 'list_price' | 'live_checkout' | null;

export type UcpCheckoutStatus =
  | 'incomplete'
  | 'requires_escalation'
  | 'ready_for_complete'
  | 'complete_in_progress'
  | 'completed'
  | 'canceled'
  | 'error';

export interface UcpClientConfig {
  /** Bearer token for Shopify's Global Catalog MCP endpoint. */
  catalogToken?: string;
  /** Defaults to https://catalog.shopify.com/api/ucp/mcp */
  catalogEndpoint?: string;
  /** UCP agent profile URL passed in meta['ucp-agent'].profile */
  ucpProfile?: string;
  /** Custom fetch implementation (handy for tests or proxies). */
  fetcher?: typeof fetch;
}

export interface ShippingAddress {
  postalCode: string;
  country: string;
  city?: string;
  region?: string;
  firstName?: string;
  lastName?: string;
  street?: string;
  apt?: string;
}

export interface CatalogProduct {
  key: string;
  title: string;
  url: string;
  imageUrl: string;
  priceAmountMinor: number | null;
  originalPriceMinor: number | null;
  savingsMinor: number;
  savingsPercent: number;
  savingsSource: SavingsSource;
  priceCurrency: string;
  priceLabel: string;
  originalPriceLabel: string;
  merchantName: string;
  merchantDomain: string;
  shopUcpDomain: string;
  shopId?: string;
  providerProductId: string;
  providerVariantId: string;
  checkoutUrl: string;
  nativeCheckout: boolean;
}

export interface CatalogSearchOptions {
  query: string;
  limit?: number;
  cursor?: string | null;
  minPriceUsd?: number | null;
  maxPriceUsd?: number | null;
  shipsToCountry?: string;
  shipsToRegion?: string | null;
  shipsToPostalCode?: string | null;
  shopId?: string | null;
  shopDomain?: string | null;
  merchantDomain?: string | null;
  shopName?: string | null;
}

export interface CatalogSearchResult {
  products: CatalogProduct[];
  nextCursor: string | null;
  hasNextPage: boolean;
  totalCount: number | null;
  durationMs: number;
  resolvedShopId: string | null;
}

export interface UcpLineInput {
  variantId: string;
  quantity: number;
}

export interface UcpCheckoutLine {
  lineId: string;
  variantId: string;
  quantity: number;
}

export interface UcpCheckoutMessage {
  code?: string;
  content: string;
  type?: string;
}

export interface UcpCheckoutSnapshot {
  providerCheckoutId: string;
  continueUrl: string;
  status: UcpCheckoutStatus;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  promoCodes: string[];
  messages: UcpCheckoutMessage[];
  unshippable: boolean;
  lineItems: UcpCheckoutLine[];
  expiresAt: string | null;
}

export interface ShippingCheckResult {
  status: 'ok' | 'unshippable' | 'unknown';
  message: string | null;
}

export interface ProbeSavingsOptions {
  maxProbes?: number;
  timeoutMs?: number;
}

export interface ProbeSavingsStats {
  probedCount: number;
  discoveredDiscounts: number;
  durationMs: number;
}
