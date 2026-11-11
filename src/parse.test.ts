import { expect, test } from "bun:test";
import { toProduct } from "./parse";

// A search polycard cut down to the parts the parser reads.
const card = (sold: string) => ({
  metadata: { id: "MCO4173603150" },
  components: [
    { type: "title", title: { text: "Multitoma De Pared 10 En 1" } },
    {
      type: "price",
      price: {
        current_price: { value: 28808, currency: "COP" },
        discount_pct: 43,
        price_labels: [{ values: [{ key: "previous_price", price: { value: 51109.01 } }] }],
      },
    },
    { type: "review_compacted", review_compacted: { values: [{ type: "label", label: { text: "4.8" } }, { type: "label", label: { text: sold } }] } },
  ],
});

test("search cards give sold as a number and prices as whole pesos", () => {
  expect(toProduct(card("| +5mil vendidos"))).toMatchObject({ price: 28808, originalPrice: 51109, rating: 4.8, sold: 5000 });
  expect(toProduct(card("+1000 vendidos")).sold).toBe(1000);
  expect(toProduct(card("1 vendido")).sold).toBe(1);
  expect(toProduct(card("+1,5 mil vendidos")).sold).toBe(1500);
  expect(toProduct(card("+1M vendidos")).sold).toBe(1_000_000);
});
