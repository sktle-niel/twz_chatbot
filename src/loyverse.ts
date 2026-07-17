// Thin client for the Loyverse API (https://developer.loyverse.com/docs/)
// Products are cached in memory so we stay well under Loyverse's rate limits.

import { fetch as undiciFetch, Agent } from "undici";

const BASE_URL = "https://api.loyverse.com/v1.0";
// Item names/prices change rarely, and a full catalog fetch takes minutes on a
// slow network — keep the cache long-lived. Stock checks are always live.
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Loyverse can respond very slowly on weak networks (30-60s per request), so
// Node's default 10s connect timeout is far too tight.
const dispatcher = new Agent({
  connectTimeout: 60_000,
  headersTimeout: 180_000,
  bodyTimeout: 180_000,
});

interface VariantStoreInfo {
  store_id: string;
  price: number | null;
  available_for_sale: boolean;
}

export interface LoyverseVariant {
  variant_id: string;
  sku: string | null;
  option1_value: string | null;
  option2_value: string | null;
  option3_value: string | null;
  default_price: number | null;
  stores?: VariantStoreInfo[] | null;
}

export interface LoyverseItem {
  id: string;
  item_name: string;
  description: string | null;
  variants: LoyverseVariant[];
}

interface InventoryLevel {
  variant_id: string;
  store_id: string;
  in_stock: number;
}

export interface Store {
  id: string;
  name: string;
}

