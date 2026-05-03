export const DEFAULT_AXL_API_URL = "http://127.0.0.1:9002";
export const DEFAULT_AXL_ROUTER_URL = "http://127.0.0.1:9003";
export const DEFAULT_WS_HUB_URL = "http://127.0.0.1:8787";

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

/**
 * Returns an ordered, deduplicated list of candidate URLs to try.
 * The configured URL is tried first; if it differs from the local default,
 * the local default is appended as a fallback so dev environments still work
 * when `.env` points at a stale or unreachable host.
 */
export function withLocalFallback(configuredUrl: string, localUrl: string): string[] {
  const configured = stripTrailingSlash(configuredUrl);
  const local = stripTrailingSlash(localUrl);
  return Array.from(new Set([configured, local].filter(Boolean)));
}
