const SAFE_READ_PREFIXES = [
  "/api/v1/servers", "/api/v1/trading-visuals", "/api/v1/research", "/api/v1/tradepad",
  "/api/v1/market-picture", "/api/v1/settings", "/api/v1/reports",
];

export function validateV5ReadRequest(path, method = "GET", hasBody = false, origin = "https://v5.invalid") {
  if (method.toUpperCase() !== "GET" || hasBody) throw new Error("V5 dashboard transport is read-only.");
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("\0")) {
    throw new Error("V5 dashboard transport rejected a non-relative API path.");
  }
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/api/v1/")) throw new Error("V5 dashboard transport only accepts same-origin V1 read paths.");
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { throw new Error("V5 dashboard transport rejected malformed path encoding."); }
  if (decoded.split("/").some(part => part === "." || part === "..") || !SAFE_READ_PREFIXES.some(prefix => decoded === prefix || decoded.startsWith(`${prefix}/`))) {
    throw new Error("V5 dashboard transport rejected an unsupported read path.");
  }
  return `${url.pathname}${url.search}`;
}
