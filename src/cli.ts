#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { COOKIE_SOURCES, type CookieOptions } from "./cookies";
import type { Product } from "./parse";
import { BlockedError, CONDITIONS, MAX_LIMIT, SORTS, Session, type SearchOptions, type SearchResult } from "./search";

const USAGE = `mlco ${pkg.version}: search Mercado Libre Colombia from the terminal

Usage:
  mlco search <query> [options]
  mlco mcp [--browser B] [--profile P]   run an MCP server over stdio

Search options:
  -n, --limit N          results to return, up to ${MAX_LIMIT} (default 48; more fetches extra pages)
  -s, --sort ORDER       ${Object.keys(SORTS).join(" | ")}
      --min COP          minimum price, in Colombian pesos
      --max COP          maximum price, in Colombian pesos
      --condition C      ${Object.keys(CONDITIONS).join(" | ")}
      --free-shipping    only listings with free shipping
      --json             print JSON instead of a table

Session options:
      --browser B        ${COOKIE_SOURCES.join(" | ")} (default auto)
      --profile P        browser profile name, e.g. "Profile 1", or a path (default "Default")

  -h, --help             show this help
  -v, --version          show the version`;

class UsageError extends Error {}

const cop = (n: number | null) => (n == null ? "" : `$${n.toLocaleString("es-CO")}`);

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

function printTable(r: SearchResult) {
  console.log(`'${r.query}': ${r.total ?? "?"} results on Mercado Libre CO, showing ${r.products.length}`);
  console.log(`${r.url}\n`);
  r.products.forEach((p: Product, i) => {
    const disc = p.discountPct ? ` (-${p.discountPct}%, was ${cop(p.originalPrice)})` : "";
    const tags = [
      p.condition !== "Nuevo" && p.condition,
      p.officialStore && "official store",
      p.rating && `★${p.rating}`,
      p.sold,
      p.freeShipping ? "free shipping" : p.shipping,
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
      browser: { type: "string" },
      profile: { type: "string" },
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
  };
  if (opts.limit && opts.limit > MAX_LIMIT) throw new UsageError(`--limit can be at most ${MAX_LIMIT}`);
  if (opts.minPrice && opts.maxPrice && opts.minPrice > opts.maxPrice) throw new UsageError("--min is above --max");

  const session = new Session(cookies);
  try {
    const result = await session.search(query, opts);
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else printTable(result);
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
