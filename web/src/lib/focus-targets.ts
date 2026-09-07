// The two text fields a keyboard shortcut can aim at, published as module state.
//
// `i` focuses the composer and `/` focuses the find bar, and both are pressed at the WINDOW — the
// handler (hooks/use-global-keys.ts) is mounted in RootLayout, several routes above the elements it
// must reach. A context would mean threading a provider through every route for one keystroke each,
// and a `document.querySelector` would bind the shortcut to a class name. So each field registers
// itself on mount and clears on unmount, exactly like the composer's own `inputRef`.
//
// A registration is the LATEST one wins, and unregistering is unconditional. That is safe because
// React runs a ref callback's cleanup BEFORE the replacement callback runs (and, across the
// composer's keyed pane switch, unmounts the old subtree before mounting the new one), so a stale
// clear can never land on a field a newer mount has already claimed.

let composerEl: HTMLTextAreaElement | null = null;
let findEl: HTMLInputElement | null = null;

/** The pane composer's textarea; pass `null` from the cleanup of the effect that registered it. */
export function registerComposer(el: HTMLTextAreaElement | null): void {
  composerEl = el;
}

/** The find bar's input — the history page's, and the pane mirror's. */
export function registerFind(el: HTMLInputElement | null): void {
  findEl = el;
}

/**
 * Focus the composer, if one is on screen. Returns whether it found one, so the caller can fall
 * back (there is no composer on the dashboard) rather than swallow the keystroke.
 */
export function focusComposer(): boolean {
  if (!composerEl) return false;
  composerEl.focus();
  return true;
}

/** Focus the find bar, if one is open. Returns whether it found one — `/` opens the palette if not. */
export function focusFind(): boolean {
  if (!findEl) return false;
  findEl.focus();
  return true;
}

/** Test seam — forget both registrations, as if every field had unmounted. */
export function __resetFocusTargets(): void {
  composerEl = null;
  findEl = null;
}
