import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { resolveKey, type KeyTarget } from "@/lib/keymap";
import { focusComposer, focusFind } from "@/lib/focus-targets";
import { homePath, panePath, settingsPath } from "@/lib/nav";
import { liveState, toggleMute } from "@/lib/live";
import { paneScope } from "@/lib/hosts";
import { useOptionalRootData } from "@/lib/route-data";

// THE global keyboard handler, mounted once in RootLayout. One window listener for the whole app.
//
// The split with lib/keymap.ts is deliberate and load-bearing: the resolver decides WHICH action a
// keystroke names, purely, and everything here is the part that cannot be pure — where focus is,
// which rows are on screen, whether a sheet already owns the key, what the router should do.
//
// ── WHAT THIS HANDLER REFUSES TO TOUCH ────────────────────────────────────────────────────────────
// While a modal is open (any `[role=dialog]` — every BottomSheet in the app renders one), only the
// palette's own Mod+K survives: the sheet owns Escape, owns Enter, owns its arrow keys, and a second
// handler answering the same press is how a sheet closes twice or navigates behind itself. The pane
// mirror's zen mode binds Escape too (agent-chat.tsx), which is why `back` is skipped there as well —
// zen has no dialog role, so it is named by the same "is a text field focused" check the resting
// case uses plus the dialog probe below.
//
// ROVING FOCUS, NOT A SELECTION MODEL. `j`/`k` move the browser's own focus across the elements
// marked `[data-nav-row]` in document order, and `open` clicks whatever is focused. There is no
// "selected index" state to keep in sync with a list that re-renders on every poll — the DOM is the
// list, and focus is the cursor. That is also what makes `open` correct for free: it activates the
// real button, with the real handler, on the real row.

/** Which surfaces the hook can open on the app's behalf. `null` = nothing open. */
export type GlobalKeyOverlay = "palette" | "help" | null;

/** What RootLayout needs to render those surfaces — the hook's whole public shape. */
export interface GlobalKeys {
  overlay: GlobalKeyOverlay;
  closeOverlay: () => void;
}

/** True when the event's target is somewhere the operator is writing. */
function targetOf(node: EventTarget | null): KeyTarget {
  if (!(node instanceof HTMLElement)) return "other";
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable
    ? "text"
    : "other";
}

export function useGlobalKeys(): GlobalKeys {
  const navigate = useNavigate();
  const location = useLocation();
  const data = useOptionalRootData();
  const [overlay, setOverlay] = useState<GlobalKeyOverlay>(null);
  // The `g` prefix, held in a ref rather than state: it changes on a keystroke the UI does not
  // render, so re-rendering the whole app to remember one pending letter would be pure waste.
  const pending = useRef<string | null>(null);

  // The listener is attached once and reads everything mutable through this ref, so a poll landing a
  // new snapshot (which it does every 1.5s) does not tear down and re-attach a window listener.
  const latest = useRef({ navigate, location, data, overlay });
  latest.current = { navigate, location, data, overlay };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { navigate: go, location: loc, data: snapshot, overlay: open } = latest.current;
      const target = targetOf(e.target);
      const { action, pending: next } = resolveKey(
        {
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          target,
        },
        pending.current,
      );
      pending.current = next;
      if (action === "none") return;

      // A sheet, dialog or drawer is on screen: it owns the keyboard. The palette's own shortcut is
      // the single exception, so Mod+K reaches the palette even from a sheet that opened over it.
      const modal = open !== null || document.querySelector("[role=dialog]") !== null;
      if (modal && action !== "palette") return;

      const scope = snapshot?.scope;

      switch (action) {
        case "palette": {
          e.preventDefault();
          setOverlay("palette");
          return;
        }
        case "help": {
          e.preventDefault();
          setOverlay("help");
          return;
        }
        case "blur": {
          // Escape inside a field leaves it — and leaving is the whole action. No navigation
          // follows, or Escape out of the composer would also walk the operator off the pane.
          if (e.target instanceof HTMLElement) e.target.blur();
          return;
        }
        case "down":
        case "up": {
          const rows = [...document.querySelectorAll<HTMLElement>("[data-nav-row]")];
          if (rows.length === 0) return;
          e.preventDefault();
          const at = rows.indexOf(document.activeElement instanceof HTMLElement ? document.activeElement : rows[0]!);
          // No row focused yet (`at === -1`)? `down` takes the first and `up` takes the last, so the
          // first press always lands somewhere rather than doing nothing.
          const to =
            at === -1
              ? action === "down"
                ? 0
                : rows.length - 1
              : Math.min(Math.max(at + (action === "down" ? 1 : -1), 0), rows.length - 1);
          rows[to]?.focus();
          return;
        }
        case "open": {
          const row = document.activeElement;
          if (!(row instanceof HTMLElement) || !row.matches("[data-nav-row]")) return;
          // Enter on a focused <button> already activates it; only the vim `l` needs the click.
          if (e.key === "Enter") return;
          e.preventDefault();
          row.click();
          return;
        }
        case "back": {
          e.preventDefault();
          // Home is the floor, and "back" is a step UP the app's own tree — never `history.back()`,
          // which from a deep link opened in a fresh tab walks out of Collie entirely (observed:
          // about:blank). A pane's history view returns to the pane; everything else returns home.
          const home = homePath(scope);
          if (loc.pathname === home.split("?")[0]) return;
          const history = loc.pathname.match(/^(\/pane\/[^/]+)\/history$/);
          go(history ? `${history[1]}${home.slice(1)}` : home);
          return;
        }
        case "home": {
          e.preventDefault();
          go(homePath(scope));
          return;
        }
        case "settings": {
          e.preventDefault();
          go(settingsPath(scope));
          return;
        }
        case "search": {
          e.preventDefault();
          // The find bar where a page has one (history, the pane mirror); the palette everywhere
          // else, because "/" that does nothing on the dashboard would just look broken.
          if (!focusFind()) setOverlay("palette");
          return;
        }
        case "compose": {
          // Only where a composer is mounted. Elsewhere the letter is simply unbound — NOT
          // preventDefault'd, so nothing about the page changes.
          if (focusComposer()) e.preventDefault();
          return;
        }
        case "prevPane":
        case "nextPane": {
          if (!snapshot) return;
          const current = paneIdFrom(loc.pathname);
          if (current === undefined) return;
          const here = snapshot.agents.find((p) => p.paneId === current);
          if (!here) return;
          // Neighbours WITHIN the space, in snapshot order — the same order the space view lists
          // them in, so `[` and `]` walk the list the operator can see.
          const siblings = snapshot.agents.filter((p) => p.workspaceId === here.workspaceId);
          const at = siblings.indexOf(here);
          const to = siblings[at + (action === "nextPane" ? 1 : -1)];
          if (!to) return;
          e.preventDefault();
          go(panePath(to.paneId, paneScope(snapshot.scope, to, snapshot.servers, snapshot.sessions)));
          return;
        }
        case "mute": {
          // Only while a call is up: `m` is otherwise an ordinary letter, and muting nothing would
          // be a shortcut that silently does something invisible.
          if (liveState().status === "idle") return;
          e.preventDefault();
          toggleMute();
          return;
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const closeOverlay = useCallback(() => setOverlay(null), []);
  return { overlay, closeOverlay };
}

/** The pane id in `/pane/:paneId(/history)`, decoded; undefined on every other route. */
function paneIdFrom(pathname: string): string | undefined {
  const match = /^\/pane\/([^/]+)/.exec(pathname);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}
