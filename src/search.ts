// Search listado.mercadolibre.com.co in headless Chromium, optionally signed in with a local browser session.
import { existsSync } from "node:fs";
import { chromium, errors, type Browser, type BrowserContext, type Page } from "playwright-core";
import { installedBrowsers, type BrowserName } from "./browsers";
import { loadCookies, type CookieOptions } from "./cookies";
import { parseItemPage, type Item, type ItemField } from "./item";
import { parseSearchPage, type Product } from "./parse";

const BASE = "https://listado.mercadolibre.com.co";
export const PAGE_SIZE = 48;
/** About five result pages, which keeps one search well under typical MCP client timeouts. */
export const MAX_LIMIT = 200;
/** Searches beyond this many at once wait their turn instead of opening more tabs. */
const MAX_OPEN_PAGES = 2;
export const SORTS = { relevance: "", price_asc: "_OrderId_PRICE", price_desc: "_OrderId_PRICE*DESC" } as const;
export const CONDITIONS = { new: "_ITEM*CONDITION_2230284", used: "_ITEM*CONDITION_2230581" } as const;
export type Sort = keyof typeof SORTS;
export type Condition = keyof typeof CONDITIONS;

// Must match the real Chromium major version or Mercado Libre serves a captcha wall.
const userAgent = (version: string) =>
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split(".")[0]}.0.0.0 Safari/537.36`;
const STEALTH = `
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = window.chrome || {runtime: {}};
Object.defineProperty(navigator, 'languages', {get: () => ['es-CO', 'es', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
`;
const SKIP_RESOURCES = new Set(["image", "media", "font"]);

export type SearchOptions = {
  limit?: number;
  sort?: Sort;
  minPrice?: number;
  maxPrice?: number;
  condition?: Condition;
  freeShipping?: boolean;
};

export type SearchResult = { query: string; url: string; total: number | null; products: Product[] };

export class BlockedError extends Error {}

const slug = (q: string) =>
  q
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function buildUrl(query: string, page: number, o: SearchOptions = {}): string {
  const parts = [slug(query)];
  if (o.condition) parts.push(CONDITIONS[o.condition]);
  if (o.freeShipping) parts.push("_CostoEnvio_Gratis");
  if (o.minPrice || o.maxPrice) parts.push(`_PriceRange_${o.minPrice ?? 0}-${o.maxPrice ?? 0}`);
  if (page > 1) parts.push(`_Desde_${(page - 1) * PAGE_SIZE + 1}`);
  parts.push(SORTS[o.sort ?? "relevance"], "_NoIndex_True");
  return `${BASE}/${parts.join("")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(1500 + Math.random() * 2000);

const NOT_INSTALLED =
  "No browser to run. Install Brave, Chrome or Chromium, run `bunx playwright-core install chromium-headless-shell`, " +
  "or set MLCO_CHROMIUM_PATH to a Chromium-based browser binary.";

/**
 * Start a headless browser: MLCO_CHROMIUM_PATH if set, else an installed Brave/Chrome/Chromium
 * (preferring the one the cookies came from), else Playwright's own Chromium download.
 */
async function launch(cookieBrowser?: BrowserName): Promise<Browser> {
  const override = process.env.MLCO_CHROMIUM_PATH;
  if (override && !existsSync(override)) throw new Error(`MLCO_CHROMIUM_PATH points to ${override}, which does not exist.`);
  const candidates = override ? [override] : [...installedBrowsers(cookieBrowser).map((b) => b.path), undefined];
  for (const executablePath of candidates) {
    try {
      return await chromium.launch({
        headless: true,
        executablePath,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (e) {
      const last = executablePath === candidates.at(-1);
      if (!executablePath && /executable doesn't exist/i.test(String(e))) throw new Error(NOT_INSTALLED);
      if (last) throw e;
      console.error(`mlco: could not start ${executablePath}: ${String(e).split("\n")[0]}; trying the next browser.`);
    }
  }
  throw new Error(NOT_INSTALLED);
}

/**
 * A lazily launched, reusable headless browser. The MCP server keeps one warm across calls
 * and closes it after `idleMs` without an open page; the CLI uses it for a single search.
 */
export class Session {
  private browser?: Browser;
  private context?: Promise<BrowserContext>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private activeCalls = 0;
  private runningPages = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private readonly cookieOptions: CookieOptions = {},
    private readonly idleMs = 0,
  ) {}

  private contextOnce(): Promise<BrowserContext> {
    this.context ??= (async () => {
      const { cookies, browser, warning } = loadCookies(this.cookieOptions);
      if (warning) console.error(`mlco: ${warning}`);
      this.browser = await launch(browser);
      const ctx = await this.browser.newContext({
        userAgent: userAgent(this.browser.version()),
        locale: "es-CO",
        timezoneId: "America/Bogota",
        viewport: { width: 1366, height: 900 },
      });
      await ctx.addInitScript(STEALTH);
      if (cookies.length) await ctx.addCookies(cookies);
      await ctx.route("**/*", (route) =>
        SKIP_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue(),
      );
      return ctx;
    })().catch(async (e) => {
      await this.close();
      throw e;
    });
    return this.context;
  }

  private async acquirePage(): Promise<void> {
    if (this.runningPages < MAX_OPEN_PAGES) {
      this.runningPages++;
      return;
    }
    // release hands its slot straight to the next waiter, so runningPages stays the same.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private releasePage() {
    const next = this.waiting.shift();
    if (next) next();
    else this.runningPages--;
  }

  private async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    clearTimeout(this.idleTimer);
    this.activeCalls++;
    try {
      await this.acquirePage();
      try {
        const page = await (await this.contextOnce()).newPage();
        try {
          return await fn(page);
        } finally {
          await page.close().catch(() => {});
        }
      } finally {
        this.releasePage();
      }
    } finally {
      // Only start the idle countdown once no call is running or waiting.
      if (--this.activeCalls === 0 && this.idleMs) this.idleTimer = setTimeout(() => void this.close(), this.idleMs);
    }
  }

  async close() {
    clearTimeout(this.idleTimer);
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    await browser?.close();
  }

  async search(query: string, o: SearchOptions = {}): Promise<SearchResult> {
    const limit = o.limit ?? PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RangeError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    }
    const products = new Map<string, Product>();
    let total: number | null = null;
    let skipped = 0;
    await this.withPage(async (page) => {
      for (let n = 1; products.size < limit; n++) {
        if (n > 1) await jitter();
        const result = await loadSearchPage(page, buildUrl(query, n, o));
        total ??= result.total;
        skipped += result.skipped;
        for (const p of result.products) {
          // The free-shipping filter guarantees it even when a card omits the label.
          if (!products.has(p.id)) products.set(p.id, o.freeShipping && !p.shipping ? { ...p, shipping: "Envío gratis" } : p);
        }
        if (!result.products.length || n >= result.lastPage) break;
      }
    });
    if (skipped && !products.size) {
      throw new Error("Could not read any listing on the results page; Mercado Libre may have changed its format.");
    }
    if (skipped) console.error(`mlco: skipped ${skipped} listing(s) that could not be read.`);
    return { query, url: buildUrl(query, 1, o), total, products: [...products.values()].slice(0, limit) };
  }

  /**
   * Open each listing and read its seller, stock, shipping, warranty and specs. Runs up to two tabs at once,
   * at a human pace within each. One failed listing is reported in `errors` instead of failing the rest;
   * a captcha or sign-in wall fails the whole call, since every later page would hit it too.
   */
  async items(inputs: string[], include: readonly ItemField[] = ["specs", "description"]): Promise<ItemsResult> {
    if (!inputs.length || inputs.length > MAX_ITEMS) throw new RangeError(`Pass 1 to ${MAX_ITEMS} items`);
    const results: (Item | ItemError)[] = new Array(inputs.length);
    const pending: { i: number; url: string }[] = [];
    inputs.forEach((input, i) => {
      try {
        pending.push({ i, url: itemPageUrl(input) });
      } catch (e) {
        results[i] = { input, error: (e as Error).message };
      }
    });
    let next = 0;
    const worker = () =>
      this.withPage(async (page) => {
        for (let first = true; next < pending.length; first = false) {
          const { i, url } = pending[next++]!;
          if (!first) await jitter();
          try {
            results[i] = await loadItemPage(page, url, include);
          } catch (e) {
            if (e instanceof BlockedError) throw e;
            results[i] = { input: inputs[i]!, error: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
          }
        }
      });
    await Promise.all(Array.from({ length: Math.min(MAX_OPEN_PAGES, pending.length) }, worker));
    return {
      items: results.filter((r): r is Item => !("error" in r)),
      errors: results.filter((r): r is ItemError => "error" in r),
    };
  }
}

/** Ten listings take about half a minute, which stays under typical MCP client timeouts. */
export const MAX_ITEMS = 10;
export type ItemError = { input: string; error: string };
export type ItemsResult = { items: Item[]; errors: ItemError[] };

function throwIfBlocked(page: Page) {
  if (/\/captcha\/|\/gz\/account-verification/.test(page.url())) {
    throw new BlockedError(
      "Mercado Libre asked for verification. Open mercadolibre.com.co in your browser, complete it, and retry.",
    );
  }
  if (page.url().includes("/login")) {
    throw new BlockedError("Mercado Libre asked to sign in. Sign in to mercadolibre.com.co in your browser and retry.");
  }
}

/** Open `url` and return its HTML once `ready` matches (or once the HTML is parsed), retrying timeouts. */
async function loadPage(page: Page, url: string, ready?: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });
      if (ready) await page.waitForSelector(ready, { timeout: 20_000 });
      else throwIfBlocked(page);
      return await page.content();
    } catch (e) {
      throwIfBlocked(page);
      if (!(e instanceof errors.TimeoutError) || attempt === 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

async function loadSearchPage(page: Page, url: string) {
  const parsed = parseSearchPage(await loadPage(page, url, ".andes-money-amount__fraction, .ui-search-rescue"));
  if (!parsed) throw new Error(`Search results not found on ${page.url()}; the page layout may have changed.`);
  return parsed;
}

const ITEM_ID = /^MCO-?(\d{6,})$/i;
const ML_HOST = /(^|\.)mercadolibre\.com\.co$/;

/**
 * Turn an item id (MCO4097589348, MCO-4097589348) or a mercadolibre.com.co URL into the page to open.
 * Other hosts are refused: the browser carries the user's Mercado Libre session.
 */
export function itemPageUrl(input: string): string {
  const s = input.trim();
  const id = ITEM_ID.exec(s);
  if (id) return `https://articulo.mercadolibre.com.co/MCO-${id[1]}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new RangeError(`Not an item id or URL: ${input}`);
  }
  if (url.protocol !== "https:" || !ML_HOST.test(url.hostname)) {
    throw new RangeError(`Only https://…mercadolibre.com.co URLs are allowed: ${input}`);
  }
  return url.toString();
}

async function loadItemPage(page: Page, url: string, include: readonly ItemField[]): Promise<Item> {
  // Item pages inline their whole state in the server HTML, so there is nothing to wait for.
  const html = await loadPage(page, url);
  const item = parseItemPage(html, include);
  if (!item) throw new Error(`No listing on ${page.url()}; it may have been removed or paused.`);
  return item;
}
