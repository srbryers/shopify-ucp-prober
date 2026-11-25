#!/usr/bin/env node
import { searchGlobalCatalog } from './catalog.js';
import { checkProductShipping } from './checkout.js';
import { enrichLiveCheckoutSavings } from './prober.js';
import type { CatalogProduct, UcpClientConfig } from './types.js';

interface CliArgs {
  query: string;
  maxPriceUsd: number | null;
  zip: string | null;
  country: string;
  limit: number;
  maxProbes: number;
  timeoutMs: number;
  demo: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  let maxPriceUsd: number | null = null;
  let zip: string | null = null;
  let country = 'US';
  let limit = 8;
  let maxProbes = 5;
  let timeoutMs = 3500;
  let demo = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max' && argv[i + 1]) {
      maxPriceUsd = Number(argv[++i]);
    } else if (arg === '--zip' && argv[i + 1]) {
      zip = argv[++i];
    } else if (arg === '--country' && argv[i + 1]) {
      country = argv[++i].toUpperCase();
    } else if (arg === '--limit' && argv[i + 1]) {
      limit = Number(argv[++i]);
    } else if (arg === '--probes' && argv[i + 1]) {
      maxProbes = Number(argv[++i]);
    } else if (arg === '--timeout' && argv[i + 1]) {
      timeoutMs = Number(argv[++i]);
    } else if (arg === '--demo') {
      demo = true;
    } else if (!arg.startsWith('--')) {
      positionals.push(arg);
    }
  }

  return {
    query: positionals.join(' ').trim() || 'selvedge denim',
    maxPriceUsd: Number.isFinite(maxPriceUsd) && (maxPriceUsd ?? 0) > 0 ? maxPriceUsd : null,
    zip,
    country,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 20) : 8,
    maxProbes: Number.isFinite(maxProbes) && maxProbes >= 0 ? maxProbes : 5,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 500 ? timeoutMs : 3500,
    demo,
  };
}

