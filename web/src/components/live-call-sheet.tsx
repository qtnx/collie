import { useEffect, useRef } from "react";
import { Mic, MicOff, PhoneOff } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { dismissCall, endCall, phoneLivePhase, startCall, toggleMute, useLiveState } from "@/lib/live";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/**
 * THE CALL, WHILE IT IS HAPPENING — one phase word, the two lines being said, and two controls.
 *
 * DELIBERATELY NOT A VISUALIZER. What an operator holding a phone to their ear needs from the screen
 * is the answer to "is it hearing me, and is it doing something": a level meter answers neither
 * (a bar that moves proves audio arrived, not that anything was understood), and it would be the one
 * element on screen repainting ten times a second. The phase word answers both, and it changes only
 * when the answer does — `speaking` and `listening` come from the same level the meter would draw,
 * read through a threshold in lib/live.ts.
 *
 * The AUDIO ELEMENT is why this component owns a ref rather than the store: a `MediaStream` needs a
 * real element to play through, the store is not allowed to touch the DOM, and the element must
 * exist BEFORE the call starts. So the sheet mounts it hidden, hands it to `startCall`, and the
 * store attaches the remote track to it.
 */
export function LiveCallSheet({
  open,
  paneId,
  onClose,
}: {
  open: boolean;
  /** The pane this call delegates into. The sheet is keyed by it, so a pane switch ends the call. */
  paneId: string;
  onClose: () => void;
}) {
  useLocale();
  const audioRef = useRef<HTMLAudioElement>(null);
  const call = useLiveState();

  // START ON OPEN, END ON CLOSE — the sheet's own lifetime IS the call's. The element is in the DOM
  // by the time this effect runs (refs are attached before effects), which is the whole reason the
  // start lives here rather than in the button that opened the sheet.
  useEffect(() => {
    if (!open) return;
    const element = audioRef.current;
    if (!element) return;
    void startCall(paneId, element);
    return () => {
      void endCall();
      dismissCall();
    };
  }, [open, paneId]);

  // A BACKGROUNDED PAGE IS A CALL NOBODY IS ON. iOS suspends a hidden tab's timers, so the poll that
  // doubles as the bridge's keepalive stops and the session would be reaped 20 s later anyway —
  // ending it here means the pane's agent is released at once and the operator is told why, rather
  // than finding a dead call when they come back.
  useEffect(() => {
    if (!open) return;
    const onHidden = (): void => {
      if (document.visibilityState === "hidden") void endCall();
    };
    document.addEventListener("visibilitychange", onHidden);
    // `pagehide` is the one that fires on iOS when the tab is closed or swapped out; `stopLive` is a
    // `keepalive` fetch precisely so this last request survives the document.
    window.addEventListener("pagehide", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onHidden);
    };
  }, [open]);

  const phase = phoneLivePhase(call.bridgePhase, call.muted, call.outputLevel);
  const over = call.status === "ended" || call.status === "error";

  return (
    <BottomSheet open={open} onClose={onClose} title={t("live.title")}>
      {/* The remote voice. Hidden, because there is nothing to control here — the call's own two
          buttons are below, and a native audio widget would offer a scrubber for a live stream.

          THE EMPTY `<track>` IS NOT A STUB. A live call has no caption file to point at — the words
          do not exist until they are spoken — so the element declares that it carries no timed text
          rather than leaving the question open. The captions for this stream are the transcript rows
          rendered below it, which the bridge coalesces and the phone shows as they arrive. */}
      <audio ref={audioRef} autoPlay playsInline className="hidden">
        <track kind="captions" />
      </audio>
      <div className="flex flex-col gap-3">
        {/* `role="status"`: the phase is the one thing on screen that changes on its own, and a
            phone held to an ear is exactly the case where it may not be being looked at. */}
        <p role="status" className="text-sm font-medium text-muted-foreground">
          {t(`live.phase.${phase}`)}
        </p>

        {/* The two lines of the exchange. Each holds its slot whether or not there is text in it, so
            the buttons below never move as the conversation arrives (DESIGN.md §2). */}
        <div className="flex min-h-24 flex-col gap-2">
          <p className="text-sm break-words">{call.user?.text ?? ""}</p>
          {/* `font-content`: the assistant's own words, which are agent-authored text and so never
              wear the operator's chrome face (ADR 0033). */}
          <p className="font-content text-sm break-words text-muted-foreground">
            {call.assistant?.text ?? ""}
          </p>
        </div>

        {call.error !== undefined && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {call.error}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            type="button"
            variant={call.muted ? "default" : "outline"}
            size="lg"
            className="flex-1"
            disabled={over}
            aria-pressed={call.muted}
            onClick={toggleMute}
          >
            {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            {call.muted ? t("live.unmute") : t("live.mute")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="lg"
            className="flex-1"
            onClick={onClose}
          >
            <PhoneOff className="size-4" />
            {t("live.end")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
