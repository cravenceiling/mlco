// Pure parsing of a Mercado Libre item page (articulo…/MCO-…, /p/…, /up/…) into one listing's facts.
import { z } from "zod";
import { extractPageState, normalizeCondition, prune, wholePesos } from "./parse";
import { parseReviewHighlights, ReviewHighlights } from "./reviews";

export const ShippingOption = z.object({
  text: z.string().describe('e.g. "Llega el lunes", "Retira a partir del lunes en una agencia de Mercado Libre"'),
  cost: z.number().optional().describe("Integer COP; 0 when free. Absent when the page shows no price"),
  note: z.string().optional().describe('e.g. "Envío desde USA"'),
});

export const Seller = z.object({
  id: z.number().optional(),
  name: z.string(),
  officialStore: z.literal(true).optional(),
  mercadoLider: z.string().optional().describe("platinum, gold or silver"),
  reputation: z.string().optional().describe('Reputation thermometer, best is "5_green"'),
  sales: z.string().optional().describe('e.g. "+10 mil ventas"'),
});

export const Item = z.object({
  id: z.string().describe("Item id of the offer shown, which is the one asked for"),
  title: z.string(),
  url: z.string(),
  catalogProductId: z.string().optional(),
  condition: z.string().describe("new, used or refurbished"),
  variant: z.record(z.string(), z.string()).optional().describe('Selected variation, e.g. { "Color": "Azul" }'),
  price: z.number().describe("Cash price any buyer pays, integer COP; coupons and card-only discounts are not applied"),
  currency: z.string().optional().describe("Only present when the price is not in COP"),
  originalPrice: z.number().optional(),
  discountPct: z.number().optional(),
  installments: z.string().optional().describe("Only with include: installments"),
  stock: z.number().optional().describe("Units available"),
  sold: z.number().optional().describe("Units this listing has sold"),
  rating: z.number().optional(),
  reviews: z.number().optional(),
  seller: Seller,
  shipping: z.object({
    to: z.string().optional().describe("City of the signed-in session's address that the options are quoted for"),
    options: z.array(ShippingOption),
    full: z.literal(true).optional().describe("Stored and shipped by Mercado Libre (Full)"),
  }),
  otherOffers: z
    .string()
    .optional()
    .describe('Catalog pages: e.g. "2 productos nuevos desde $2.739.000"; get_offers lists them'),
  international: z
    .object({
      from: z.string().optional().describe("Seller location code, e.g. USTX01"),
      note: z.string().optional().describe("Usually says the price excludes import costs"),
    })
    .optional(),
  warranty: z.string().optional(),
  returns: z.string().optional(),
  specs: z.record(z.string(), z.string()).optional().describe("Technical specifications as label: value"),
  description: z.string().optional(),
  reviewHighlights: ReviewHighlights.optional().describe("Only with include: reviews"),
});
export type Item = z.infer<typeof Item>;

/** Optional sections of an item; specs and description are the bulk of it. */
export const ITEM_FIELDS = ["specs", "description", "reviews", "installments"] as const;
export const DEFAULT_ITEM_FIELDS = ["specs", "description", "reviews"] as const;
export type ItemField = (typeof ITEM_FIELDS)[number];

// The page state is loosely typed and shifts often; read it defensively.
type Json = any;

export const itemUrl = (id: string) => `https://articulo.mercadolibre.com.co/${id.replace(/^MCO/, "MCO-")}`;

/** Fill an item-page template like "{action} Tienes 30 días" from its `values` object. */
export function fill(t: Json): string | undefined {
  if (!t?.text) return undefined;
  const text = String(t.text).replace(/\{(\w+)\}/g, (_: string, key: string) => {
    const v = t.values?.[key];
    if (v?.type === "price") return `$${Number(v.value).toLocaleString("es-CO")}`;
    return v?.label?.text ?? v?.text ?? "";
  });
  return text.replace(/\s+/g, " ").trim() || undefined;
}

/** Plain text of a rich_text component; currency parts become `$n` and struck-through prices are dropped. */
function richText(comp: Json): { text: string; cost?: number } {
  let text = "";
  let cost: number | undefined;
  for (const part of comp?.parts ?? []) {
    if (part.type === "text") text += part.value;
    else if (part.type === "currency" && !part.previous) cost = part.price;
  }
  text = text.replace(/\s+/g, " ").trim();
  if (cost === undefined && /\bgratis\b/i.test(text)) cost = 0;
  // "gratis" is carried by cost; leave the delivery promise on its own.
  return { text: text.replace(/\s*\bgratis\b\s*/i, " ").trim(), cost };
}

