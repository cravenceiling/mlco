# mlco

Search [Mercado Libre Colombia](https://www.mercadolibre.com.co) from the terminal, or let an AI assistant
search it through [MCP](https://modelcontextprotocol.io).

```console
$ mlco search "airpods pro 3" -n 3 -s price_asc --min 600000 --condition new
'airpods pro 3': 60 results on Mercado Libre CO, showing 3
https://listado.mercadolibre.com.co/airpods-pro-3_ITEM*CONDITION_2230284_PriceRange_600000-0_OrderId_PRICE_NoIndex_True

  1.     $716.399 (-10%, was $795.999)  Apple AirPods Pro 3 Blanco
     Envío gratis
     https://articulo.mercadolibre.com.co/MCO-2312075263
  2.     $750.000  Apple AirPods Pro 2ª generación Auriculares in-ear Con Estuche De Carga Blanco
     ★4.7 · +1000 vendidos · 12 opciones de compra
     https://www.mercadolibre.com.co/p/MCO18706466
  ...
```

mlco runs a headless Chromium and reads the search data that Mercado Libre embeds in the results page, so
you get prices as integers, discounts, ratings, units sold, condition, shipping and short links. Sponsored
listings are left out. `mlco item` opens listings to read what search cards leave out: the seller and their
reputation, stock, shipping quoted for your address, warranty, the technical specs and review highlights.
`mlco offers` lists every seller of a catalog product, so you can find a cheaper or better-rated one, and
`mlco reviews` reads buyer reviews filtered by stars, such as the 1-star complaints.

Mercado Libre shows captchas to browsers it does not recognise. To avoid that, mlco can reuse the session
from your own browser: it copies your Mercado Libre cookies from a local Brave, Chrome or Chromium profile
into its headless browser. The cookies stay on your machine and only go to Mercado Libre.

## Requirements

- Linux. Cookie decryption uses the Linux keyring, so macOS and Windows are not supported yet.
- [Bun](https://bun.sh) 1.2 or later.
- `secret-tool` (package `libsecret-tools` on Debian/Ubuntu, `libsecret` on Arch/Fedora) to read the
  browser's cookie key from the keyring. Not needed with `--browser none`.
- Brave, Chrome or Chromium, ideally signed in to mercadolibre.com.co. mlco runs it headless, so there is
  nothing else to download. Without one, see [Install](#install).

## Install

```sh
bun add -g @cravenceiling/mlco
```

That installs the `mlco` command. Or run it without installing, as `bunx @cravenceiling/mlco search …`. mlco
runs on Bun, so `npx @cravenceiling/mlco` works only when Bun is installed too.

mlco runs your installed Brave, Chrome or Chromium headless, preferring the one your session comes from.
Snap and Flatpak builds are sandboxed and can't be driven this way. If you only have one of those, or no
browser at all, either download Playwright's Chromium (about 100 MB) with
`bunx playwright-core install chromium-headless-shell`, or set `MLCO_CHROMIUM_PATH` to any Chromium-based
browser binary.

## Usage

```
mlco search <query> [options]

  -n, --limit N          results to return, up to 200 (default 48; more fetches extra pages)
  -s, --sort ORDER       relevance | price_asc | price_desc
      --min COP          minimum price, in Colombian pesos (600000 or 600.000)
      --max COP          maximum price
      --condition C      new | used
      --free-shipping    only listings with free shipping
      --origin O         local | international (where the listing ships from)
      --official         only official stores
      --full             only listings shipped by Mercado Libre (Full)
      --mercadolider     only MercadoLíder sellers
      --include F,...    extra JSON fields: installments, image
      --json             print JSON instead of a table

mlco item <id|url>... [options]          up to 10 item ids (MCO4097589348) or mercadolibre.com.co URLs

      --include F,...    specs, description, reviews, installments (default specs,description,reviews)
      --json             print JSON instead of a summary

mlco offers <product|url> [options]      a catalogProductId (MCO37690980) or a /p/ URL

  -n, --limit N          offers to return, up to 50 (default 10; 10 per page)
      --json             print JSON instead of a table

mlco reviews <id|url> [options]          a catalogProductId, or the item id of a listing outside the catalog

  -n, --limit N          reviews to return, up to 60 (default 15)
      --rating N         only reviews with N stars (1-5)
  -s, --sort ORDER       relevance | newest
      --json             print JSON instead of a list

Session options, for every command:
      --browser B        auto | none | brave | chrome | chromium (default auto)
      --profile P        browser profile name, e.g. "Profile 1", or a path (default "Default")
```

`--browser auto` uses the first of Brave, Chrome and Chromium that has the profile, including Flatpak and
Snap installs. If none is found, mlco searches signed out and says so. `--browser none` always searches
signed out.

JSON output leaves out empty fields instead of printing `null`, `false` or `[]`, so a field that is
missing means the page did not show it.

`search --json` prints `{ query, url, total, products }`. Each product has `id`, `title`, `price`,
`condition` (`new`, `used` or `refurbished`) and `url`, plus, when the card shows them, `originalPrice`,
`discountPct`, `officialStore`, `rating`, `sold`, `shipping`, `international`, `promotions`,
`purchaseOptions` and `catalogProductId`. `sold` is a number and a lower bound: a card showing
"+5mil vendidos" gives `5000`. `currency` appears only for prices not in COP. `installments` and
`image` appear only with `--include`. Search cards name the seller only for official stores. To see who
sells any other listing, open it with `mlco item`.

`item --json` prints `{ items, errors? }`. Each item has the same price fields, plus `seller` (`name`, `id`,
`officialStore`, `mercadoLider`, `reputation`, `sales`), `stock`, `sold`, `rating`, `reviews`, `variant`,
`shipping` (`to`: the city of your signed-in address, `options`: `{ text, cost, note }`, `full`),
`international` (origin and the import-cost note), `warranty`, `returns`, `otherOffers`, `specs`,
`description` and `reviewHighlights` (`summary`: Mercado Libre's AI summary of the reviews, `stars`: ratings
per star, including those without text, `top`: the up to five reviews the page shows). `price` is the cash
price any buyer pays, without coupons or card offers. A listing that cannot be read goes in `errors` and does
not fail the others.

`offers --json` prints `{ catalogProductId, title, offers }`. Each offer has `id`, `url`, the price fields,
`condition`, `seller` (as in `item`), `shipping`, and when shown `international`, `warranty` (the seller's)
and `notice` (for example extra days to prepare the product).

`reviews --json` prints `{ id, reviews }`. Each review has `rating`, and when present `text`, `date`
(`YYYY-MM-DD`), `likes` and `variant`. A listing in the catalog has no reviews of its own, so pass its
`catalogProductId`; mlco falls back to the item id when the product has none.

## MCP server

`mlco mcp` serves four tools over stdio:

- `search_products`: the search above, with `origin`, `official_store`, `full` and `best_sellers` filters.
- `get_items`: the item lookup above, for up to 10 listings per call. With `include: []` it returns only
  the buy box, about 700 characters per listing.
- `get_offers`: every seller of a catalog product, 10 per page.
- `get_reviews`: buyer reviews, 15 per request, filtered by stars and sorted by relevance or date.

It keeps a single headless browser open between calls and closes it after five idle minutes. Each tool
returns structured content and the same JSON, unindented, as text.

Claude Code:

```sh
claude mcp add mlco -s user -- bunx @cravenceiling/mlco mcp
```

Other clients (Claude Desktop, Cursor, and so on):

```json
{
  "mcpServers": {
    "mlco": { "command": "bunx", "args": ["@cravenceiling/mlco", "mcp"] }
  }
}
```

Add `"--browser", "chrome"` or `"--profile", "Profile 1"` to `args` to pick the session. The first `bunx`
run downloads mlco and its dependencies, which can outlast a client's start-up timeout; run
`bunx @cravenceiling/mlco --help` once beforehand, or use `bun add -g @cravenceiling/mlco` and
`"command": "mlco"`.

## Troubleshooting

- **`blocked: Mercado Libre asked for verification`**: open mercadolibre.com.co in your browser, complete
  the captcha or sign in, then retry.
- **`Not signed in to mercadolibre.com.co`**: the browser profile has no Mercado Libre session. Sign in
  there, or pick another profile with `--profile`.
- **`Could not decrypt ... cookies`**: unlock your keyring, or check that `secret-tool` is installed.
- **`Search results not found`**: Mercado Libre changed its page format. Please open an issue.

## Development

```sh
git clone https://github.com/cravenceiling/mlco.git
cd mlco
bun install
bun run typecheck
bun test
bun src/cli.ts search "teclado mecanico" -n 5
bun src/cli.ts item MCO-4097589348
bun src/cli.ts offers MCO37690980
bun src/cli.ts reviews MCO37690980 --rating 1
```

`bun install` sets up a [husky](https://typicode.github.io/husky) pre-commit hook that runs the typecheck.

The code lives in `src/`: `cli.ts` (command line), `mcp.ts` (MCP server), `search.ts` (browser, paging
and opening items), `parse.ts` (results page to products), `item.ts` (item page to one listing), `offers.ts`
(offers page to sellers), `reviews.ts` (reviews to plain records) and `cookies.ts` (reading browser cookies).

## Disclaimer

mlco is an unofficial tool and is not affiliated with or endorsed by Mercado Libre. It reads public search
pages at a human pace. Use it for personal searches and follow Mercado Libre's terms of service.

## License

[MIT](LICENSE)
