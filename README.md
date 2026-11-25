# shopify-ucp-prober

Zero-dependency TypeScript starter for searching Shopify Global Catalog, probing hidden automatic cart discounts in parallel with Storefront UCP, checking ZIP shipping eligibility, and handing off straight to each merchant's native checkout.

Extracted from [Hold'em](https://holdem.showerthoughts.dev/), a multi-store Black Friday deal finder built on Shopify's Global Catalog and Storefront UCP. Read the full technical walkthrough at [showerthoughts.dev/writing/holdem-shopify-ucp](https://showerthoughts.dev/writing/holdem-shopify-ucp/).

## The problem it solves

Many Shopify stores run automatic cart discounts (like 25% off at checkout) without editing `compare_at_price` on every product. Reading static catalog prices misses those real markdowns.

The starter combines Shopify's Global Catalog `search_catalog` tool with parallel Storefront UCP `create_checkout` probes. You uncover live automatic cart savings, verify ZIP shipping before checkout, and generate direct `continue_url` handoff links with zero per-store OAuth tokens and zero PCI scope.

## Quickstart

Requires Node.js 20 or newer.

```bash
git clone https://github.com/srbryers/shopify-ucp-prober.git
cd shopify-ucp-prober
npm install
```

Run the offline demo right away (no API token required):

```bash
npm run demo
```

Run against live Shopify stores with a Global Catalog token:

```bash
export SHOPIFY_CATALOG_TOKEN="your_token_here"
npm run probe -- "selvedge denim" --max 150 --zip 10013 --probes 5
```

## Included modules

| File | Responsibility |
|---|---|
| `src/catalog.ts` | JSON-RPC `search_catalog` client with `ships_to`, minor-unit price filters, retries, and exact-domain shop GID matching |
| `src/checkout.ts` | SSRF-safe `resolveStoreUcpEndpoint` (`*.myshopify.com` fast path + `/.well-known/ucp`), `createStoreCheckout`, `updateStoreCheckoutDiscount`, `getStoreCheckout`, and `checkProductShipping` |
| `src/prober.ts` | Parallel `enrichLiveCheckoutSavings` prober using `Promise.allSettled` and a strict per-store `AbortController` timeout |
| `src/security.ts` | Public host and clean HTTPS URL guards blocking private IPs, localhost, credentials, and redirects |
| `src/cli.ts` | Runnable CLI with live and `--demo` modes |
| `tests/ucp.test.ts` | Deterministic unit tests using `node:test` and mocked `fetch` |

## Library usage

```ts
import {
  checkProductShipping,
  enrichLiveCheckoutSavings,
  searchGlobalCatalog,
} from 'shopify-ucp-prober';

const config = {
  catalogToken: process.env.SHOPIFY_CATALOG_TOKEN,
};

const search = await searchGlobalCatalog(config, {
  query: 'selvedge denim',
  maxPriceUsd: 150,
  shipsToCountry: 'US',
  shipsToPostalCode: '10013',
  limit: 12,
});

const { products, stats } = await enrichLiveCheckoutSavings(config, search.products, {
  maxProbes: 5,
  timeoutMs: 3500,
});

console.log(`Discovered ${stats.discoveredDiscounts} automatic cart discounts.`);

const first = products[0];
if (first) {
  const shipping = await checkProductShipping(config, {
    shopUcpDomain: first.shopUcpDomain,
    variantId: first.providerVariantId,
    shippingAddress: { country: 'US', postalCode: '10013' },
  });
  console.log(first.title, first.priceLabel, shipping.status);
}
```

## Scripts

```bash
npm run demo       # Run offline walkthrough with mocked UCP responses
npm test           # Run deterministic unit tests
npm run typecheck  # Verify TypeScript strict types
npm run build      # Emit compiled JS and .d.ts declarations to dist/
```

## License

MIT
