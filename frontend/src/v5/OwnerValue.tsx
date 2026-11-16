import { ownerDisplay, type OwnerValueKind } from './format.mjs';

export function OwnerValue({ value, kind, unit, digits, exact }: { value: unknown; kind: OwnerValueKind; unit?: string; digits?: number; exact?: string }) {
  const shown = ownerDisplay(value, kind, { unit, digits });
  return <span title={shown.exact == null ? undefined : exact ?? shown.exact} data-tone={shown.tone}>{shown.text}</span>;
}
