import { describe, expect, test } from "bun:test";
import { parseReview, parseReviewHighlights, reviewsUrl } from "./reviews";

// A review as both the item page and the reviews endpoint send it, cut down to the parts the parser reads.
const review = {
  id: 2237435575,
  variant: "",
  rating: 2,
  comment: { content: { text: "Dejó de funcionar.\n A los 3 meses " }, date: "Hace 1 año" },
  actions: [{ id: "LIKE", value: 4 }],
  menu_options: { items: [{ track: { event_data: { review: { created_date: "2025-08-06T04:30:20Z", count_likes: 4 } } } }] },
};

describe("reviews", () => {
  test("parseReview keeps rating, text, date and likes", () => {
    expect(parseReview(review)).toEqual({ rating: 2, text: "Dejó de funcionar.\n A los 3 meses", date: "2025-08-06", likes: 4 });
    expect(parseReview({ rating: 5, comment: { content: { text: "" } } })).toEqual({ rating: 5 });
  });

  test("parseReviewHighlights reads the summary, star histogram and top reviews", () => {
    const block = {
      state: "VISIBLE",
      rating: { average: 4.9, amount: 31, levels: [{ value: 29 }, { value: 2 }, { value: 0 }, { value: 0 }, { value: 0 }] },
      summary: { components: [{ id: "SUMMARY", summary_text: { text: "Funciona muy bien." } }, { id: "SUMMARY_DESCRIPTION" }] },
      reviews: [review],
    };
    expect(parseReviewHighlights(block)).toEqual({
      summary: "Funciona muy bien.",
      stars: { "5": 29, "4": 2, "3": 0, "2": 0, "1": 0 },
      top: [{ rating: 2, text: "Dejó de funcionar.\n A los 3 meses", date: "2025-08-06", likes: 4 }],
    });
    expect(parseReviewHighlights({ state: "HIDDEN" })).toBeUndefined();
    expect(parseReviewHighlights({ state: "VISIBLE", rating: { levels: [{ value: 3 }] }, reviews: [] })).toEqual({ stars: { "5": 3 } });
  });

  test("reviewsUrl asks for one filtered, sorted page", () => {
    const url = new URL(reviewsUrl("MCO37690980", false, { offset: 15, rating: 1, sort: "newest" }));
    expect(url.pathname).toBe("/noindex/catalog/reviews/MCO37690980/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      objectId: "MCO37690980",
      siteId: "MCO",
      isItem: "false",
      offset: "15",
      limit: "15",
      rating: "1",
      order: "dateCreated",
    });
  });
});
