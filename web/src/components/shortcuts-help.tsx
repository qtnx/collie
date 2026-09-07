import { BottomSheet } from "@/components/ui/sheet";
import { KEYMAP, chordFor } from "@/lib/keymap";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// The `?` sheet: every shortcut, rendered straight off `KEYMAP`. This component holds NO list of its
// own — the table in lib/keymap.ts is the same one the resolver reads, so a binding that exists is
// documented and one that is documented exists. That is the whole reason the map is data.
//
// The keycaps are not translated (see `chordFor`): they name physical keys on the operator's
// keyboard, and a localised "Esc" would name a key that is not there. The DESCRIPTIONS are, because
// those are prose about what Collie does.

interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps) {
  useLocale();

  return (
    <BottomSheet open={open} onClose={onClose} title={t("nav.help.title")} className="max-h-[85dvh]">
      <p className="mb-3 text-sm text-muted-foreground">{t("nav.help.hint")}</p>
      <dl className="flex flex-col divide-y divide-rule">
        {KEYMAP.map((binding) => (
          <div key={`${binding.action}:${binding.keys[0] ?? ""}`} className="flex items-center gap-4 py-2.5">
            <dt className="shrink-0">
              {/* `font-mono` here is the one place it earns its keep: these are keycaps, and a
                  proportional face makes `[` and `]` hard to tell apart at this size. */}
              <kbd className="rounded-md border border-rule bg-muted/50 px-2 py-1 font-mono text-xs">
                {chordFor(binding)}
              </kbd>
            </dt>
            <dd className="min-w-0 flex-1 text-sm">{t(binding.labelKey)}</dd>
          </div>
        ))}
      </dl>
    </BottomSheet>
  );
}
