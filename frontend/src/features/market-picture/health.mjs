/** Keep transport revalidation separate from the health of retained observations. */
export function marketPictureHealth(faults = {}, sourceError = null, freshness = "UNKNOWN") {
  const components = Object.keys(faults).sort();
  const degraded = Boolean(sourceError || components.length);
  const componentNotice = components.length
    ? `Partial Market Picture observation · ${components.join(", ")} unavailable. Retained values remain bound to the same validated frame.`
    : null;
  return {
    degraded,
    components,
    freshness: degraded && freshness === "FRESH" ? "DEGRADED" : freshness,
    footerTone: degraded || freshness !== "FRESH" ? "warning" : "healthy",
    componentNotice,
    notice: [componentNotice, sourceError].filter(Boolean).join(" · ") || null,
  };
}

export function marketSourceLabel({ mode, freshness, valid, loading }) {
  if (loading) return "Loading";
  if (mode === "LIVE") {
    if (valid === 0) return "No qualified data";
    return freshness === "FRESH" ? "LIVE" : freshness;
  }
  return `${mode}${freshness === "FRESH" ? "" : ` · ${freshness}`}`;
}
