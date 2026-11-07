import { describe, expect, test } from "bun:test";
import { parseItemPage } from "./item";
import { prune } from "./parse";
import { itemPageUrl } from "./search";

// The shape Mercado Libre inlines in item pages, cut down to the parts the parser reads.
const state = {
  components: {
    header: { title: "Lenovo Ideapad Slim 3 Ryzen 5 8640hs 24gb", reviews: { rating: 5, amount: 5 } },
    price: {
      price: { value: 2463703, original_value: 3999999, currency_id: "COP" },
      discount_label: { value: 38 },
      subtitles: [
        { text: "12 cuotas de {price_installments} con 0% interés", values: { price_installments: { type: "price", value: 205309 } } },
      ],
    },
    seller_summary: {
      store_type: "ESHOP",
      seller: { id: 173123818, name: "bytech", reputation_level: "5_green" },
      subtitles: [{ text: "MercadoLíder | {sales_amount}", values: { sales_amount: { text: "+10 mil ventas" } } }],
    },
    available_quantity: { quantity_selector: { available_quantity: 6 } },
    outside_variations: { pickers: [{ label: { text: "Color:" }, selected_option: { text: "Azul" } }] },
    shipping_section: {
      promises: {
        items: [
          {
            id: "address_0",
            components: [
              {
                id: "title",
                parts: [
                  { type: "text", value: "Llega el lunes " },
                  { type: "text", value: "gratis" },
                  { type: "currency", previous: true, price: 13779 },
                  { type: "currency", price: 0 },
                ],
              },
            ],
          },
        ],
      },
    },
    buy_benefits: {
      benefits: [
        { text: "{action} Tienes 30 días desde que lo recibes.", values: { action: { label: { text: "Devolución gratis." } } } },
        { text: "12 meses de garantía de fábrica." },
      ],
    },
    highlighted_specs_attrs: {
      components: [
        {
          type: "technical_specifications",
          specs: [{ attributes: [{ id: "Modelo alfanumérico ", text: "15AHP10" }, { id: "Memoria RAM", text: "24 GB" }] }],
        },
      ],
    },
    description: { content: "  Garantía de fábrica: 12 meses\n" },
    cbt_taxes_summary: { state: "HIDDEN" },
    track: {
      melidata_event: {
        event_data: {
          item_id: "MCO4097589348",
          catalog_product_id: "MCO77830378",
          item_condition: "new",
          sold_quantity: 5,
          power_seller_status: "platinum",
          logistic_type: "cross_docking",
          shipping_promise: { destination_data: { city: { name: "Pasto" }, state: { name: "Nariño" } } },
        },
      },
    },
  },
};
const page = (s: unknown) => `<html><script id="__NORDIC_RENDERING_CTX__">_n.ctx.r={"initialState":${JSON.stringify(s)}}</script></html>`;

describe("parseItemPage", () => {
  test("reads the buy box an agent needs to compare offers", () => {
    expect(parseItemPage(page(state), [])).toEqual({
      id: "MCO4097589348",
      title: "Lenovo Ideapad Slim 3 Ryzen 5 8640hs 24gb",
      url: "https://articulo.mercadolibre.com.co/MCO-4097589348",
      catalogProductId: "MCO77830378",
      condition: "new",
      variant: { Color: "Azul" },
      price: 2463703,
      originalPrice: 3999999,
      discountPct: 38,
      stock: 6,
      sold: 5,
      rating: 5,
      reviews: 5,
      seller: { id: 173123818, name: "bytech", mercadoLider: "platinum", reputation: "5_green", sales: "+10 mil ventas" },
      shipping: { to: "Pasto, Nariño", options: [{ text: "Llega el lunes", cost: 0 }] },
      warranty: "12 meses de garantía de fábrica.",
      returns: "Devolución gratis. Tienes 30 días desde que lo recibes.",
    });
  });

  test("adds the optional sections only when asked", () => {
    const item = parseItemPage(page(state), ["specs", "description", "installments"]);
    expect(item?.specs).toEqual({ "Modelo alfanumérico": "15AHP10", "Memoria RAM": "24 GB" });
    expect(item?.description).toBe("Garantía de fábrica: 12 meses");
    expect(item?.installments).toBe("12 cuotas de $205.309 con 0% interés");
  });

  test("flags cross-border listings and their import-cost note", () => {
    const cbt = structuredClone(state);
    cbt.components.cbt_taxes_summary = { state: "VISIBLE", title: { text: "El precio no incluye los costos de importación." } } as never;
    Object.assign(cbt.components.track.melidata_event.event_data, { is_cbt_fulfillment_us: true, item_origins: ["USTX01"], logistic_type: "fulfillment" });
    const item = parseItemPage(page(cbt), []);
    expect(item?.international).toEqual({ from: "USTX01", note: "El precio no incluye los costos de importación." });
    expect(item?.shipping.full).toBe(true);
  });

  test("returns null for a page without a listing", () => {
    expect(parseItemPage("<html>Parece que esta página no existe</html>")).toBeNull();
  });
});

describe("itemPageUrl", () => {
  test("accepts item ids and Mercado Libre URLs", () => {
    expect(itemPageUrl("MCO4097589348")).toBe("https://articulo.mercadolibre.com.co/MCO-4097589348");
    expect(itemPageUrl(" mco-4097589348 ")).toBe("https://articulo.mercadolibre.com.co/MCO-4097589348");
    expect(itemPageUrl("https://www.mercadolibre.com.co/p/MCO53607728")).toBe("https://www.mercadolibre.com.co/p/MCO53607728");
  });

  test("refuses other hosts, since the browser carries the user's session", () => {
    expect(() => itemPageUrl("https://example.com/MCO-1")).toThrow(RangeError);
    expect(() => itemPageUrl("https://mercadolibre.com.co.evil.com/x")).toThrow(RangeError);
    expect(() => itemPageUrl("http://articulo.mercadolibre.com.co/MCO-4097589348")).toThrow(RangeError);
    expect(() => itemPageUrl("nope")).toThrow(RangeError);
  });
});

test("prune drops empty values but keeps zero", () => {
  expect(prune<unknown>({ a: null, b: false, c: [], d: {}, e: "", f: 0, g: { h: undefined, i: 1 } })).toEqual({ f: 0, g: { i: 1 } });
});
