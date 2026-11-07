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
reputation, stock, shipping quoted for your address, warranty and the technical specs.

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
git clone https://github.com/cravenceiling/mlco.git
cd mlco
bun install
ln -s "$PWD/src/cli.ts" ~/.local/bin/mlco
```

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
      --include F,...    extra JSON fields: installments, image
      --json             print JSON instead of a table

mlco item <id|url>... [options]          up to 10 item ids (MCO4097589348) or mercadolibre.com.co URLs

      --include F,...    specs, description, installments (default specs,description)
      --json             print JSON instead of a summary

Session options, for both:
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
`purchaseOptions` and `catalogProductId`. `currency` appears only for prices not in COP. `installments` and
`image` appear only with `--include`. Search cards name the seller only for official stores. To see who
sells any other listing, open it with `mlco item`.

`item --json` prints `{ items, errors? }`. Each item has the same price fields, plus `seller` (`name`, `id`,
`officialStore`, `mercadoLider`, `reputation`, `sales`), `stock`, `sold`, `rating`, `reviews`, `variant`,
`shipping` (`to`: the city of your signed-in address, `options`: `{ text, cost, note }`, `full`),
`international` (origin and the import-cost note), `warranty`, `returns`, `otherOffers`, `specs` and
`description`. `price` is the cash price any buyer pays, without coupons or card offers. A listing that cannot
be read goes in `errors` and does not fail the others.

## MCP server

`mlco mcp` serves two tools over stdio:

- `search_products`: the search above.
- `get_items`: the item lookup above, for up to 10 listings per call. With `include: []` it returns only
  the buy box, about 700 characters per listing.

It keeps a single headless browser open between calls and closes it after five idle minutes. Each tool
returns structured content and the same JSON, unindented, as text.

Claude Code:

```sh
claude mcp add mercadolibre-co -s user -- ~/.local/bin/mlco mcp
```

Other clients (Claude Desktop, Cursor, and so on):

```json
{
  "mcpServers": {
    "mercadolibre-co": { "command": "/home/you/.local/bin/mlco", "args": ["mcp"] }
  }
}
```

Add `"--browser", "chrome"` or `"--profile", "Profile 1"` to `args` to pick the session.

## Troubleshooting

- **`blocked: Mercado Libre asked for verification`**: open mercadolibre.com.co in your browser, complete
  the captcha or sign in, then retry.
- **`Not signed in to mercadolibre.com.co`**: the browser profile has no Mercado Libre session. Sign in
  there, or pick another profile with `--profile`.
- **`Could not decrypt ... cookies`**: unlock your keyring, or check that `secret-tool` is installed.
- **`Search results not found`**: Mercado Libre changed its page format. Please open an issue.

## Development

```sh
bun install
bun run typecheck
bun test
bun src/cli.ts search "teclado mecanico" -n 5
bun src/cli.ts item MCO-4097589348
```

`bun install` sets up a [husky](https://typicode.github.io/husky) pre-commit hook that runs the typecheck.

The code lives in `src/`: `cli.ts` (command line), `mcp.ts` (MCP server), `search.ts` (browser, paging
and opening items), `parse.ts` (results page to products), `item.ts` (item page to one listing) and
`cookies.ts` (reading browser cookies).

## Disclaimer

mlco is an unofficial tool and is not affiliated with or endorsed by Mercado Libre. It reads public search
pages at a human pace. Use it for personal searches and follow Mercado Libre's terms of service.

## License

[MIT](LICENSE)