function shippingOptions(section: Json) {
  return (section?.promises?.items ?? []).flatMap((item: Json) => {
    const comps: Json[] = item.components ?? [];
    const title = comps.find((c) => c.id === "title");
    if (!title) return [];
    const { text, cost } = richText(title);
    const note = richText(comps.find((c) => c.id === "subtitle")).text || undefined;
    return [{ text, cost, note }];
  });
}

/** The first `technical_specifications` component with specs, wherever the layout nests it. */
function findSpecs(node: Json): Json[] | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (node.type === "technical_specifications" && Array.isArray(node.specs) && node.specs.length) return node.specs;
  for (const v of Object.values(node)) {
    const found = findSpecs(v);
    if (found) return found;
  }
  return undefined;
}

function specsRecord(groups: Json[] | undefined): Record<string, string> | undefined {
  if (!groups) return undefined;
  const out: Record<string, string> = {};
  for (const g of groups) {
    for (const a of g.attributes ?? []) {
      const key = String(a.id ?? "").trim();
      if (key && a.text && !(key in out)) out[key] = a.text;
    }
  }
  return out;
}

function variant(c: Json): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const p of c.outside_variations?.pickers ?? []) {
    const label = p.label?.text?.replace(/:\s*$/, "");
    const value = p.selected_option?.text;
    if (label && value) out[label] = value;
  }
  return out;
}

function benefits(c: Json): string[] {
  return (c.buy_benefits?.benefits ?? []).map(fill).filter(Boolean);
}

/** Parse an item page, or return null when it holds no listing (removed, paused or not an item page). */
export function parseItemPage(html: string, include: readonly ItemField[] = DEFAULT_ITEM_FIELDS): Item | null {
  const state = extractPageState(html);
  const c: Json = state?.components;
  const track: Json = c?.track?.melidata_event?.event_data;
  if (!c?.price?.price || !track?.item_id) return null;

  const price = c.price.price;
  const seller = c.seller_summary?.seller ?? {};
  const sellerName = seller.name ?? track.seller_name;
  const destination = track.shipping_promise?.destination_data;
  const perks = benefits(c);
  const cbtNote = c.cbt_taxes_summary?.state === "VISIBLE" ? c.cbt_taxes_summary.title?.text : undefined;
  const isInternational = !!(track.is_cbt_fulfillment_us || track.is_cbt_fulfillment_cn || track.is_cbt_intralatam || cbtNote);
  const currency = price.currency_id ?? "COP";

  return prune({
    id: track.item_id,
    title: c.header?.title ?? "",
    url: itemUrl(track.item_id),
    catalogProductId: track.catalog_product_id?.startsWith?.("MCO") ? track.catalog_product_id : undefined,
    condition: normalizeCondition(track.item_condition),
    variant: variant(c),
    price: price.value,
    currency: currency === "COP" ? undefined : currency,
    originalPrice: wholePesos(price.original_value, currency),
    discountPct: c.price.discount_label?.value,
    installments: include.includes("installments") ? fill(c.price.subtitles?.[0]) : undefined,
    stock: c.available_quantity?.quantity_selector?.available_quantity ?? track.quantity,
    sold: track.sold_quantity,
    rating: c.header?.reviews?.rating,
    reviews: c.header?.reviews?.amount,
    seller: {
      id: seller.id ?? track.seller_id,
      name: sellerName ?? "",
      officialStore: c.seller_summary?.store_type === "OFFICIAL_STORE" ? (true as const) : undefined,
      mercadoLider: track.power_seller_status ?? undefined,
      reputation: seller.reputation_level ?? track.reputation_level,
      sales: (c.seller_summary?.subtitles ?? [])
        .map(fill)
        .find((t: string | undefined) => t?.includes("venta"))
        ?.replace(/^MercadoLíder \| /, ""),
    },
    shipping: {
      to: destination?.city?.name ? [destination.city.name, destination.state?.name].filter(Boolean).join(", ") : undefined,
      options: shippingOptions(c.shipping_section),
      full: track.logistic_type === "fulfillment" ? (true as const) : undefined,
    },
    otherOffers:
      c.others_products?.state === "VISIBLE"
        ? (c.others_products.products ?? []).map((p: Json) => fill(p.title)).filter(Boolean).join("; ")
        : undefined,
    international: isInternational ? { from: track.item_origins?.[0], note: cbtNote } : undefined,
    warranty: perks.find((t) => /garant[ií]a/i.test(t)),
    returns: perks.find((t) => /devoluci|devolver|d[ií]as desde que lo recibes/i.test(t)),
    specs: include.includes("specs") ? specsRecord(findSpecs(c)) : undefined,
    description: include.includes("description") ? c.description?.content?.trim() : undefined,
    reviewHighlights: include.includes("reviews") ? parseReviewHighlights(c.reviews_capability_v3) : undefined,
  }) as Item;
}
