import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import type { CookieOptions } from "./cookies";
import { Item, ITEM_FIELDS } from "./item";
import { EXTRA_FIELDS, Product, withExtras } from "./parse";
import { BlockedError, CONDITIONS, MAX_ITEMS, MAX_LIMIT, SORTS, Session, type Condition, type Sort } from "./search";

const IDLE_MS = 5 * 60_000;

/** Structured result plus the same JSON, unindented, for clients that only read text. */
const ok = <T extends Record<string, unknown>>(result: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  structuredContent: result,
});

const fail = (e: unknown) => {
  if (e instanceof BlockedError || e instanceof RangeError) return { isError: true, content: [{ type: "text" as const, text: e.message }] };
  throw e;
};

export async function serve(cookieOptions: CookieOptions) {
  // One warm browser shared by all calls; closed after 5 idle minutes.
  const session = new Session(cookieOptions, IDLE_MS);
  const server = new McpServer({ name: "mercadolibre-co", version: pkg.version });

  server.registerTool(
    "search_products",
    {
      title: "Search Mercado Libre Colombia",
      description:
        "Search mercadolibre.com.co and return listings with cash price (integer COP), discount, condition, official " +
        "store, rating, units sold, shipping and URL. Ads are excluded and empty fields are omitted. Search cards do " +
        "not name ordinary sellers or show stock, warranty or specs: pass the ids you want to compare to get_items. " +
        `48 results per page; a limit above 48 fetches more pages, a few seconds each (at most ${MAX_LIMIT}). ` +
        "Sorting by price_asc surfaces cheap accessories (cases, cables); set min_price to skip them.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(48),
        sort: z.enum(Object.keys(SORTS) as [Sort, ...Sort[]]).default("relevance"),
        min_price: z.number().int().positive().optional(),
        max_price: z.number().int().positive().optional(),
        condition: z.enum(Object.keys(CONDITIONS) as [Condition, ...Condition[]]).optional(),
        free_shipping: z.boolean().default(false),
        include: z
          .array(z.enum(EXTRA_FIELDS))
          .optional()
          .describe("Extra fields left out by default: installments (financing text), image (picture URL)"),
      },
      outputSchema: {
        query: z.string(),
        url: z.string(),
        total: z.number().nullable(),
        products: z.array(Product),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const result = await session.search(a.query, {
          limit: a.limit,
          sort: a.sort,
          minPrice: a.min_price,
          maxPrice: a.max_price,
          condition: a.condition,
          freeShipping: a.free_shipping,
        });
        return ok({ ...result, products: result.products.map((p) => withExtras(p, a.include)) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_items",
    {
      title: "Open Mercado Libre Colombia listings",
      description:
        "Open up to 10 listings and return what search cards leave out: the seller with MercadoLíder level, " +
        "reputation and sales; stock and units sold; shipping options and cost quoted for the signed-in user's " +
        "address (shipping.to names the city); warranty; returns; cross-border import-cost notes; the selected " +
        "variant; technical specs and the seller's description. price is the cash price any buyer pays, without " +
        "coupons or card offers. Takes item ids or mercadolibre.com.co URLs, such as search_products results. " +
        'Pass include: [] for just the buy box (about 700 characters per listing); "specs" and "description" add ' +
        "1–4 KB each. A listing that cannot be read is reported in errors without failing the others.",
      inputSchema: {
        items: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_ITEMS)
          .describe("Item ids like MCO4097589348 or https://…mercadolibre.com.co URLs"),
        include: z
          .array(z.enum(ITEM_FIELDS))
          .default(["specs", "description"])
          .describe("Optional sections: specs, description, installments (financing text)"),
      },
      outputSchema: {
        items: z.array(Item),
        errors: z.array(z.object({ input: z.string(), error: z.string() })).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const { items, errors } = await session.items(a.items, a.include);
        return ok(errors.length ? { items, errors } : { items });
      } catch (e) {
        return fail(e);
      }
    },
  );

  const shutdown = async () => {
    await session.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(new StdioServerTransport());
}
