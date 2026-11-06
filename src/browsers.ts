// Where Chromium-family browsers keep their profiles and binaries on Linux.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CONFIG = process.env.XDG_CONFIG_HOME || join(HOME, ".config");
const flatpak = (appId: string, dir: string) => join(HOME, ".var/app", appId, "config", dir);

/**
 * Per browser: profile roots (native install first), the libsecret `application` holding its cookie key,
 * real binaries (distro launchers are often shell wrappers that inject user flags), and commands on PATH.
 * Snap and Flatpak builds are sandboxed and cannot be driven by Playwright, so only their profiles count.
 */
export const BROWSERS = {
  brave: {
    keyring: "brave",
    roots: [join(CONFIG, "BraveSoftware/Brave-Browser"), flatpak("com.brave.Browser", "BraveSoftware/Brave-Browser")],
    binaries: ["/opt/brave.com/brave/brave", "/opt/brave-bin/brave"],
    commands: ["brave-browser", "brave-browser-stable", "brave"],
  },
  chrome: {
    keyring: "chrome",
    roots: [join(CONFIG, "google-chrome"), flatpak("com.google.Chrome", "google-chrome")],
    binaries: ["/opt/google/chrome/chrome"],
    commands: ["google-chrome-stable", "google-chrome"],
  },
  chromium: {
    keyring: "chromium",
    roots: [
      join(CONFIG, "chromium"),
      flatpak("org.chromium.Chromium", "chromium"),
      join(HOME, "snap/chromium/common/chromium"),
    ],
    binaries: [
      "/usr/lib/chromium/chromium",
      "/usr/lib64/chromium-browser/chromium-browser",
      "/usr/lib/chromium-browser/chromium-browser",
    ],
    commands: ["chromium", "chromium-browser"],
  },
} as const;
export type BrowserName = keyof typeof BROWSERS;
export const BROWSER_NAMES = Object.keys(BROWSERS) as BrowserName[];

/** Installed browser executables, `first` (the one the cookies came from) ahead of the rest. */
export function installedBrowsers(first?: BrowserName): { browser: BrowserName; path: string }[] {
  const order = first ? [first, ...BROWSER_NAMES.filter((b) => b !== first)] : BROWSER_NAMES;
  return order.flatMap((browser) => {
    const { binaries, commands } = BROWSERS[browser];
    const path =
      binaries.find((p) => existsSync(p)) ??
      commands.map((c) => Bun.which(c)).find((p): p is string => !!p && !p.startsWith("/snap/"));
    return path ? [{ browser, path }] : [];
  });
}
