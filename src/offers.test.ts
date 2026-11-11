import { describe, expect, test } from "bun:test";
import { parseOffersPage } from "./offers";

// The shape Mercado Libre inlines in /p/MCO…/s pages, cut down to the parts the parser reads.
const summary = (promise: string, text = "{promise}") => ({
  state: "VISIBLE",
  title: { text, values: { promise: { text: promise } } },
});
const local = {
  id: "MCO2282455711",
  components: [
    { id: "price", price: { value: 159000, currency_id: "COP" } },
    { id: "shipping_summary", ...summary("Llega gratis", "{promise} entre el 27 y el 28/nov") },
    { id: "pick_up_summary", state: "HIDDEN" },
    { id: "condition_summary", title: { text: "Nuevo" } },
    {
      id: "seller",
      subtitles: [{ text: "MercadoLíder {font} +1000 ventas", values: { font: { text: "|" } } }],
      seller: { id: 315504023, name: "maujagroup", reputation_level: "5_green" },
      seller_info: {
        power_seller_status: { title: "MercadoLíder Gold" },
        store_type: "CLASSIC",
        extra_info: [{ title: "Garantía del vendedor", subtitle: "30 días." }],
      },
    },
    { id: "stock_information", state: "VISIBLE", title: { text: "Las fechas de entrega incluyen los 16 días necesarios." } },
  ],
};
const crossBorder = {
  id: "MCO2261208247",
  components: [
    { id: "price", price: { value: 145464, original_value: 167203.4, currency_id: "COP" }, discount_label: { value: 13 } },
    { id: "shipping_summary", ...summary("Llega gratis entre el 18/nov y el 30/nov") },
    { id: "condition_summary", title: { text: "Nuevo" } },
    { id: "seller", seller: { id: 1236358732, name: "NOCNOCEXCELLENCECOR" }, seller_info: { store_type: "OFFICIAL_STORE" } },
    { id: "stock_information", state: "HIDDEN" },
    { id: "cbt_summary", title: { text_icon: { description: "Internacional" } } },
    { id: "cbt_taxes_summary", state: "VISIBLE", title: { text: "Sin costos de importación" } },
  ],
};
const page = (items: unknown[], totalPages = 1) =>
  `<html><script>_n.ctx.r={"initialState":${JSON.stringify({
    components: { header: { title: "Protector GE 6 Salidas" }, results: { items, pager: { total_pages: totalPages } } },
  })}}</script></html>`;

describe("parseOffersPage", () => {
  test("reads each seller's offer so an agent can find the cheapest trustworthy one", () => {
    expect(parseOffersPage(page([local, crossBorder], 2))).toEqual({
      title: "Protector GE 6 Salidas",
      totalPages: 2,
      offers: [
        {
          id: "MCO2282455711",
          url: "https://articulo.mercadolibre.com.co/MCO-2282455711",
          price: 159000,
          condition: "new",
          seller: { id: 315504023, name: "maujagroup", mercadoLider: "gold", reputation: "5_green", sales: "+1000 ventas" },
          shipping: "Llega gratis entre el 27 y el 28/nov",
          warranty: "Garantía del vendedor: 30 días.",
          notice: "Las fechas de entrega incluyen los 16 días necesarios.",
        },
        {
          id: "MCO2261208247",
          url: "https://articulo.mercadolibre.com.co/MCO-2261208247",
          price: 145464,
          originalPrice: 167203,
          discountPct: 13,
          condition: "new",
          seller: { id: 1236358732, name: "NOCNOCEXCELLENCECOR", officialStore: true },
          shipping: "Llega gratis entre el 18/nov y el 30/nov",
          international: "Internacional · Sin costos de importación",
        },
      ],
    });
  });

  test("returns null for a page without an offers list", () => {
    expect(parseOffersPage("<html>Parece que esta página no existe</html>")).toBeNull();
  });
});
