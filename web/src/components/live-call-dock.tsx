import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Mic, MicOff, PhoneOff, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import {
  dismissCall,
  endCall,
  phoneLivePhase,
  startCall,
  toggleMute,
  useLiveState,
  type PhoneLivePhase,
} from "@/lib/live";
import { panePath } from "@/lib/nav";
import { paneScope } from "@/lib/hosts";
import { paneDisplayName } from "@/lib/types";
import { useOptionalRootData } from "@/lib/route-data";
import { t, tn } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { cn } from "@/lib/utils";

/**
 * THE CALL, WHILE IT IS HAPPENING — and it no longer holds the app hostage.
 *
 * This replaced a modal `BottomSheet` mounted inside the composer, and both halves of that were
 * wrong. A live call is a BACKGROUND FACT, not a task: you start one to talk about the pane you are
 * looking at, and then you want to look at another pane, the dashboard, the history. The sheet had a
 * backdrop, `aria-modal`, an Escape-to-close and a focus handoff, so for as long as the operator was
 * on a call the rest of the app was unreachable — and because the sheet was keyed by scope+pane, the
 * one navigation that WAS possible (switching panes) tore the call down mid-sentence.
 *
 * So this is a NON-MODAL dock: no backdrop, no `aria-modal`, no focus capture, no Escape handler.
 * The wrapper is `pointer-events-none` and only the surface itself takes taps, which is the existing
 * rule from `ui/toast-viewport.tsx` — an overlay that eats taps over content it is only visiting is
 * worse than the space it saved. Everything under it stays live.
 *
 * MOUNTED ONCE, IN THE ROOT LAYOUT, so the call outlives every route change. `state.paneId` is where
 * the delegation goes; navigating away changes what is on screen and nothing about the call.
 *
 * THE AUDIO ELEMENT IS WHY THIS FILE OWNS MODULE STATE. A `MediaStream` needs a real element to play
 * through, the store in `lib/live.ts` is not allowed to touch the DOM, and the element must exist
 * BEFORE the call starts. The sheet could hold it because the sheet's own mount WAS the call's
 * start; the dock is mounted from boot, so the element is here from boot too, and the composer's
 * Live button reaches it through {@link beginLiveCall} rather than owning an element of its own.
 *
 * `z-40` is the rung `ui/toast-viewport.tsx` documents: above the `z-20` sticky header and the rest
 * of the chrome, below the `z-50` sheets. A sheet is a focused task, and a call in the corner must
 * not paint over the one the operator just opened.
 */

/** The element the remote voice plays through — see the header. Set by the dock's own ref. */
let audioElement: HTMLAudioElement | null = null;

/**
 * Start a call for `paneId`, through the dock's audio element.
 *
 * The composer's Live button calls this. It deliberately does NOT reach into `lib/live.ts` directly:
 * `startCall` needs an `HTMLAudioElement`, that element belongs to this component, and a second
 * element created by the composer would be a second thing that has to be in the DOM and playing.
 */
export function beginLiveCall(paneId: string): void {
  if (audioElement === null) return;
  void startCall(paneId, audioElement);
}

/**
 * The phase, as a colour. The WORD beside it is the actual answer — this is the glanceable half, so
 * two phases sharing a hue costs nothing.
 *
 * `muted` and `working` are both amber because both mean "your voice is not moving the call along
 * right now", which is the one thing a colour can usefully say about either.
 */
const PHASE_DOT = {
  connecting: "bg-status-unknown",
  listening: "bg-status-info",
  speaking: "bg-status-done",
  muted: "bg-status-working",
  working: "bg-status-working",
  ended: "bg-status-idle",
  error: "bg-status-blocked",
} satisfies Record<PhoneLivePhase, string>;

