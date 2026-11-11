#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { COOKIE_SOURCES, type CookieOptions } from "./cookies";
import { DEFAULT_ITEM_FIELDS, ITEM_FIELDS, type ItemField } from "./item";
import { EXTRA_FIELDS, withExtras, type ExtraField, type Product } from "./parse";
import { REVIEW_SORTS, type Review, type ReviewSort } from "./reviews";
import {
  BlockedError,
  CONDITIONS,
  MAX_ITEMS,
  MAX_LIMIT,
  MAX_OFFERS,
  MAX_REVIEWS,
  ORIGINS,
  SORTS,
  Session,
  type ItemsResult,
  type OffersResult,
  type SearchOptions,
  type SearchResult,
} from "./search";

const USAGE = `mlco ${pkg.version}: search Mercado Libre Colombia from the terminal

Usage:
  mlco search <query> [options]
  mlco item <id|url>... [options]        open up to ${MAX_ITEMS} listings: seller, stock, shipping, warranty, specs
  mlco offers <product|url> [options]    every seller of a catalog product (its catalogProductId or /p/ URL)
  mlco reviews <id|url> [options]        buyer reviews of a catalog product, or of a listing outside the catalog
  mlco mcp [--browser B] [--profile P]   run an MCP server over stdio

Search options:
  -n, --limit N          results to return, up to ${MAX_LIMIT} (default 48; more fetches extra pages)
  -s, --sort ORDER       ${Object.keys(SORTS).join(" | ")}
      --min COP          minimum price, in Colombian pesos
      --max COP          maximum price, in Colombian pesos
      --condition C      ${Object.keys(CONDITIONS).join(" | ")}
      --free-shipping    only listings with free shipping
      --origin O         ${Object.keys(ORIGINS).join(" | ")} (where the listing ships from)
      --official         only official stores
      --full             only listings shipped by Mercado Libre (Full)
      --mercadolider     only MercadoLíder sellers
      --include F,...    extra JSON fields: ${EXTRA_FIELDS.join(", ")}
      --json             print JSON instead of a table

Item options:
      --include F,...    ${ITEM_FIELDS.join(", ")} (default ${DEFAULT_ITEM_FIELDS.join(",")})
      --json             print JSON instead of a summary

Offers options:
  -n, --limit N          offers to return, up to ${MAX_OFFERS} (default 10)
      --json             print JSON instead of a table

Reviews options:
  -n, --limit N          reviews to return, up to ${MAX_REVIEWS} (default 15)
      --rating N         only reviews with N stars (1-5)
  -s, --sort ORDER       ${Object.keys(REVIEW_SORTS).join(" | ")}
      --json             print JSON instead of a list

Session options:
      --browser B        ${COOKIE_SOURCES.join(" | ")} (default auto)
      --profile P        browser profile name, e.g. "Profile 1", or a path (default "Default")

  -h, --help             show this help
  -v, --version          show the version`;

class UsageError extends Error {}

