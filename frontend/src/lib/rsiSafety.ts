export function isManagedRsiController(controllerName: string): boolean {
  const normalized = controllerName.trim().toLowerCase();
  return normalized.startsWith("rsi_") || normalized.startsWith("hyperliquid_portfolio_rsi");
}

const FLOATING_IMAGE_TAGS = new Set([
  "latest",
  "development",
  "dev",
  "main",
  "master",
  "edge",
  "stable",
]);

export function isPinnedHummingbotImage(image: string): boolean {
  const normalized = image.trim();
  if (!normalized || /\s/.test(normalized)) return false;

  if (normalized.includes("@")) {
    return /^[^@]+@sha256:[0-9a-f]{64}$/i.test(normalized);
  }

  const lastSlash = normalized.lastIndexOf("/");
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon <= lastSlash) return false;

  const tag = normalized.slice(lastColon + 1).toLowerCase();
  return tag.length > 0 && !FLOATING_IMAGE_TAGS.has(tag);
}
