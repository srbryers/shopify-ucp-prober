import { computeSavings, formatMoney } from './catalog.js';
import { createStoreCheckout } from './checkout.js';
import type {
  CatalogProduct,
  ProbeSavingsOptions,
  ProbeSavingsStats,
  UcpClientConfig,
} from './types.js';

/**
 * Probes Storefront UCP create_checkout in parallel for catalog items that show
 * no listed compare-at discount. Uncovers automatic cart-level markdowns while
 * enforcing a tight per-store timeout so one slow storefront never stalls results.
 */
export async function enrichLiveCheckoutSavings<T extends CatalogProduct>(
  config: UcpClientConfig,
  products: T[],
  options: ProbeSavingsOptions = {},
): Promise<{ products: T[]; stats: ProbeSavingsStats }> {
  const started = Date.now();
  const maxProbes = options.maxProbes ?? 5;
  const timeoutMs = options.timeoutMs ?? 3500;
  const baseFetcher = config.fetcher ?? fetch;

  const probeTargets = products
    .filter((p) => p.savingsMinor === 0 && p.shopUcpDomain && p.providerVariantId)
    .slice(0, maxProbes);

  if (probeTargets.length === 0) {
    return {
      products,
      stats: { probedCount: 0, discoveredDiscounts: 0, durationMs: Date.now() - started },
    };
  }

  const probed = new Map<string, Partial<CatalogProduct>>();

  await Promise.allSettled(
    probeTargets.map(async (item) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const boundedConfig: UcpClientConfig = {
          ...config,
          fetcher: (input, init) => baseFetcher(input, { ...init, signal: controller.signal }),
        };

        const snap = await createStoreCheckout(boundedConfig, {
          shopUcpDomain: item.shopUcpDomain,
          currency: item.priceCurrency || 'USD',
          lines: [{ variantId: item.providerVariantId, quantity: 1 }],
        });

        if (snap.discountMinor > 0 && snap.subtotalMinor > snap.discountMinor) {
          const originalPriceMinor = snap.subtotalMinor;
          const discountedPriceMinor = snap.subtotalMinor - snap.discountMinor;
          const { savingsMinor, savingsPercent } = computeSavings(
            discountedPriceMinor,
            originalPriceMinor,
          );

          if (savingsMinor > 0) {
            probed.set(item.key, {
              originalPriceMinor,
              originalPriceLabel: formatMoney(originalPriceMinor, item.priceCurrency),
              priceAmountMinor: discountedPriceMinor,
              priceLabel: formatMoney(discountedPriceMinor, item.priceCurrency),
              savingsMinor,
              savingsPercent,
              savingsSource: 'live_checkout',
              checkoutUrl: snap.continueUrl || item.checkoutUrl,
            });
          }
        }
      } catch {
        // Keep the catalog price if a store times out or blocks anonymous checkout.
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const enriched = products.map((p) => {
    const patch = probed.get(p.key);
    return patch ? { ...p, ...patch } : p;
  });

  return {
    products: enriched,
    stats: {
      probedCount: probeTargets.length,
      discoveredDiscounts: probed.size,
      durationMs: Date.now() - started,
    },
  };
}
