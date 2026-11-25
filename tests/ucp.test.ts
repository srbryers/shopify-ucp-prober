import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeHttpsUrl,
  checkProductShipping,
  enrichLiveCheckoutSavings,
  isSafePublicHost,
  matchProductShopGid,
  resolveStoreUcpEndpoint,
  searchGlobalCatalog,
  updateStoreCheckoutDiscount,
  type CatalogProduct,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('SSRF guards reject private, local, IP, credential, and HTTP endpoints', () => {
  assert.equal(isSafePublicHost('coolshop.myshopify.com'), true);
  assert.equal(isSafePublicHost('shop.example.com'), true);

  for (const bad of [
    'localhost',
    'api.localhost',
    'printer.local',
    'metadata.google.internal',
    '127.0.0.1',
    '169.254.169.254',
    '[::1]',
    '0x7f000001',
    '',
  ]) {
    assert.equal(isSafePublicHost(bad), false, `expected ${bad} to be rejected`);
  }

  assert.throws(() => assertSafeHttpsUrl('http://shop.example.com/api/ucp/mcp'));
  assert.throws(() => assertSafeHttpsUrl('https://user:pass@shop.example.com/api/ucp/mcp'));
  assert.throws(() => assertSafeHttpsUrl('https://shop.example.com:8443/api/ucp/mcp'));
  assert.throws(() => assertSafeHttpsUrl('https://127.0.0.1/api/ucp/mcp'));
  assert.equal(
    assertSafeHttpsUrl('https://shop.example.com/api/ucp/mcp').href,
    'https://shop.example.com/api/ucp/mcp',
  );
});

test('resolveStoreUcpEndpoint fast-paths *.myshopify.com and discovers custom domains via /.well-known/ucp', async () => {
  let called = false;
  const noFetch: typeof fetch = async () => {
    called = true;
    throw new Error('should not be called for *.myshopify.com');
  };

  const fastPath = await resolveStoreUcpEndpoint('everlane-demo.myshopify.com', noFetch);
  assert.equal(fastPath, 'https://everlane-demo.myshopify.com/api/ucp/mcp');
  assert.equal(called, false);

  const customFetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://brand.example.com/.well-known/ucp');
    assert.equal(init?.redirect, 'error');
    return jsonResponse({
      ucp: {
        services: {
          'dev.ucp.shopping': [
            { transport: 'mcp', endpoint: 'https://checkout.brand.example.com/api/ucp/mcp' },
          ],
        },
      },
    });
  };

  const customPath = await resolveStoreUcpEndpoint('https://brand.example.com/products/shirt', customFetcher);
  assert.equal(customPath, 'https://checkout.brand.example.com/api/ucp/mcp');
});

test('searchGlobalCatalog sends ships_to and price minor units and parses list_price markdowns', async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fetcher: typeof fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      jsonrpc: '2.0',
      result: {
        structuredContent: {
          products: [
            {
              id: 'gid://shopify/Product/1',
              title: 'Raw Selvedge Jeans',
              url: 'https://brand.example.com/products/jeans',
              variants: [
                {
                  id: 'gid://shopify/ProductVariant/11',
                  availability: { available: true },
                  price: { amount: 9000, currency: 'USD' },
                  list_price: { amount: 12000, currency: 'USD' },
                  seller: {
                    id: 'gid://shopify/Shop/55',
                    name: 'Brand',
                    domain: 'brand.myshopify.com',
                    url: 'https://brand.example.com',
                  },
                },
              ],
            },
          ],
          pagination: { has_next_page: false, total_count: 1 },
        },
      },
    });
  };

  const res = await searchGlobalCatalog(
    { catalogToken: 'tok_test', fetcher },
    { query: 'selvedge denim', maxPriceUsd: 150, shipsToCountry: 'US', shipsToPostalCode: '10013' },
  );

  assert.equal(res.products.length, 1);
  assert.equal(res.products[0].savingsMinor, 3000);
  assert.equal(res.products[0].savingsPercent, 25);
  assert.equal(res.products[0].savingsSource, 'list_price');

  const params = (capturedBody as { params: { arguments: { catalog: { filters: { price: { max: number }; ships_to: { postal_code: string } } } } } }).params;
  assert.equal(params.arguments.catalog.filters.price.max, 15000);
  assert.equal(params.arguments.catalog.filters.ships_to.postal_code, '10013');
});

test('matchProductShopGid matches exact domain before display name to prevent collisions', () => {
  const products: CatalogProduct[] = [
    {
      key: '1',
      title: 'Kettle',
      url: 'https://other-coffee.example.com/products/kettle',
      imageUrl: '',
      priceAmountMinor: 5000,
      originalPriceMinor: null,
      savingsMinor: 0,
      savingsPercent: 0,
      savingsSource: null,
      priceCurrency: 'USD',
      priceLabel: '$50.00',
      originalPriceLabel: '',
      merchantName: 'Coffee Co',
      merchantDomain: 'other-coffee.example.com',
      shopUcpDomain: 'other-coffee.myshopify.com',
      shopId: 'gid://shopify/Shop/111',
      providerProductId: 'p1',
      providerVariantId: 'v1',
      checkoutUrl: '',
      nativeCheckout: true,
    },
    {
      key: '2',
      title: 'Pour Over',
      url: 'https://real-coffee.example.com/products/pourover',
      imageUrl: '',
      priceAmountMinor: 4000,
      originalPriceMinor: null,
      savingsMinor: 0,
      savingsPercent: 0,
      savingsSource: null,
      priceCurrency: 'USD',
      priceLabel: '$40.00',
      originalPriceLabel: '',
      merchantName: 'Coffee Co',
      merchantDomain: 'real-coffee.example.com',
      shopUcpDomain: 'real-coffee.myshopify.com',
      shopId: 'gid://shopify/Shop/222',
      providerProductId: 'p2',
      providerVariantId: 'v2',
      checkoutUrl: '',
      nativeCheckout: true,
    },
  ];

  const gid = matchProductShopGid(products, {
    merchantDomain: 'https://www.real-coffee.example.com',
    shopName: 'Coffee Co',
  });
  assert.equal(gid, 'gid://shopify/Shop/222');
});

