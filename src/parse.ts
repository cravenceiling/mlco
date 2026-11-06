// Pure parsing of a listado.mercadolibre.com.co search page into products.
import { z } from "zod";

export const Product = z.object({
  id: z.string(),
  title: z.string(),
  price: z.number().describe("Current price, integer COP"),
  currency: z.string(),
  originalPrice: z.number().nullable().describe("Pre-discount price when the card shows one"),
  discountPct: z.number().nullable(),
  installments: z.string().nullable(),
  seller: z.string().nullable(),
  officialStore: z.boolean(),
  rating: z.number().nullable(),
  sold: z.string().nullable().describe('e.g. "+100 vendidos"'),
  condition: z.string().describe('"Nuevo" unless the card says otherwise'),
  shipping: z.string().nullable(),
  freeShipping: z.boolean(),
  international: z.string().nullable(),
  promotions: z.array(z.string()),
  purchaseOptions: z.string().nullable().describe('Catalog cards: "3 opciones de compra"; price is the cheapest'),
  catalogProductId: z.string().nullable(),
  url: z.string(),
  image: z.string().nullable(),
});
export type Product = z.infer<typeof Product>;

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
 * Pull the search state out of the page. Signed-in pages stream it as `optimizedResponse` inside
 * `_n.ctx.s["nr"].q("…")`; signed-out pages inline it as `initialState` in `_n.ctx.r = {…}`.
 */
export function extractSearchState(html: string): Json | null {
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
function objectAfter(s: string, key: string): Json {
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

/** Render a polycard template like "{icon} {label} {label2}" to plain text. */
function templateText(c: Json): string | null {
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
  const shipping = (comps.shipping_v2 ?? []).map((s: Json) => s.alt_text || templateText(s)).filter(Boolean).join(" · ") || null;
  const pictureId = card.pictures?.pictures?.[0]?.id;
  return {
    id: meta.id || meta.product_id || meta.user_product_id,
    title: comps.title.text,
    price: price.current_price.value,
    currency: price.current_price.currency ?? "COP",
    originalPrice: previous ?? null,
    discountPct: price.discount_pct ?? null,
    installments: templateText(price.installments),
    seller: templateText(comps.seller),
    officialStore: !!comps.seller?.text?.includes("icon_cockade"),
    rating: rating ? Number(rating) : null,
    sold: sold?.replace(/^[\s|]+/, "") ?? null,
    condition: comps.item_condition?.text ?? "Nuevo",
    shipping,
    freeShipping: !!shipping?.toLowerCase().includes("gratis"),
    international: comps.cbt?.alt_text ?? null,
    promotions: (comps.promotions ?? []).map((p: Json) => p.text),
    purchaseOptions: comps.purchase_options?.text ?? null,
    catalogProductId: meta.product_id ?? null,
    url: shortUrl(meta),
    image: pictureId ? PICTURE(pictureId) : null,
  };
}

export function parseSearchPage(html: string): SearchPage | null {
  const state = extractSearchState(html);
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