async function loyverseGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  // Retry network errors and 5xx — the connection to Loyverse can be flaky.
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await undiciFetch(url, {
        dispatcher,
        headers: { Authorization: `Bearer ${process.env.LOYVERSE_ACCESS_TOKEN}` },
      });
      if (res.ok) return (await res.json()) as T;
      const body = await res.text();
      if (res.status < 500) {
        // Client error (bad token, bad params) — retrying won't help.
        throw new Error(`Loyverse API ${res.status} on ${path}: ${body}`);
      }
      lastError = new Error(`Loyverse API ${res.status} on ${path}: ${body}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Loyverse API 4")) throw err;
      lastError = err;
    }
    if (attempt < attempts) {
      console.warn(`Loyverse ${path} attempt ${attempt} failed, retrying...`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastError;
}

let itemsCache: { items: LoyverseItem[]; fetchedAt: number } | null = null;
let storesCache: Store[] | null = null;
let itemsRefresh: Promise<LoyverseItem[]> | null = null;

async function fetchAllItemPages(): Promise<LoyverseItem[]> {
  const items: LoyverseItem[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { limit: "250" };
    if (cursor) params.cursor = cursor;
    const page = await loyverseGet<{ items: LoyverseItem[]; cursor?: string }>("/items", params);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

function refreshItems(): Promise<LoyverseItem[]> {
  // Single-flight: concurrent callers share one refresh instead of stacking
  // duplicate multi-minute fetches against the slow Loyverse API.
  if (!itemsRefresh) {
    itemsRefresh = fetchAllItemPages()
      .then((items) => {
        itemsCache = { items, fetchedAt: Date.now() };
        console.log(`Loyverse item cache refreshed: ${items.length} items`);
        return items;
      })
      .finally(() => {
        itemsRefresh = null;
      });
  }
  return itemsRefresh;
}

/**
 * All items, following pagination. Fresh cache is served directly; a stale
 * cache is served immediately while a background refresh runs (Loyverse can
 * take a minute+ to answer, and customers shouldn't wait on that).
 */
export async function getAllItems(): Promise<LoyverseItem[]> {
  if (itemsCache) {
    if (Date.now() - itemsCache.fetchedAt >= CACHE_TTL_MS) {
      refreshItems().catch((err) => console.error("Item cache refresh failed:", err));
    }
    return itemsCache.items;
  }
  return refreshItems();
}

export async function getStores(): Promise<Store[]> {
  if (!storesCache) {
    const res = await loyverseGet<{ stores: Store[] }>("/stores");
    storesCache = res.stores;
  }
  return storesCache;
}

function parseNameList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
}

let targetStoresCache: Store[] | null = null;

/**
 * The branches this bot answers for. Controlled by env vars:
 * - LOYVERSE_STORE_NAMES: comma-separated allowlist (optional; default = all stores)
 * - LOYVERSE_EXCLUDE_STORES: comma-separated blocklist (e.g. "FOUR WHEELS ZONE")
 */
export async function getTargetStores(): Promise<Store[]> {
  if (targetStoresCache) return targetStoresCache;
  const stores = await getStores();
  const include = parseNameList(process.env.LOYVERSE_STORE_NAMES);
  const exclude = parseNameList(process.env.LOYVERSE_EXCLUDE_STORES);

  let target = stores;
  if (include.length > 0) {
    target = target.filter((s) => include.some((n) => s.name.toLowerCase().includes(n)));
  }
  if (exclude.length > 0) {
    target = target.filter((s) => !exclude.some((n) => s.name.toLowerCase().includes(n)));
  }
  if (target.length === 0) {
    throw new Error(
      `Store filters matched no stores. Available: ${stores.map((s) => s.name).join(", ")}`,
    );
  }
  targetStoresCache = target;
  return target;
}

/** True when the variant is sold at the given store (assumes yes if Loyverse omits store data). */
function availableAtStore(variant: LoyverseVariant, storeId: string): boolean {
  const info = variant.stores?.find((s) => s.store_id === storeId);
  return info ? info.available_for_sale : true;
}

/**
 * Price info across the target branches. Normally one price applies everywhere;
 * when branches genuinely differ, the per-branch breakdown is included.
 */
export function variantPriceInfo(
  variant: LoyverseVariant,
  targetStores: Store[],
): { price: number | null; branch_prices?: Record<string, number> } {
  const branchPrices = new Map<string, number>();
  for (const store of targetStores) {
    const info = variant.stores?.find((s) => s.store_id === store.id && s.available_for_sale);
    if (info && info.price != null) branchPrices.set(store.name, info.price);
  }
  const distinct = [...new Set(branchPrices.values())];
  if (distinct.length === 1) return { price: distinct[0] };
  if (distinct.length === 0) return { price: variant.default_price };
  return {
    price: variant.default_price,
    branch_prices: Object.fromEntries(branchPrices),
  };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9\s]/g, " "); // punctuation/dashes become word breaks
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = [...curr];
  }
  return prev[n];
}

/**
 * 0..1 similarity between one query term and one catalog word.
 * Exact and substring matches score highest; otherwise edit distance,
 * so typos like "brek" -> "brake" or "kalbarator" -> "carburetor" still match.
 */
function termSimilarity(term: string, word: string): number {
  if (word === term) return 1;
  // Containment bonuses only when the shorter string is meaningful (3+ chars) —
  // otherwise one-letter words like the "L"/"H" in "L/H" match everything.
  if (Math.min(term.length, word.length) >= 3) {
    if (word.startsWith(term) || term.startsWith(word)) return 0.95;
    if (word.includes(term) || term.includes(word)) return 0.9;
  }
  const dist = levenshtein(term, word);
  return 1 - dist / Math.max(term.length, word.length);
}

// A term must be at least this similar to some word in the item to count as a hit.
// Short words tolerate ~1 typo, longer words ~2-3.
const MIN_TERM_SCORE = 0.6;

/**
 * Typo-tolerant search across item names, descriptions, and variant SKUs.
 * Each query term is fuzzy-matched against the item's words; items where
 * every term found a close-enough word are ranked by overall similarity.
 * Only items sold at at least one target branch are returned.
 */
export async function searchProducts(query: string): Promise<LoyverseItem[]> {
  const [items, targetStores] = await Promise.all([getAllItems(), getTargetStores()]);
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: Array<{ item: LoyverseItem; score: number }> = [];
  for (const item of items) {
    if (!item.variants.some((v) => targetStores.some((s) => availableAtStore(v, s.id)))) {
      continue;
    }
    const words = normalize(
      [
        item.item_name,
        item.description ?? "",
        ...item.variants.flatMap((v) => [v.sku ?? "", v.option1_value ?? ""]),
      ].join(" "),
    )
      .split(/\s+/)
      .filter(Boolean);

    let total = 0;
    let allTermsHit = true;
    for (const term of terms) {
      let best = 0;
      for (const word of words) {
        const s = termSimilarity(term, word);
        if (s > best) best = s;
        if (best === 1) break;
      }
      if (best < MIN_TERM_SCORE) {
        allTermsHit = false;
        break;
      }
      total += best;
    }
    if (allTermsHit) scored.push({ item, score: total / terms.length });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 10) // keep tool results small
    .map((s) => s.item);
}

/**
 * Stock levels PER BRANCH for the given variant IDs, limited to the target
 * branches, with branch names resolved.
 */
export async function getStockLevels(
  variantIds: string[],
): Promise<Array<{ variant_id: string; branch: string; in_stock: number }>> {
  if (variantIds.length === 0) return [];
  const targetStores = await getTargetStores();
  const targetIds = new Set(targetStores.map((s) => s.id));
  const inventory = await loyverseGet<{ inventory_levels: InventoryLevel[] }>("/inventory", {
    variant_ids: variantIds.join(","),
    store_ids: targetStores.map((s) => s.id).join(","),
  });
  const storeName = new Map(targetStores.map((s) => [s.id, s.name]));
  return inventory.inventory_levels
    .filter((lvl) => targetIds.has(lvl.store_id))
    .map((lvl) => ({
      variant_id: lvl.variant_id,
      branch: storeName.get(lvl.store_id) ?? lvl.store_id,
      in_stock: lvl.in_stock,
    }));
}
