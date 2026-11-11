// Pure parsing of a listado.mercadolibre.com.co search page into products.
import { z } from "zod";

export const Product = z.object({
  id: z.string(),
  title: z.string(),
  price: z.number().describe("Current cash price, integer COP; coupons and card-only discounts are not applied"),
  currency: z.string().optional().describe("Only present when the price is not in COP"),
  originalPrice: z.number().optional().describe("Pre-discount price when the card shows one"),
  discountPct: z.number().optional(),
  condition: z.string().describe("new, used or refurbished"),
  officialStore: z
    .string()
    .optional()
    .describe("Official store name. Search pages name no other sellers; get_items returns the seller of any listing"),
  rating: z.number().optional(),
  sold: z.number().optional().describe('Units sold, a lower bound: the card shows "+100 vendidos"'),
  shipping: z.string().optional().describe('e.g. "Envío gratis"'),
  international: z.string().optional().describe('Cross-border listing, e.g. "Internacional USA"'),
  promotions: z.array(z.string()).optional(),
  purchaseOptions: z.string().optional().describe('Catalog cards: "3 opciones de compra"; price is the cheapest'),
  catalogProductId: z.string().optional(),
  installments: z.string().optional().describe("Only with include: installments"),
  image: z.string().optional().describe("Only with include: image"),
  url: z.string(),
});
export type Product = z.infer<typeof Product>;

/** Card fields left out unless asked for: rarely useful to an agent, and they cost tokens on every listing. */
export const EXTRA_FIELDS = ["installments", "image"] as const;
export type ExtraField = (typeof EXTRA_FIELDS)[number];

export type SearchPage = {
  products: Product[];
  /** Listings that could not be read, usually because Mercado Libre changed a card's shape. */
  skipped: number;
  total: number | null;
  lastPage: number;
};

// Polycard JSON is loosely typed and shifts often; read it defensively.
type Json = any;

const PICTURE = (id: string) => `https://http2.mlstatic.com/D_Q_NP_${id}-O.webp`;
const cop = (n: number) => `$${n.toLocaleString("es-CO")}`;

/**
 * Pull the page state out of a search or item page. Signed-in search pages stream it as `optimizedResponse`
 * inside `_n.ctx.s["nr"].q("…")`; other pages inline it as `initialState` in `_n.ctx.r = {…}`.
 */
export function extractPageState(html: string): Json | null {
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    if (script!.includes("optimizedResponse") && script!.includes('q("')) {
      const raw = script!.slice(script!.indexOf('q("') + 3, script!.lastIndexOf('")'));
      // The payload is JSON plus `u` (undefined) tokens and `@n` back-refs past optimizedResponse.
      const payload: string = JSON.parse(`"${raw}"`).replace(/(?<=[:,[])u(?=[,}\]])/g, "null");
      return objectAfter(payload, '"optimizedResponse"');
    }
    if (script!.startsWith("_n.ctx.r=") && script!.includes('"initialState"')) {
      return objectAfter(script!, '"initialState"');
    }
  }
  return null;
}

/** Parse the JSON object that follows `key` in `s`. */
export function objectAfter(s: string, key: string): Json {
  const start = s.indexOf("{", s.indexOf(key));
  return JSON.parse(s.slice(start, matchingBrace(s, start) + 1));
}

/** Index of the brace closing the object that opens at `start`, skipping string contents. */
function matchingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  throw new Error("Unterminated search payload");
}

/** Map Mercado Libre's condition label ("Nuevo", "Usado", "Reacondicionado") to the `condition` filter's words. */
export function normalizeCondition(text: string | undefined): string {
  if (!text || /nuevo|^new$/i.test(text)) return "new";
  if (/usado|^used$/i.test(text)) return "used";
  if (/reacondicionado|refurbished/i.test(text)) return "refurbished";
  return text.toLowerCase();
}

/**
 * Drop keys whose value is null, undefined, false, "" or an empty array/object, recursively.
 * Agents pay for every token, so absent data stays absent instead of spelled out as null.
 */
export function prune<T>(value: T): T {
  if (Array.isArray(value)) return value.map(prune) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      const empty =
        p == null || p === false || p === "" || (typeof p === "object" && Object.keys(p as object).length === 0);
      if (!empty) out[k] = p;
    }
    return out as T;
  }
  return value;
}

/** Some previous prices carry centavos (51109.01) although COP prices are whole pesos; other currencies keep theirs. */
export function wholePesos(value: number | null | undefined, currency: string): number | undefined {
  if (value == null) return undefined;
  return currency === "COP" ? Math.round(value) : value;
}

