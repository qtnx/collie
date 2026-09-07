import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { CornerDownLeft, Search } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { AgentIcon } from "@/components/agent-icon";
import { cn } from "@/lib/utils";
import { paneScope } from "@/lib/hosts";
import { homePath, packPath, panePath, settingsPath } from "@/lib/nav";
import { paneDisplayName, statusLabel, type AgentView } from "@/lib/types";
import { useOptionalRootData } from "@/lib/route-data";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// "Go to" — the keyboard's way across the whole app. Mod+K / Mod+P from anywhere, `/` where the page
// has no find bar of its own.
//
// It lists what the SNAPSHOT already holds (root loader data, the same array the dashboard renders)
// and fetches nothing: this sheet exists to move you between things that are already on the poll
// loop, and a palette that had to load before it could answer would be slower than tapping the row.
// Absent snapshot data — the palette opened during the very first load — leaves the pane section
// empty and the three page rows working, which is the honest state rather than a spinner.
//
// Filtering is plain substring over the row's own words, not a fuzzy scorer: an operator typing here
// knows the pane's name, and a scorer's surprising near-misses cost more than they buy on a list this
// size. Rows are matched on everything the row SHOWS, so what you can read you can type.

interface NavPaletteProps {
  open: boolean;
  onClose: () => void;
}

/** One row of the list — a pane, or one of the fixed pages. Both carry the path they navigate to. */
interface NavRow {
  key: string;
  path: string;
  label: string;
  detail: string;
  /** The agent behind a pane row, so it can wear its mark; absent on the page rows. */
  agent?: string;
  section: "panes" | "pages";
}

export function NavPalette({ open, onClose }: NavPaletteProps) {
  useLocale();
  const navigate = useNavigate();
  // Optional: the palette is mounted at the data root and `?` can be pressed during the first load.
  const data = useOptionalRootData();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const rows = useMemo<NavRow[]>(() => {
    const scope = data?.scope;
    const pageRows: NavRow[] = [
      { key: "page:home", path: homePath(scope), label: t("nav.palette.row.home"), detail: "", section: "pages" },
      { key: "page:settings", path: settingsPath(scope), label: t("nav.palette.row.settings"), detail: "", section: "pages" },
      { key: "page:pack", path: packPath(scope), label: t("nav.palette.row.pack"), detail: "", section: "pages" },
    ];
    if (!data) return pageRows;
    // Agents first, then bare shells — the dashboard's own order, so the list you scan here is the
    // list you already know. A pane is opened with ITS host, never the ambient one (lib/hosts.ts):
    // the same rule the dashboard's row tap follows, and what stops a reply landing on the right
    // pane name on the wrong machine.
    const paneRows = [...data.agents, ...data.shellPanes].map((pane: AgentView): NavRow => {
      const space = pane.workspaceLabel || pane.workspaceId;
      const where = pane.tabLabel ? `${space} · ${pane.tabLabel}` : space;
      return {
        key: `pane:${pane.host ?? ""}\u0000${pane.paneId}`,
        path: panePath(pane.paneId, paneScope(data.scope, pane, data.servers, data.sessions)),
        label: paneDisplayName(pane),
        detail: `${where} · ${statusLabel(pane.status)}`,
        agent: pane.kind === "shell" ? undefined : pane.agent,
        section: "panes",
      };
    });
    return [...paneRows, ...pageRows];
  }, [data]);

  const q = query.trim().toLowerCase();
  const list = q
    ? rows.filter((r) => `${r.label} ${r.detail}`.toLowerCase().includes(q))
    : rows;

  // A fresh open starts empty and at the top; typing re-aims at the first match, so Enter always
  // takes the row the operator is looking at rather than one scrolled away by an earlier cursor.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    setCursor(0);
  }, [query]);

  function go(row: NavRow) {
    onClose();
    navigate(row.path);
  }

  // j/k move only while the input is EMPTY: once there is a query those letters are the query, and
  // a palette that ate them would be unable to find a pane called "jam". The arrows always move.
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const vim = query === "";
    if (e.key === "ArrowDown" || (vim && e.key === "j")) {
      e.preventDefault();
      setCursor((c) => (list.length === 0 ? 0 : Math.min(c + 1, list.length - 1)));
    } else if (e.key === "ArrowUp" || (vim && e.key === "k")) {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = list[cursor];
      if (row) go(row);
    }
    // Escape is deliberately NOT handled here: BottomSheet already closes on it, and a second
    // handler would be a second answer to the same key.
  }

  let lastSection: NavRow["section"] | null = null;

  return (
    <BottomSheet open={open} onClose={onClose} title={t("nav.palette.title")} className="max-h-[85dvh]">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          inputMode="search"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("nav.palette.placeholder")}
          aria-label={t("nav.palette.placeholder")}
          className="h-11 w-full rounded-md border border-input bg-transparent pl-9 pr-3 text-base placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </div>

      <div className="flex flex-col gap-1">
        {list.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("nav.palette.empty", { query })}
          </p>
        )}
        {list.map((row, i) => {
          const heading = row.section === lastSection ? null : row.section;
          lastSection = row.section;
          const selected = i === cursor;
          return (
            <div key={row.key}>
              {heading && (
                <p className="mb-1 mt-2 text-[11px] uppercase tracking-wide text-muted-foreground first:mt-0">
                  {heading === "panes" ? t("nav.palette.section.panes") : t("nav.palette.section.pages")}
                </p>
              )}
              <button
                type="button"
                onClick={() => go(row)}
                // The cursor is a POSITION IN A LIST OF BUTTONS, not a selection and not focus:
                // focus stays in the input so typing keeps narrowing the list, and Enter activates
                // whichever row this marks. `aria-current` is the attribute for exactly that ("the
                // one within a set the user is on") and it is valid on a plain button, which
                // `aria-selected` is not — that one belongs to option/tab/row roles, and giving the
                // button one of those would promise a listbox this sheet does not implement.
                aria-current={selected}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors active:scale-[0.99]",
                  selected ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                {row.agent && <AgentIcon agent={row.agent} className="size-4 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{row.label}</div>
                  {row.detail && <p className="truncate text-xs text-muted-foreground">{row.detail}</p>}
                </div>
                {selected && <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" />}
              </button>
            </div>
          );
        })}
      </div>
    </BottomSheet>
  );
}
