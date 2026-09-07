// THE keyboard map, as data. One table — {@link KEYMAP} — is read by the resolver below and by the
// help sheet (components/shortcuts-help.tsx), so a binding and the line that documents it cannot
// drift: adding a row is what adds both the behaviour and its help entry.
//
// The resolver is PURE. It takes a flattened key event and the pending prefix, and answers with an
// action plus the next pending value; it touches no DOM, no router and no store. Everything about
// context — is a call up, is there a composer on this page, is a sheet open — is the caller's
// business (hooks/use-global-keys.ts), which is what keeps this file testable as a table.
//
// TEXT IS THE HARD BOUNDARY. While focus is in a field, a bare `j` is the letter j and nothing else;
// only the two bindings marked `text: "also"` (the palette) and `text: "only"` (Escape, which leaves
// the field) survive there. Getting that wrong would type shortcuts into an operator's prompt.

import type { MessageKey } from "@/lib/i18n";

/** Where the keystroke landed: an editable field, or anywhere else. */
export type KeyTarget = "text" | "other";

/** What the resolver was given — a KeyboardEvent flattened to the fields a binding can depend on. */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: KeyTarget;
}

/**
 * What the caller should do. `none` covers both "no binding" and "a prefix was armed" — the pending
 * value carries that half.
 */
export type KeyAction =
  | "none"
  | "palette"
  | "help"
  | "down"
  | "up"
  | "open"
  | "back"
  | "blur"
  | "home"
  | "settings"
  | "search"
  | "compose"
  | "prevPane"
  | "nextPane"
  | "mute";

/** Where a binding is allowed to fire: outside fields only (default), inside them too, or ONLY inside. */
type TextRule = "never" | "also" | "only";

export interface KeyBinding {
  action: Exclude<KeyAction, "none">;
  /** `KeyboardEvent.key` values that trigger it. `?` already arrives shifted, so no shift flag. */
  keys: readonly string[];
  /** Needs Mod held (⌘ or Ctrl — see {@link isMod}); a binding without it refuses a modified press. */
  mod?: true;
  /** Needs {@link LEADER} pressed first — the vim `g` prefix. */
  prefix?: typeof LEADER;
  /** Default `"never"`: a bare letter must never fire while the operator is typing. */
  text?: TextRule;
  /** The help sheet's one-line description of what it does. */
  labelKey: MessageKey;
}

/** The vim prefix. Pressed alone it arms; the next key is looked up among the `prefix` rows. */
export const LEADER = "g";

/**
 * Every binding, in the order the help sheet lists them: move, open, navigate, then the call.
 *
 * Nothing destructive is bound, deliberately — ending a call is a two-tap affordance on the dock and
 * stays there. A keystroke that hangs up on a mis-hit is not a shortcut, it is a trap.
 */
export const KEYMAP: readonly KeyBinding[] = [
  { action: "palette", keys: ["k", "K", "p", "P"], mod: true, text: "also", labelKey: "nav.help.action.palette" },
  { action: "help", keys: ["?"], labelKey: "nav.help.action.help" },
  { action: "down", keys: ["j"], labelKey: "nav.help.action.down" },
  { action: "up", keys: ["k"], labelKey: "nav.help.action.up" },
  { action: "open", keys: ["Enter", "l"], labelKey: "nav.help.action.open" },
  { action: "back", keys: ["Escape", "h"], labelKey: "nav.help.action.back" },
  { action: "blur", keys: ["Escape"], text: "only", labelKey: "nav.help.action.blur" },
  { action: "home", keys: ["h"], prefix: LEADER, labelKey: "nav.help.action.home" },
  { action: "settings", keys: ["s"], prefix: LEADER, labelKey: "nav.help.action.settings" },
  { action: "search", keys: ["/"], labelKey: "nav.help.action.search" },
  { action: "compose", keys: ["i"], labelKey: "nav.help.action.compose" },
  { action: "prevPane", keys: ["["], labelKey: "nav.help.action.prevPane" },
  { action: "nextPane", keys: ["]"], labelKey: "nav.help.action.nextPane" },
  { action: "mute", keys: ["m"], labelKey: "nav.help.action.mute" },
];

export interface KeyResolution {
  action: KeyAction;
  /** The prefix now armed, or null. Feed it back on the next keystroke. */
  pending: string | null;
}

/** Where a keystroke landed, against a binding's `text` rule. */
const allowed = (binding: KeyBinding, target: KeyTarget): boolean =>
  target === "text" ? (binding.text ?? "never") !== "never" : (binding.text ?? "never") !== "only";

/**
 * One keystroke → one action. `pending` is whatever the previous call returned, so a two-key chord
 * (`g` then `h`) is two ordinary calls with the caller holding one string between them.
 *
 * A prefix that is followed by an unbound key does NOT swallow it: the pending value clears and the
 * key resolves on its own terms, so `g` then `j` still moves down rather than doing nothing.
 */
export function resolveKey(event: KeyEventLike, pending: string | null): KeyResolution {
  // Mod is ⌘ OR Ctrl, both accepted rather than platform-sniffed: a phone paired with a bluetooth
  // keyboard reports a platform that says little about the keycaps in front of the operator, and
  // Ctrl+K on a Mac is bound to nothing here that could conflict.
  const mod = event.metaKey || event.ctrlKey;
  // Alt is never part of a binding here, and it is how several layouts type accented characters —
  // so a press that carries it is the operator writing, not navigating.
  if (event.altKey) return { action: "none", pending: null };

  if (pending === LEADER && !mod) {
    const chord = KEYMAP.find((b) => b.prefix === LEADER && b.keys.includes(event.key));
    if (chord) return { action: chord.action, pending: null };
  }

  // Arming the prefix. Only outside a field, and only unmodified — Ctrl+G is not a leader.
  if (!mod && event.target === "other" && event.key === LEADER) {
    return { action: "none", pending: LEADER };
  }

  const match = KEYMAP.find(
    (b) =>
      b.prefix === undefined &&
      (b.mod ?? false) === mod &&
      b.keys.includes(event.key) &&
      allowed(b, event.target),
  );
  return { action: match?.action ?? "none", pending: null };
}

/**
 * The keycaps a binding wears, for the help sheet. Deliberately NOT translated: these name physical
 * keys on the operator's keyboard, and a localised "Enter" would name a key that isn't there — the
 * same reason the terminal mirror is never translated.
 */
export function chordFor(binding: KeyBinding): string {
  const key = binding.keys[0] ?? "";
  const cap = key === "Escape" ? "Esc" : key;
  if (binding.mod) return `⌘/Ctrl+${cap.toUpperCase()}`;
  return binding.prefix ? `${binding.prefix} ${cap}` : cap;
}
