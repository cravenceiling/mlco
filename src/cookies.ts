// Read Mercado Libre cookies from a local Chromium-family browser profile (Linux).
import { Database } from "bun:sqlite";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

import { BROWSER_NAMES, BROWSERS, type BrowserName } from "./browsers";

/** `auto` tries each browser in order; `none` searches signed out. */
export type CookieSource = "auto" | "none" | BrowserName;
export const COOKIE_SOURCES: readonly CookieSource[] = ["auto", "none", ...BROWSER_NAMES];

export type CookieOptions = {
  browser?: CookieSource;
  /** Profile directory name such as "Profile 1", or an absolute path to one. Defaults to "Default". */
  profile?: string;
};

export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "None" | "Lax" | "Strict";
};

/** `browser` is the browser the cookies came from, if any. */
export type LoadedCookies = { cookies: Cookie[]; browser?: BrowserName; warning?: string };

type Row = {
  host_key: string;
  name: string;
  encrypted_value: Uint8Array;
  value: string;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
};

const DOMAIN = "mercadolibre.com.co";
// Chromium counts microseconds from 1601-01-01.
const EPOCH_DELTA_S = 11_644_473_600;
const SAME_SITE = { 0: "None", 1: "Lax", 2: "Strict" } as const;

export function loadCookies({ browser = "auto", profile }: CookieOptions = {}): LoadedCookies {
  if (browser === "none") return { cookies: [] };
  if (browser === "auto" && profile && isAbsolute(profile)) {
    throw new Error("A --profile path needs --browser too, so the right keyring key is used.");
  }
  const found = findCookieDb(browser, profile ?? "Default");
  if (!found) {
    const what = browser === "auto" ? "Brave, Chrome or Chromium" : browser;
    const message = `No ${what} profile "${profile ?? "Default"}" found.`;
    // With no explicit choice, fall back to a signed-out search instead of failing.
    if (browser === "auto" && !profile) return { cookies: [], warning: `${message} Searching signed out.` };
    throw new Error(message);
  }
  const cookies = readCookies(found.file, found.browser);
  const signedIn = cookies.some((c) => c.name === "ssid");
  return {
    cookies,
    browser: found.browser,
    warning: signedIn
      ? undefined
      : `Not signed in to ${DOMAIN} in ${found.browser}; Mercado Libre may show a captcha. Sign in there and retry.`,
  };
}

function findCookieDb(browser: "auto" | BrowserName, profile: string) {
  const names = browser === "auto" ? BROWSER_NAMES : [browser];
  for (const name of names) {
    const dirs = isAbsolute(profile) ? [profile] : BROWSERS[name].roots.map((root) => join(root, profile));
    for (const dir of dirs) {
      // Newer Chromium builds keep the database under Network/.
      const file = [join(dir, "Network/Cookies"), join(dir, "Cookies")].find((f) => existsSync(f));
      if (file) return { browser: name, file };
    }
  }
  return undefined;
}

function readCookies(file: string, browser: BrowserName): Cookie[] {
  // The browser holds a lock on the live file, so read a copy.
  const dir = mkdtempSync(join(tmpdir(), "mlco-"));
  const copy = join(dir, "Cookies");
  try {
    copyFileSync(file, copy);
    const db = new Database(copy, { readonly: true });
    let rows: Row[];
    let dbVersion: number;
    try {
      dbVersion = Number(db.query<{ value: string }, []>("select value from meta where key = 'version'").get()?.value);
      rows = db
        .query<Row, [string]>(
          `select host_key, name, encrypted_value, value, path, expires_utc, is_secure, is_httponly, samesite
           from cookies where host_key like ? or host_key like '%.mercadolibre.com' or host_key = 'mercadolibre.com'`,
        )
        .all(`%${DOMAIN}`);
    } finally {
      db.close();
    }
    const decrypt = decryptor(BROWSERS[browser].keyring, dbVersion);
    return rows.map((r) => ({
      name: r.name,
      value: r.encrypted_value.length ? decrypt(r.encrypted_value, r.host_key) : r.value,
      domain: r.host_key,
      path: r.path,
      expires: r.expires_utc ? r.expires_utc / 1e6 - EPOCH_DELTA_S : -1,
      secure: !!r.is_secure,
      httpOnly: !!r.is_httponly,
      sameSite: SAME_SITE[r.samesite as keyof typeof SAME_SITE] ?? "Lax",
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function keyringPassword(app: string): string | null {
  // MCP clients often spawn servers with a stripped env; the keyring lives on the session bus.
  const env = { DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${userInfo().uid}/bus`, ...process.env };
  try {
    const out = Bun.spawnSync(["secret-tool", "lookup", "application", app], { env });
    return out.success ? out.stdout.toString().trim() : null;
  } catch {
    return null; // secret-tool is not installed
  }
}

const deriveKey = (password: string) => pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");

function tryDecrypt(key: Buffer, data: Buffer): Buffer | null {
  try {
    const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    return Buffer.concat([d.update(data), d.final()]);
  } catch {
    return null;
  }
}

/**
 * v10 values use a fixed password; v11 values use the browser's keyring secret. Chromium falls back
 * to an empty password when it has no keyring, so that key is tried last for both.
 */
function decryptor(app: string, dbVersion: number) {
  const empty = deriveKey("");
  const v10 = [deriveKey("peanuts"), empty];
  let v11: Buffer[] | undefined;
  return (blob: Uint8Array, host: string): string => {
    const buf = Buffer.from(blob);
    const prefix = buf.subarray(0, 3).toString();
    if (prefix !== "v10" && prefix !== "v11") return buf.toString();
    const password = prefix === "v11" && !v11 ? keyringPassword(app) : null;
    const keys = prefix === "v10" ? v10 : (v11 ??= password == null ? [empty] : [deriveKey(password), empty]);
    for (const key of keys) {
      const plain = tryDecrypt(key, buf.subarray(3));
      if (!plain) continue;
      // DB schema 24+ prefixes the plaintext with sha256(host_key).
      const hostHash = createHash("sha256").update(host).digest();
      return (dbVersion >= 24 && plain.subarray(0, 32).equals(hostHash) ? plain.subarray(32) : plain).toString();
    }
    throw new Error(`Could not decrypt ${app} cookies. Is the keyring unlocked and is secret-tool installed?`);
  };
}