/** `mm:ss` of realtime audio. Locale-neutral by construction, so it carries no message key. */
function elapsed(audioMs: number): string {
  const total = Math.max(0, Math.floor(audioMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Hang up, and clear the dock in the same tap.
 *
 * `endCall` tears the local half down SYNCHRONOUSLY (see its `teardown`) and only then awaits the
 * bridge, so by the time `dismissCall` runs the status is already `ended` and it will accept — the
 * same pairing the sheet's unmount cleanup used. Two calls, one operator intention, so they belong
 * behind one name rather than in a handler that could ever run half of it.
 */
function hangUp(): void {
  void endCall();
  dismissCall();
}

export function LiveCallDock() {
  useLocale();
  const call = useLiveState();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  // The dashboard snapshot, for the pane's NAME and its address. Optional because this component is
  // mounted at the root and may render one frame before the loader has settled.
  const data = useOptionalRootData();

  // THE PAGE GOING AWAY IS THE ONE THING THAT STILL ENDS A CALL FROM HERE. `pagehide` fires on iOS
  // when the tab is closed or swapped out, and `stopLive` is a `keepalive` fetch precisely so that
  // last request survives the document — otherwise the pane's agent is left holding a session
  // nobody is on until the bridge's 20s keepalive reaps it.
  //
  // `visibilitychange` USED TO END IT TOO, and that is the behaviour this dock deletes. It was
  // defensible while the call was a modal sheet — a backgrounded page was a call nobody was on. It
  // is wrong now: backgrounding the tab is what happens when the operator checks a notification, and
  // ending a live call for it is the same failure as ending one because they changed panes.
  useEffect(() => {
    const onPageHide = (): void => {
      void endCall();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Nothing to collapse back into once the call is gone — otherwise the next call would open with
  // the previous one's card already unfolded.
  useEffect(() => {
    if (call.status === "idle") setExpanded(false);
  }, [call.status]);

  const phase = phoneLivePhase(call.bridgePhase, call.muted, call.outputLevel, call.mediaUp);
  const over = call.status === "ended" || call.status === "error";
  const pane =
    call.paneId === null
      ? undefined
      : [...(data?.agents ?? []), ...(data?.shellPanes ?? [])].find(
          (candidate) => candidate.paneId === call.paneId,
        );
  // The pane's own name when the snapshot has it; its id when it does not (a pane on a peer the
  // dashboard is not currently listing). An id is a real identifier, not a placeholder.
  const paneLabel = pane === undefined ? (call.paneId ?? "") : paneDisplayName(pane);
  const operator = call.usage.operator;

  function showPane(): void {
    if (call.paneId === null) return;
    setExpanded(false);
    navigate(
      panePath(
        call.paneId,
        data === undefined ? undefined : paneScope(data.scope, pane, data.servers, data.sessions),
      ),
    );
  }

  return createPortal(
    <>
      {/* The remote voice. Hidden, because there is nothing to control here — the call's own two
          buttons are in the pill, and a native audio widget would offer a scrubber for a live
          stream. Mounted unconditionally, from boot: `startCall` needs it to already exist.

          THE EMPTY `<track>` IS NOT A STUB. A live call has no caption file to point at — the words
          do not exist until they are spoken — so the element declares that it carries no timed text
          rather than leaving the question open. The captions for this stream are the transcript rows
          in the card below, which the bridge coalesces and the phone shows as they arrive. */}
      <audio
        ref={(element) => {
          audioElement = element;
        }}
        autoPlay
        playsInline
        className="hidden"
      >
        <track kind="captions" />
      </audio>

      {call.status !== "idle" && (
        <div
          data-slot="live-call-dock"
          // `pointer-events-none` on the wrapper, re-enabled on the surface alone: the page under
          // the dock stays tappable, which is the whole point of it not being a sheet.
          //
          // The bottom inset clears the COMPOSER, not just the home indicator: the pane screen's
          // send button sits in the bottom-right corner, which is exactly where this floats, and a
          // call dock parked on Send would be the modal sheet's problem in a smaller box.
          className="pointer-events-none fixed inset-x-0 bottom-0 z-40 mx-auto flex w-full max-w-screen-sm justify-end px-3 pb-[calc(env(safe-area-inset-bottom)_+_4.5rem)]"
        >
          <div className="pointer-events-auto flex max-w-full flex-col rounded-md border border-rule bg-card shadow-lg">
            <Collapse open={expanded}>
              <div className="flex max-h-[40dvh] w-80 max-w-full flex-col gap-3 overflow-y-auto border-b border-rule px-3 py-3">
                {/* The two lines of the exchange. Each holds its slot whether or not there is text
                    in it, so nothing below moves as the conversation arrives (DESIGN.md §2). */}
                <div className="flex min-h-16 flex-col gap-2">
                  <p className="break-words text-sm">{call.user?.text ?? ""}</p>
                  {/* `font-content`: the assistant's own words, which are agent-authored text and so
                      never wear the operator's chrome face (ADR 0033). */}
                  <p className="break-words font-content text-sm text-muted-foreground">
                    {call.assistant?.text ?? ""}
                  </p>
                </div>

                {/* What the call has spent. Realtime audio is always known; the operator agent's
                    tokens and cost exist only when the pane's delegation ran one. */}
                <p className="text-xs text-muted-foreground">
                  {t("live.dock.duration", { time: elapsed(call.usage.audioMs) })}
                  {operator !== undefined && ` · ${tn("live.dock.tokens", operator.totalTokens)}`}
                  {operator?.costUsd !== undefined &&
                    ` · ${t("live.dock.cost", { amount: operator.costUsd.toFixed(4) })}`}
                </p>

                {call.error !== undefined && (
                  <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {call.error}
                  </p>
                )}

                <Button type="button" variant="outline" onClick={showPane} disabled={call.paneId === null}>
                  {t("live.dock.showPane")}
                </Button>
              </div>
            </Collapse>

            <div className="flex items-center gap-1 p-1">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className={cn("size-2.5 shrink-0 rounded-full", PHASE_DOT[phase])} />
                {/* `role="status"`: the phase is the one thing here that changes on its own, and a
                    phone held to an ear is exactly the case where it is not being looked at. */}
                <span role="status" className="shrink-0 text-sm font-medium">
                  {t(`live.phase.${phase}`)}
                </span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">{paneLabel}</span>
              </button>

              <Button
                type="button"
                size="icon"
                variant={call.muted ? "default" : "outline"}
                className="size-11"
                disabled={over}
                aria-pressed={call.muted}
                aria-label={call.muted ? t("live.unmute") : t("live.mute")}
                onClick={toggleMute}
              >
                {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </Button>
              {/* One button, two jobs, and they are the same job at two moments: while the call is up
                  it hangs up, and once it is over — ended by the bridge, or failed — it clears the
                  dock. A separate dismiss control would be a second way to make the same thing go
                  away. */}
              <Button
                type="button"
                size="icon"
                variant="destructive"
                className="size-11"
                aria-label={over ? t("live.dock.dismiss") : t("live.end")}
                onClick={over ? dismissCall : hangUp}
              >
                {over ? <X className="size-4" /> : <PhoneOff className="size-4" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
