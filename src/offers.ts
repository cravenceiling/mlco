// Pure parsing of a catalog product's offers page (www.mercadolibre.com.co/p/MCO…/s): every seller of one product.
import { z } from "zod";
import { fill, itemUrl, Seller } from "./item";
import { extractPageState, normalizeCondition, prune, wholePesos } from "./parse";

export const Offer = z.object({
  id: z.string().describe("Item id of this seller's listing; pass it to get_items for stock, specs and reviews"),
  url: z.string(),
  price: z.number().describe("Cash price, integer COP; coupons and card-only discounts are not applied"),
  currency: z.string().optional().describe("Only present when the price is not in COP"),
  originalPrice: z.number().optional(),
  discountPct: z.number().optional(),
  condition: z.string().describe("new, used or refurbished"),
  seller: Seller,
  shipping: z.string().optional().describe('Quoted for the signed-in address, e.g. "Llega gratis mañana · Retira gratis …"'),
  international: z
    .string()
    .optional()
    .describe('Cross-border offer and its import-cost note, e.g. "Internacional · Sin costos de importación"'),
  warranty: z.string().optional().describe('e.g. "Garantía del vendedor: 30 días."'),
  notice: z.string().optional().describe('Seller notice such as "Las fechas de entrega incluyen los 16 días necesarios…"'),
});
export type Offer = z.infer<typeof Offer>;

export type OffersPage = { title?: string; totalPages: number; offers: Offer[] };

/** Offers per page on Mercado Libre's offers list. */
export const OFFERS_PAGE_SIZE = 10;

// The page state is loosely typed and shifts often; read it defensively.
type Json = any;

function toOffer(result: Json): Offer {
  const c: Record<string, Json> = Object.fromEntries((result.components ?? []).map((x: Json) => [x.id, x]));
  const price = c.price?.price ?? {};
  const seller = c.seller ?? {};
  const info = seller.seller_info ?? {};
  const visible = (x: Json) => (x && x.state !== "HIDDEN" ? fill(x.title) : undefined);
  const currency = price.currency_id ?? "COP";
  const cbt = c.cbt_summary && c.cbt_summary.state !== "HIDDEN";
  const warranty = (info.extra_info ?? []).find((e: Json) => /garant[ií]a/i.test(e.title ?? ""));
  return prune({
    id: result.id,
    url: itemUrl(result.id),
    price: price.value,
    currency: currency === "COP" ? undefined : currency,
    originalPrice: wholePesos(price.original_value, currency),
    discountPct: c.price?.discount_label?.value,
    condition: normalizeCondition(c.condition_summary?.title?.text),
    seller: {
      id: seller.seller?.id,
      name: seller.seller?.name ?? seller.title_value ?? "",
      officialStore: info.store_type === "OFFICIAL_STORE" ? (true as const) : undefined,
      // "MercadoLíder Gold" -> "gold", matching get_items.
      mercadoLider: info.power_seller_status?.title?.split(" ").at(-1)?.toLowerCase(),
      reputation: seller.seller?.reputation_level,
      sales: (seller.subtitles ?? [])
        .map(fill)
        .find((t: string | undefined) => t?.includes("venta"))
        ?.replace(/^MercadoLíder \| /, ""),
    },
    shipping: [visible(c.shipping_summary), visible(c.pick_up_summary)].filter(Boolean).join(" · "),
    international: cbt
      ? [c.cbt_summary.title?.text_icon?.description ?? "Internacional", visible(c.cbt_taxes_summary)].filter(Boolean).join(" · ")
      : undefined,
    warranty: warranty ? `${warranty.title}: ${warranty.subtitle ?? ""}`.trim() : undefined,
    notice: visible(c.stock_information),
  }) as Offer;
}

/** Parse one page of a product's offers, or return null when the page holds no offers list. */
export function parseOffersPage(html: string): OffersPage | null {
  const components = extractPageState(html)?.components;
  const results = components?.results;
  if (!Array.isArray(results?.items)) return null;
  return {
    title: components.header?.title,
    totalPages: results.pager?.total_pages ?? 1,
    offers: results.items.map(toOffer),
  };
}
