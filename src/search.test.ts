import { describe, expect, test } from "bun:test";
import { buildUrl, catalogProductId, reviewsObjectId } from "./search";

describe("ids", () => {
  test("catalogProductId takes an id or a /p/ URL", () => {
    expect(catalogProductId(" mco37690980 ")).toBe("MCO37690980");
    expect(catalogProductId("https://www.mercadolibre.com.co/protector/p/MCO37690980?pdp_filters=item_id:MCO4545219112")).toBe(
      "MCO37690980",
    );
    expect(() => catalogProductId("https://articulo.mercadolibre.com.co/MCO-4545219112")).toThrow(RangeError);
  });

  test("reviewsObjectId takes product ids, item ids and listing URLs", () => {
    expect(reviewsObjectId("MCO-613230301")).toBe("MCO613230301");
    expect(reviewsObjectId("https://articulo.mercadolibre.com.co/MCO-613230301-regleta-_JM")).toBe("MCO613230301");
    expect(reviewsObjectId("https://www.mercadolibre.com.co/funda-mco123456/p/MCO37690980?pdp_filters=item_id:MCO4545219112")).toBe(
      "MCO37690980",
    );
    expect(() => reviewsObjectId("nope")).toThrow(RangeError);
  });
});

test("buildUrl adds the origin, store, Full and MercadoLíder filters", () => {
  expect(buildUrl("regleta", 1, { origin: "local", officialStore: true, full: true, bestSellers: true })).toBe(
    "https://listado.mercadolibre.com.co/regleta_Envio_Full_Tienda_all_BestSellers_YES_SHIPPING*ORIGIN_10215068_NoIndex_True",
  );
  expect(buildUrl("regleta", 1, { origin: "international" })).toBe(
    "https://listado.mercadolibre.com.co/regleta_SHIPPING*ORIGIN_10215069_NoIndex_True",
  );
});
