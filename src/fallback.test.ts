import { expect, test } from "bun:test";
import { parseSearchPage } from "./parse";

// A search results state cut down to the parts the parser reads.
const card = (id: string) => ({
  id: "POLYCARD",
  polycard: {
    metadata: { id },
    components: [
      { type: "title", title: { text: `Multitoma ${id}` } },
      { type: "price", price: { current_price: { value: 50000 } } },
    ],
  },
});
const page = (total: number, results: unknown[]) =>
  `<html><script>_n.ctx.r={"initialState":${JSON.stringify({ melidata_track: { event_data: { total } }, results })}}</script></html>`;

test("a search with matches returns them", () => {
  const parsed = parseSearchPage(page(33, [card("MCO1"), card("MCO2")]));
  expect(parsed?.products.map((p) => p.id)).toEqual(["MCO1", "MCO2"]);
  expect(parsed?.notice).toBeUndefined();
});

test("related listings shown under a total of 0 are left out", () => {
  const parsed = parseSearchPage(page(0, [card("MCO1"), card("MCO2"), card("MCO3")]));
  expect(parsed).toMatchObject({ products: [], total: 0 });
  expect(parsed?.notice).toContain("No listing matches");
});

test("listings shown after Mercado Libre drops a requested filter are left out", () => {
  const banner = {
    id: "ZRP_DISCLAIMER_COMPONENT",
    title: { all_text: 'No encontramos "Multitoma supresor de picos" en Full' },
    subtitle: { all_text: "Te mostramos publicaciones de otros vendedores." },
  };
  const parsed = parseSearchPage(page(43, [banner, card("MCO1"), card("MCO2")]));
  expect(parsed).toMatchObject({ products: [], total: 0 });
  expect(parsed?.notice).toContain('No encontramos "Multitoma supresor de picos" en Full');
});