/** Leave out the extra card fields the caller did not ask for. */
export function withExtras(p: Product, include: readonly ExtraField[] = []): Product {
  const out = { ...p };
  for (const f of EXTRA_FIELDS) if (!include.includes(f)) delete out[f];
  return out;
}

/** Render a polycard template like "{icon} {label} {label2}" to plain text. */
export function templateText(c: Json): string | null {
  if (!c) return null;
  let text: string = c.text ?? "";
  for (const v of c.values ?? []) {
    const label = v.type === "price" ? cop(v.price.value) : (v.label?.text ?? v.pill?.text ?? "");
    text = text.replace(`{${v.key}}`, label);
  }
  return text.replace(/\{[^}]*\}/g, "").replace(/^[\s|]+|[\s|]+$/g, "") || null;
}

/**
 * Short canonical link. The full slugged URLs run 140+ chars and get cut when a terminal wraps them,
 * and a truncated id lands on ML's "Parece que esta página no existe". The item link also pins the
 * exact offer seen in search rather than whichever seller wins the catalog buy box.
 */
function shortUrl(meta: Json): string {
  if (meta.id) return `https://articulo.mercadolibre.com.co/${meta.id.replace(/^MCO/, "MCO-")}`;
  if (meta.product_id) return `https://www.mercadolibre.com.co/p/${meta.product_id}`;
  return `https://${meta.url}`;
}

export function toProduct(card: Json): Product {
  const meta = card.metadata;
  const comps: Record<string, Json> = Object.fromEntries(card.components.map((c: Json) => [c.type, c[c.type]]));
  const price = comps.price ?? {};
  const previous = (price.price_labels ?? [])
    .flatMap((l: Json) => l.values ?? [])
    .find((v: Json) => v.key === "previous_price")?.price?.value;
  const reviewLabels: string[] = (comps.review_compacted?.values ?? [])
    .filter((v: Json) => v.type === "label")
    .map((v: Json) => v.label.text);
  const rating = reviewLabels.find((t) => /^\d(\.\d)?$/.test(t));
  const sold = reviewLabels.find((t) => t.includes("vendido"));
  // "+50 vendidos", "+5mil vendidos", "+1,5 mil vendidos", "+1M vendidos": dots group thousands, a comma marks
  // decimals.
  const soldCount = sold && /([\d.,]+)\s*(?:(mil|m)\b)?/i.exec(sold);
  const soldUnit = !soldCount?.[2] ? 1 : soldCount[2].toLowerCase() === "m" ? 1e6 : 1e3;
  const shipping = (comps.shipping_v2 ?? []).map((s: Json) => s.alt_text || templateText(s)).filter(Boolean).join(" · ") || undefined;
  const currency = price.current_price.currency ?? "COP";
  const pictureId = card.pictures?.pictures?.[0]?.id;
  // Search cards only carry a seller component for official stores.
  const officialStore = comps.seller?.text?.includes("icon_cockade") ? (templateText(comps.seller) ?? undefined) : undefined;
  return prune({
    id: meta.id || meta.product_id || meta.user_product_id,
    title: comps.title.text,
    price: price.current_price.value,
    currency: currency === "COP" ? undefined : currency,
    originalPrice: wholePesos(previous, currency),
    discountPct: price.discount_pct,
    condition: normalizeCondition(comps.item_condition?.text),
    officialStore,
    rating: rating ? Number(rating) : undefined,
    sold: soldCount
      ? Math.round(Number(soldCount[1]!.replace(/\./g, "").replace(",", ".")) * soldUnit)
      : undefined,
    shipping,
    international: comps.cbt?.alt_text,
    promotions: (comps.promotions ?? []).map((p: Json) => p.text),
    purchaseOptions: comps.purchase_options?.text,
    catalogProductId: meta.product_id,
    installments: templateText(price.installments) ?? undefined,
    image: pictureId ? PICTURE(pictureId) : undefined,
    url: shortUrl(meta),
  });
}

export function parseSearchPage(html: string): SearchPage | null {
  const state = extractPageState(html);
  if (!state) return null;
  // Skip sponsored cards and anything that is not a priced listing.
  const listings = (state.results ?? [])
    .map((r: Json) => r.polycard)
    .filter((c: Json) => c && c.metadata?.is_pad !== "true" && c.components?.some((x: Json) => x.type === "price"));
  const products: Product[] = [];
  let skipped = 0;
  for (const card of listings) {
    // One unexpected card should cost that listing, not the whole search.
    try {
      const parsed = Product.safeParse(toProduct(card));
      if (parsed.success) products.push(parsed.data);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return {
    products,
    skipped,
    total: state.melidata_track?.event_data?.total ?? null,
    lastPage: state.pagination?.last_page ?? 1,
  };
}