function createDemoFetcher(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.includes('catalog.shopify.com')) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: {
            structuredContent: {
              products: [
                {
                  id: 'gid://shopify/Product/1001',
                  title: 'Japanese Raw Selvedge Jeans (14oz)',
                  url: 'https://denim-craft-demo.myshopify.com/products/raw-selvedge',
                  price: { amount: 14800, currency: 'USD' },
                  variants: [
                    {
                      id: 'gid://shopify/ProductVariant/9001',
                      availability: { available: true },
                      price: { amount: 14800, currency: 'USD' },
                      seller: {
                        id: 'gid://shopify/Shop/101',
                        name: 'Denim Craft Studio',
                        domain: 'denim-craft-demo.myshopify.com',
                        url: 'https://denim-craft-demo.myshopify.com',
                      },
                      eligible: { native_checkout: true },
                    },
                  ],
                },
                {
                  id: 'gid://shopify/Product/1002',
                  title: 'Indigo Selvedge Chore Jacket',
                  url: 'https://indigo-works-demo.myshopify.com/products/chore-jacket',
                  price: { amount: 9800, currency: 'USD' },
                  list_price: { amount: 14000, currency: 'USD' },
                  variants: [
                    {
                      id: 'gid://shopify/ProductVariant/9002',
                      availability: { available: true },
                      price: { amount: 9800, currency: 'USD' },
                      list_price: { amount: 14000, currency: 'USD' },
                      seller: {
                        id: 'gid://shopify/Shop/102',
                        name: 'Indigo Works',
                        domain: 'indigo-works-demo.myshopify.com',
                        url: 'https://indigo-works-demo.myshopify.com',
                      },
                      eligible: { native_checkout: true },
                    },
                  ],
                },
                {
                  id: 'gid://shopify/Product/1003',
                  title: 'Heavyweight Unwashed Tapered Denim',
                  url: 'https://north-mill-demo.myshopify.com/products/tapered-denim',
                  price: { amount: 13500, currency: 'USD' },
                  variants: [
                    {
                      id: 'gid://shopify/ProductVariant/9003',
                      availability: { available: true },
                      price: { amount: 13500, currency: 'USD' },
                      seller: {
                        id: 'gid://shopify/Shop/103',
                        name: 'North Mill Co',
                        domain: 'north-mill-demo.myshopify.com',
                        url: 'https://north-mill-demo.myshopify.com',
                      },
                      eligible: { native_checkout: true },
                    },
                  ],
                },
              ],
              pagination: { has_next_page: false, total_count: 3 },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const hasDestination = bodyText.includes('destinations');

    if (url.includes('denim-craft-demo.myshopify.com')) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: {
            structuredContent: {
              id: 'chk_demo_1',
              continue_url: 'https://denim-craft-demo.myshopify.com/checkouts/cn/demo-1',
              status: 'ready_for_complete',
              currency: 'USD',
              totals: [
                { type: 'subtotal', amount: 14800 },
                { type: 'items_discount', amount: 3700 },
                { type: 'total', amount: 11100 },
              ],
              line_items: [{ id: 'line_1', quantity: 1, item: { id: 'gid://shopify/ProductVariant/9001' } }],
              messages: [],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.includes('north-mill-demo.myshopify.com')) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: {
            structuredContent: {
              id: 'chk_demo_3',
              continue_url: 'https://north-mill-demo.myshopify.com/checkouts/cn/demo-3',
              status: 'incomplete',
              currency: 'USD',
              totals: [
                { type: 'subtotal', amount: 13500 },
                { type: 'total', amount: 13500 },
              ],
              line_items: [{ id: 'line_3', quantity: 1, item: { id: 'gid://shopify/ProductVariant/9003' } }],
              messages: hasDestination
                ? [
                    {
                      code: 'delivery_no_delivery_available_for_merchandise_line',
                      content: 'This item cannot be shipped to your selected postal code.',
                    },
                  ]
                : [],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        result: {
          structuredContent: {
            id: 'chk_demo_2',
            continue_url: 'https://indigo-works-demo.myshopify.com/checkouts/cn/demo-2',
            status: 'ready_for_complete',
            currency: 'USD',
            totals: [
              { type: 'subtotal', amount: 9800 },
              { type: 'total', amount: 9800 },
            ],
            line_items: [{ id: 'line_2', quantity: 1, item: { id: 'gid://shopify/ProductVariant/9002' } }],
            messages: [],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

function pad(text: string, width: number): string {
  const clean = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return clean.padEnd(width, ' ');
}

function formatSavingsColumn(p: CatalogProduct): string {
  if (p.savingsMinor <= 0) return '-';
  const tag = p.savingsSource === 'live_checkout' ? 'LIVE CART' : 'LIST';
  return `-${p.savingsPercent}% (${tag})`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.SHOPIFY_CATALOG_TOKEN?.trim();

  if (!args.demo && !token) {
    console.error('Missing SHOPIFY_CATALOG_TOKEN environment variable.');
    console.error('Run with --demo for an offline walkthrough, or export SHOPIFY_CATALOG_TOKEN for live Shopify stores.');
    console.error('Example: npm run demo');
    process.exit(1);
  }

  const config: UcpClientConfig = {
    catalogToken: token || 'demo-token',
    catalogEndpoint: process.env.SHOPIFY_CATALOG_ENDPOINT,
    ucpProfile: process.env.SHOPIFY_UCP_PROFILE,
    fetcher: args.demo ? createDemoFetcher() : fetch,
  };

  console.log(`\nSearching Shopify Global Catalog for "${args.query}"${args.demo ? ' [demo mode]' : ''}...`);
  const search = await searchGlobalCatalog(config, {
    query: args.query,
    limit: args.limit,
    maxPriceUsd: args.maxPriceUsd,
    shipsToCountry: args.country,
    shipsToPostalCode: args.zip,
  });

  console.log(`Found ${search.products.length} products in ${search.durationMs}ms.`);
  console.log(`Probing up to ${args.maxProbes} stores via Storefront UCP create_checkout (${args.timeoutMs}ms timeout)...`);

  const { products, stats } = await enrichLiveCheckoutSavings(config, search.products, {
    maxProbes: args.maxProbes,
    timeoutMs: args.timeoutMs,
  });

  console.log(
    `Probed ${stats.probedCount} stores in ${stats.durationMs}ms: uncovered ${stats.discoveredDiscounts} hidden automatic cart discount(s).`,
  );

  const shippingByKey = new Map<string, string>();
  if (args.zip) {
    console.log(`Checking shipping eligibility for ${args.country} ${args.zip}...`);
    await Promise.allSettled(
      products.map(async (p) => {
        if (!p.shopUcpDomain || !p.providerVariantId) return;
        const result = await checkProductShipping(config, {
          shopUcpDomain: p.shopUcpDomain,
          variantId: p.providerVariantId,
          currency: p.priceCurrency,
          shippingAddress: { country: args.country, postalCode: args.zip! },
          timeoutMs: args.timeoutMs,
        });
        shippingByKey.set(p.key, result.status);
      }),
    );
  }

  console.log('');
  const header = [
    pad('Store', 20),
    pad('Product', 34),
    pad('Price', 10),
    pad('Savings', 18),
    ...(args.zip ? [pad(`ZIP ${args.zip}`, 12)] : []),
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const p of products) {
    const row = [
      pad(p.merchantName, 20),
      pad(p.title, 34),
      pad(p.priceLabel || '-', 10),
      pad(formatSavingsColumn(p), 18),
      ...(args.zip ? [pad(shippingByKey.get(p.key) ?? 'unknown', 12)] : []),
    ].join('  ');
    console.log(row);
    if (p.checkoutUrl) {
      console.log(`  checkout: ${p.checkoutUrl}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
