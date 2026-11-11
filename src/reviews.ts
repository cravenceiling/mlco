// Pure parsing of Mercado Libre product reviews: the block on item pages and the reviews JSON endpoint.
import { z } from "zod";
import { prune } from "./parse";

export const Review = z.object({
  rating: z.number().describe("1 to 5 stars"),
  text: z.string().optional().describe("Absent for rating-only reviews"),
  date: z.string().optional().describe("YYYY-MM-DD"),
  likes: z.number().optional().describe('Buyers who marked it "Útil"'),
  variant: z.string().optional().describe("Variant the reviewer bought, when the listing has variants"),
});
export type Review = z.infer<typeof Review>;

export const ReviewHighlights = z.object({
  summary: z.string().optional().describe("Mercado Libre's AI-generated summary of all reviews"),
  stars: z.record(z.string(), z.number()).optional().describe('Ratings per star, including ratings without text, e.g. { "1": 0, "2": 0, "3": 1, "4": 2, "5": 29 }'),
  top: z
    .array(Review)
    .optional()
    .describe("The most useful reviews the page shows, at most 5; get_reviews returns more"),
});
export type ReviewHighlights = z.infer<typeof ReviewHighlights>;

/** Reviews per request; the endpoint answers 400 to anything larger. */
export const REVIEWS_PAGE_SIZE = 15;
export const REVIEW_SORTS = { relevance: "", newest: "dateCreated" } as const;
export type ReviewSort = keyof typeof REVIEW_SORTS;

// Review JSON is loosely typed and shifts often; read it defensively.
type Json = any;

/** First value under `key` anywhere in `node`; the review's creation date only appears inside tracking data. */
function deepFind(node: Json, key: string): Json {
  if (!node || typeof node !== "object") return undefined;
  if (key in node) return node[key];
  for (const v of Object.values(node)) {
    const found = deepFind(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function parseReview(r: Json): Review {
  const created = deepFind(r, "created_date");
  return prune({
    rating: r.rating,
    text: r.comment?.content?.text?.trim(),
    date: typeof created === "string" ? created.slice(0, 10) : undefined,
    likes: r.actions?.find((a: Json) => a.id === "LIKE")?.value || deepFind(r, "count_likes") || undefined,
    variant: r.variant,
  });
}

/** The reviews block of an item page: AI summary, star histogram and the top reviews it shows. */
export function parseReviewHighlights(block: Json): ReviewHighlights | undefined {
  if (block?.state !== "VISIBLE") return undefined;
  const levels: Json[] = block.rating?.levels ?? [];
  const summary = block.summary?.components?.find((c: Json) => c.id === "SUMMARY")?.summary_text?.text;
  return prune({
    summary,
    // levels[0] is 5 stars.
    stars: levels.length ? Object.fromEntries(levels.map((l, i) => [String(5 - i), l.value ?? 0])) : undefined,
    top: (block.reviews ?? []).map(parseReview),
  }) as ReviewHighlights;
}

export function reviewsUrl(
  objectId: string,
  isItem: boolean,
  o: { offset: number; rating?: number; sort?: ReviewSort },
): string {
  const params = new URLSearchParams({
    objectId,
    siteId: "MCO",
    isItem: String(isItem),
    offset: String(o.offset),
    limit: String(REVIEWS_PAGE_SIZE),
  });
  if (o.rating) params.set("rating", String(o.rating));
  if (o.sort && REVIEW_SORTS[o.sort]) params.set("order", REVIEW_SORTS[o.sort]);
  return `https://www.mercadolibre.com.co/noindex/catalog/reviews/${objectId}/search?${params}`;
}
