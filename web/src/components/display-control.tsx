import { BookOpen, MonitorSmartphone } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { setDesignDisplay, useDesignPrefs, type DisplayMode } from "@/lib/design";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The panel, not the palette — which is why this is its own card and not a fourth option inside
// Appearance. Light and Dark are a preference a reader can change by mood; this one is a fact about
// the hardware in their hands, and it overrides the theme rather than joining it (index.css
// `:root.eink` pins `color-scheme: light` and collapses the palette to black and white). Offering
// "Dark" and "E-ink" in one row would imply they compose, and they cannot.

const OPTIONS: ReadonlyArray<{ value: DisplayMode; labelKey: MessageKey; icon: LucideIcon }> = [
  { value: "screen", labelKey: "settings.display.option.screen", icon: MonitorSmartphone },
  { value: "eink", labelKey: "settings.display.option.eink", icon: BookOpen },
];

/** Settings card. Mirrors ThemeControl's icon/title/description shape exactly — they are siblings. */
export function DisplayControl() {
  useLocale();
  const { display } = useDesignPrefs();
  const Icon = OPTIONS.find((o) => o.value === display)?.icon ?? MonitorSmartphone;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.display.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.display.description")}</p>
          </div>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={t("settings.display.title")}
        className="flex gap-1 border-t border-border p-2"
      >
        {OPTIONS.map((option) => {
          const selected = option.value === display;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setDesignDisplay(option.value)}
              className={cn(
                // min-h-11 = 44px, the tap target every control in Settings shares.
                "flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                // A filled pill, not a tint — and in e-ink that fill is the ONLY thing left saying
                // which one is on, since the tint tokens are all white there. `font-medium` stays
                // unconditional so the label cannot change width on selection.
                selected ? "bg-primary text-primary-foreground" : "text-muted-foreground active:bg-muted",
              )}
            >
              <option.icon className="size-4 shrink-0" />
              {t(option.labelKey)}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
