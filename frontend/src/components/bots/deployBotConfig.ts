export const HIDDEN_KEYS = new Set([
  "id",
  "controller_name",
  "controller_type",
  "candles_config",
]);

export function inferInputType(value: unknown): "number" | "boolean" | "text" | "json" {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "object" && value !== null) return "json";
  return "text";
}

export function parseValue(raw: string, type: "number" | "boolean" | "text" | "json"): unknown {
  if (type === "number") {
    const number = Number(raw);
    return isNaN(number) ? raw : number;
  }
  if (type === "boolean") return raw === "true";
  if (type === "json") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}
