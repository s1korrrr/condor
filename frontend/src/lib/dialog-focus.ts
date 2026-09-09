import type { KeyboardEvent } from "react";

// Keep modal boundary tabs in the document instead of moving to browser chrome.
export function containDialogTab(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const stops = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex], [contenteditable="true"]',
  )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.matches(":disabled"));
  const first = stops[0];
  const last = stops[stops.length - 1];
  const active = dialog.ownerDocument.activeElement;
  if (first && last && ((event.shiftKey && active === first) || (!event.shiftKey && active === last))) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
