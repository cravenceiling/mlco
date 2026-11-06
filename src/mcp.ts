import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import type { CookieOptions } from "./cookies";
import { Product } from "./parse";
import { BlockedError, CONDITIONS, MAX_LIMIT, SORTS, Session, type Condition, type Sort } from "./search";

const IDLE_MS = 5 * 60_000;

export async function serve(cookieOptions: CookieOptions) {
  // One warm browser shared by all calls; closed after 5 idle minutes.
  const session = new Session(cookieOptions, IDLE_MS);
  const server = new McpServer({ name: "mercadolibre-co", version: pkg.version });

  server.registerTool(
    "search_products",
    {
      title: "Search Mercado Libre Colombia",
      description:
        "Search mercadolibre.com.co and return listings with price (integer COP), discount, seller/official store, " +
        "rating, units sold, condition, shipping and URL. Ads are excluded. 48 results per page; a limit above 48 " +
        `fetches more pages, a few seconds each (at most ${MAX_LIMIT}). Sorting by price_asc surfaces cheap ` +
        "accessories (cases, cables); " +
        "set min_price to skip them when comparing the product itself.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(48),
        sort: z.enum(Object.keys(SORTS) as [Sort, ...Sort[]]).default("relevance"),
        min_price: z.number().int().positive().optional(),
        max_price: z.number().int().positive().optional(),
        condition: z.enum(Object.keys(CONDITIONS) as [Condition, ...Condition[]]).optional(),
        free_shipping: z.boolean().default(false),
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
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (e) {
        if (!(e instanceof BlockedError)) throw e;
        return { isError: true, content: [{ type: "text", text: e.message }] };
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