const cop = (n: number | null | undefined) => (n == null ? "" : `$${n.toLocaleString("es-CO")}`);

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.replace(/[.,_]/g, ""));
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive whole number`);
  return n;
}

function fieldList<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T[]): T[] {
  if (value === undefined) return fallback;
  const fields = value.split(",").map((f) => f.trim()).filter(Boolean);
  for (const f of fields) oneOf(f, allowed, "--include");
  return fields as T[];
}

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " / ");

function printItems(r: ItemsResult) {
  for (const it of r.items) {
    const s = it.seller;
    const disc = it.discountPct ? ` (-${it.discountPct}%, was ${cop(it.originalPrice)})` : "";
    console.log(`${it.title}\n  ${cop(it.price)}${disc} · ${it.condition} · stock ${it.stock ?? "?"} · ${it.sold ?? 0} sold`);
    const lider = s.mercadoLider ? `MercadoLíder ${s.mercadoLider}` : "";
    console.log(`  seller: ${[s.name, s.officialStore && "official store", lider, s.reputation, s.sales].filter(Boolean).join(" · ")}`);
    for (const o of it.shipping.options) {
      const cost = o.cost === 0 ? "free" : o.cost != null ? cop(o.cost) : "";
      console.log(`  ${[o.text, cost, o.note].filter(Boolean).join(" · ")}${it.shipping.to ? ` (to ${it.shipping.to})` : ""}`);
    }
    if (it.international?.note) console.log(`  ${it.international.note}`);
    console.log(`  ${it.warranty ?? "warranty not stated"}`);
    const rh = it.reviewHighlights;
    if (rh) {
      const stars = rh.stars ? Object.entries(rh.stars).reverse().map(([k, v]) => `${k}★ ${v}`).join(" · ") : "";
      console.log(`  reviews: ${[it.rating && `★${it.rating}`, it.reviews && `${it.reviews} ratings`, stars].filter(Boolean).join(" · ")}`);
      if (rh.summary) console.log(`  ${rh.summary}`);
      for (const r of rh.top ?? []) if (r.text) console.log(`    ${r.rating}★ ${oneLine(r.text)}`);
    }
    if (it.specs) {
      const specs = Object.entries(it.specs).map(([k, v]) => `${k}: ${v}`);
      console.log(`  ${specs.join(" · ")}`);
    }
    console.log(`  ${it.url}\n`);
  }
  for (const e of r.errors) console.error(`mlco: ${e.input}: ${e.error}`);
}

function printOffers(r: OffersResult) {
  console.log(`${r.title ?? r.catalogProductId}: ${r.offers.length} offer(s)\n`);
  r.offers.forEach((o, i) => {
    const s = o.seller;
    const disc = o.discountPct ? ` (-${o.discountPct}%, was ${cop(o.originalPrice)})` : "";
    const lider = s.mercadoLider && `MercadoLíder ${s.mercadoLider}`;
    console.log(`${String(i + 1).padStart(3)}. ${cop(o.price).padStart(12)}${disc}  ${s.name}`);
    const tags = [o.condition !== "new" && o.condition, s.officialStore && "official store", lider, s.reputation, s.sales, o.international, o.warranty];
    console.log(`     ${tags.filter(Boolean).join(" · ")}`);
    if (o.shipping) console.log(`     ${o.shipping}`);
    if (o.notice) console.log(`     ${o.notice}`);
    console.log(`     ${o.url}`);
  });
}

function printReviews(reviews: Review[]) {
  if (!reviews.length) {
    return console.log("No reviews match. A listing in the catalog has no reviews of its own: pass its catalogProductId.");
  }
  for (const r of reviews) {
    const meta = [r.date, r.likes && `${r.likes} útil`, r.variant].filter(Boolean).join(" · ");
    console.log(`${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}  ${meta}`);
    console.log(`  ${r.text ? oneLine(r.text) : "(no comment)"}\n`);
  }
}

function printTable(r: SearchResult) {
  console.log(`'${r.query}': ${r.total ?? "?"} results on Mercado Libre CO, showing ${r.products.length}`);
  console.log(`${r.url}\n`);
  if (r.notice) console.log(r.notice);
  r.products.forEach((p: Product, i) => {
    const disc = p.discountPct ? ` (-${p.discountPct}%, was ${cop(p.originalPrice)})` : "";
    const tags = [
      p.condition !== "new" && p.condition,
      p.officialStore && `official store ${p.officialStore}`,
      p.rating && `★${p.rating}`,
      p.sold && (p.sold === 1 ? "1 vendido" : `+${p.sold.toLocaleString("es-CO")} vendidos`),
      p.shipping,
      p.international,
      p.purchaseOptions,
    ].filter(Boolean);
    console.log(`${String(i + 1).padStart(3)}. ${cop(p.price).padStart(12)}${disc}  ${p.title}`);
    if (tags.length) console.log(`     ${tags.join(" · ")}`);
    console.log(`     ${p.url}`);
  });
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: "string", short: "n" },
      sort: { type: "string", short: "s" },
      min: { type: "string" },
      max: { type: "string" },
      condition: { type: "string" },
      "free-shipping": { type: "boolean" },
      origin: { type: "string" },
      official: { type: "boolean" },
      full: { type: "boolean" },
      mercadolider: { type: "boolean" },
      rating: { type: "string" },
      browser: { type: "string" },
      profile: { type: "string" },
      include: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) return console.log(pkg.version);
  if (values.help) return console.log(USAGE);

  const cookies: CookieOptions = {
    browser: oneOf(values.browser, COOKIE_SOURCES, "--browser"),
    profile: values.profile,
  };
  const [cmd, ...rest] = positionals;
  if (cmd === "mcp") return (await import("./mcp")).serve(cookies);
  if (cmd === "item") {
    if (!rest.length) throw new UsageError("Missing item id or URL");
    if (rest.length > MAX_ITEMS) throw new UsageError(`At most ${MAX_ITEMS} items at a time`);
    const include = fieldList<ItemField>(values.include, ITEM_FIELDS, [...DEFAULT_ITEM_FIELDS]);
    const session = new Session(cookies);
    try {
      const result = await session.items(rest, include);
      if (values.json) console.log(JSON.stringify(result.errors.length ? result : { items: result.items }, null, 2));
      else printItems(result);
      if (!result.items.length) process.exitCode = 1;
    } finally {
      await session.close();
    }
    return;
  }
  if (cmd === "offers" || cmd === "reviews") {
    if (rest.length !== 1) throw new UsageError(`${cmd} takes one ${cmd === "offers" ? "product" : "id"} or URL`);
    const limit = positiveInt(values.limit, "--limit");
    const session = new Session(cookies);
    try {
      if (cmd === "offers") {
        const result = await session.offers(rest[0]!, limit);
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printOffers(result);
      } else {
        const result = await session.reviews(rest[0]!, {
          limit,
          rating: positiveInt(values.rating, "--rating"),
          sort: oneOf(values.sort, Object.keys(REVIEW_SORTS) as ReviewSort[], "--sort"),
        });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printReviews(result.reviews);
      }
    } finally {
      await session.close();
    }
    return;
  }
  if (cmd !== "search") throw new UsageError(cmd ? `Unknown command: ${cmd}` : "Missing command");
  const query = rest.join(" ").trim();
  if (!query) throw new UsageError("Missing search query");

  const opts: SearchOptions = {
    limit: positiveInt(values.limit, "--limit"),
    sort: oneOf(values.sort, Object.keys(SORTS) as (keyof typeof SORTS)[], "--sort"),
    minPrice: positiveInt(values.min, "--min"),
    maxPrice: positiveInt(values.max, "--max"),
    condition: oneOf(values.condition, Object.keys(CONDITIONS) as (keyof typeof CONDITIONS)[], "--condition"),
    freeShipping: values["free-shipping"],
    origin: oneOf(values.origin, Object.keys(ORIGINS) as (keyof typeof ORIGINS)[], "--origin"),
    officialStore: values.official,
    full: values.full,
    bestSellers: values.mercadolider,
  };
  if (opts.limit && opts.limit > MAX_LIMIT) throw new UsageError(`--limit can be at most ${MAX_LIMIT}`);
  if (opts.minPrice && opts.maxPrice && opts.minPrice > opts.maxPrice) throw new UsageError("--min is above --max");

  const session = new Session(cookies);
  try {
    const result = await session.search(query, opts);
    const include = fieldList<ExtraField>(values.include, EXTRA_FIELDS, []);
    if (values.json) {
      console.log(JSON.stringify({ ...result, products: result.products.map((p) => withExtras(p, include)) }, null, 2));
    } else printTable(result);
  } finally {
    await session.close();
  }
}

main(Bun.argv.slice(2)).catch((e) => {
  if (e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
    console.error(`mlco: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(`mlco: ${e instanceof BlockedError ? "blocked: " : ""}${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