test('enrichLiveCheckoutSavings uncovers hidden automatic cart discounts and isolates timeouts', async () => {
  const baseProduct = (overrides: Partial<CatalogProduct>): CatalogProduct => ({
    key: 'k1',
    title: 'Test Item',
    url: 'https://store.example.com/products/item',
    imageUrl: '',
    priceAmountMinor: 10000,
    originalPriceMinor: null,
    savingsMinor: 0,
    savingsPercent: 0,
    savingsSource: null,
    priceCurrency: 'USD',
    priceLabel: '$100.00',
    originalPriceLabel: '',
    merchantName: 'Store',
    merchantDomain: 'store.example.com',
    shopUcpDomain: 'fast-discount.myshopify.com',
    providerProductId: 'p1',
    providerVariantId: 'gid://shopify/ProductVariant/1',
    checkoutUrl: '',
    nativeCheckout: true,
    ...overrides,
  });

  const products = [
    baseProduct({ key: 'auto_deal', shopUcpDomain: 'fast-discount.myshopify.com' }),
    baseProduct({ key: 'slow_store', shopUcpDomain: 'slow-store.myshopify.com' }),
    baseProduct({
      key: 'already_sale',
      shopUcpDomain: 'skip-me.myshopify.com',
      originalPriceMinor: 12000,
      savingsMinor: 2000,
      savingsPercent: 17,
      savingsSource: 'list_price',
    }),
  ];

  const probedHosts: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    probedHosts.push(new URL(url).hostname);

    if (url.includes('slow-store.myshopify.com')) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }

    return jsonResponse({
      jsonrpc: '2.0',
      result: {
        structuredContent: {
          id: 'chk_1',
          continue_url: 'https://fast-discount.myshopify.com/checkouts/cn/1',
          status: 'ready_for_complete',
          currency: 'USD',
          totals: [
            { type: 'subtotal', amount: 10000 },
            { type: 'items_discount', amount: 2500 },
            { type: 'total', amount: 7500 },
          ],
          messages: [],
        },
      },
    });
  };

  const { products: enriched, stats } = await enrichLiveCheckoutSavings(
    { fetcher },
    products,
    { maxProbes: 5, timeoutMs: 80 },
  );

  assert.equal(stats.probedCount, 2);
  assert.equal(stats.discoveredDiscounts, 1);
  assert.equal(probedHosts.includes('skip-me.myshopify.com'), false);

  const autoDeal = enriched.find((p) => p.key === 'auto_deal')!;
  assert.equal(autoDeal.priceAmountMinor, 7500);
  assert.equal(autoDeal.originalPriceMinor, 10000);
  assert.equal(autoDeal.savingsPercent, 25);
  assert.equal(autoDeal.savingsSource, 'live_checkout');

  const slowStore = enriched.find((p) => p.key === 'slow_store')!;
  assert.equal(slowStore.savingsMinor, 0);
  assert.equal(slowStore.priceAmountMinor, 10000);
});

test('checkProductShipping flags unshippable destinations and updateStoreCheckoutDiscount applies promo codes', async () => {
  const shippingFetcher: typeof fetch = async () =>
    jsonResponse({
      jsonrpc: '2.0',
      result: {
        structuredContent: {
          id: 'chk_ship',
          continue_url: 'https://brand.myshopify.com/checkouts/cn/ship',
          status: 'incomplete',
          currency: 'USD',
          totals: [{ type: 'subtotal', amount: 5000 }],
          messages: [
            {
              code: 'delivery_no_delivery_available_for_merchandise_line',
              content: "This item can't be shipped to the selected address.",
            },
          ],
        },
      },
    });

  const shipResult = await checkProductShipping(
    { fetcher: shippingFetcher },
    {
      shopUcpDomain: 'brand.myshopify.com',
      variantId: 'gid://shopify/ProductVariant/1',
      shippingAddress: { country: 'US', postalCode: '99501' },
    },
  );
  assert.equal(shipResult.status, 'unshippable');
  assert.match(shipResult.message || '', /can't be shipped/i);

  const promoFetcher: typeof fetch = async () =>
    jsonResponse({
      jsonrpc: '2.0',
      result: {
        structuredContent: {
          id: 'chk_promo',
          continue_url: 'https://brand.myshopify.com/checkouts/cn/promo',
          status: 'ready_for_complete',
          currency: 'USD',
          totals: [
            { type: 'subtotal', amount: 10000 },
            { type: 'discount', amount: 2000 },
            { type: 'total', amount: 8000 },
          ],
          discounts: { codes: ['BFCM20'] },
          line_items: [{ id: 'line_1', quantity: 1, item: { id: 'gid://shopify/ProductVariant/1' } }],
          messages: [],
        },
      },
    });

  const updated = await updateStoreCheckoutDiscount(
    { fetcher: promoFetcher },
    {
      shopUcpDomain: 'brand.myshopify.com',
      providerCheckoutId: 'chk_promo',
      currency: 'USD',
      lineItems: [{ lineId: 'line_1', variantId: 'gid://shopify/ProductVariant/1', quantity: 1 }],
      codes: ['BFCM20'],
    },
  );
  assert.equal(updated.discountMinor, 2000);
  assert.equal(updated.totalMinor, 8000);
  assert.deepEqual(updated.promoCodes, ['BFCM20']);
});
