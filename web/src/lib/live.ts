import { useEffect, useSyncExternalStore } from "react";

import { pollLive, startLive, stopLive } from "@/lib/api";
import { getLocaleSnapshot, t } from "@/lib/i18n";
import { LivePeer, playConnectedCue } from "@/lib/live-peer";
import { getLiveCapability, loadOperatorCommands, subscribeOperatorConfig } from "@/lib/operator-config";
import type {
  LiveCapability,
  LivePhase,
  LiveTranscriptRow,
  LiveUsage,
  LiveViewResponse,
} from "@/lib/types";

// THE PHONE'S HALF OF A LIVE CALL — one call at a time, held in module state.
//
// A call is not component state. It owns a microphone, a peer connection and a poll, all of which
// must survive the dock re-rendering and none of which may be started twice; and ending it is the
// one thing that has to happen even when the page is going away. So this is the same module-store
// idiom the rest of `lib/` uses (lib/haptics.ts, lib/stt.ts's hands-free): module state, a listeners
// Set, and a `useSyncExternalStore` snapshot — the store is the call, and the dock is a view of it.
//
// THE STORE OUTLIVES EVERY ROUTE, and that is now load-bearing rather than incidental. The call used
// to be a modal sheet inside the composer, keyed by scope+pane, so a pane switch unmounted it and
// tore the call down; `components/live-call-dock.tsx` is mounted once in the root layout instead, and
// this module is what lets that work — a call started on one pane keeps delegating into `paneId`
// while the operator reads anything else.
//
// TWO GATES DECIDE WHETHER A LIVE BUTTON EXISTS, exactly as they do for the microphone (lib/stt.ts):
//
//   1. **The bridge published a capability.** `/api/config` carries `live` only when the operator
//      ran `collie live on`; absent is the feature being off, which is also what an older bridge
//      sends. Absent draws NO button — not a disabled one.
//   2. **This browser can actually hold a call.** `RTCPeerConnection` plus `getUserMedia` plus a
//      secure context. Over plain HTTP (a tailnet URL without `tailscale serve`) `mediaDevices` is
//      simply not there, and a control that provably cannot work is worse than no control.
//
// THE PHASE THE OPERATOR READS IS NOT THE BRIDGE'S PHASE, and that is the point of `phoneLivePhase`
// below: muted and speaking are facts only this browser holds (mute never leaves the phone, and the
// assistant's voice arrives on the peer connection, not through Collie), so the word on screen is a
// merge of what the bridge knows and what the audio is doing. The bridge still wins whenever it has
// something the phone cannot see — the call is over, or the agent is working on the delegation.

/** How often the phone asks for new transcript rows while a call is up. Also the bridge's keepalive:
 *  it ends a session nobody has asked about for 20 s, so this is what says the phone is still here. */
const POLL_INTERVAL_MS = 1000;

/** Output level above which the assistant counts as speaking rather than the line being open. Low
 *  enough to catch a quiet word, high enough that room noise on the far side is not "speaking". */
const SPEAKING_LEVEL = 0.015;

/** Where the phone thinks the call is — the bridge's phases plus the two only this browser knows. */
export type PhoneLivePhase = LivePhase | "muted" | "speaking";

export interface LiveState {
  /** `idle` before a call and after one is dismissed; the dock is on screen for everything else. */
  status: "idle" | "connecting" | "active" | "ended" | "error";
  /** The pane this call is delegating into. `null` while idle. */
  paneId: string | null;
  /** The bridge's own last word, or `connecting` before the first poll lands. */
  bridgePhase: LivePhase;
  /**
   * The peer connection reached `connected`. The bridge's sideband does not always see the
   * session start, so this browser's own transport is what moves `connecting` to `listening`.
   */
  mediaUp: boolean;
  muted: boolean;
  /** Assistant output level, 0..1, sampled every 100 ms. Drives the `speaking` phase. */
  outputLevel: number;
  /** The latest line from each side — a row REPLACES the earlier one with the same (role, turn). */
  user?: LiveTranscriptRow;
  assistant?: LiveTranscriptRow;
  /** A user-presentable sentence. Set with `status: "error"`, and never a bare code. */
  error?: string;
  /** Realtime audio and operator agent tokens/cost consumed so far. */
  usage: LiveUsage;
}

const IDLE: LiveState = {
  status: "idle",
  paneId: null,
  bridgePhase: "connecting",
  mediaUp: false,
  muted: false,
  outputLevel: 0,
  usage: { audioMs: 0 },
};

let state: LiveState = IDLE;
const listeners = new Set<() => void>();

/** The live call itself. Deliberately NOT in `state`: none of it is renderable, and a snapshot that
 *  changed identity when a timer id did would re-render the dock ten times a second. */
let peer: LivePeer | null = null;
let sessionId: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSeq = 0;

function setState(next: Partial<LiveState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function liveState(): LiveState {
  return state;
}

/** Reactive read of the call. The dock and the composer button both go through this. */
export function useLiveState(): LiveState {
  return useSyncExternalStore(subscribe, liveState, liveState);
}

/**
 * Whether this browser can hold a call at all — the second of the two gates in the header.
 *
 * `isSecureContext` is checked explicitly rather than left to `getUserMedia` throwing: on an
 * insecure origin the whole `mediaDevices` object is absent, so the failure would arrive as a
 * TypeError at the moment of the tap instead of as a button that was never drawn.
 */
export function liveCallSupported(): boolean {
  if (!globalThis.isSecureContext) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  // Presence, not shape: the question is whether this runtime ships WebRTC at all. jsdom and an
  // insecure origin both answer no, and neither of them is a case where a partially-formed
  // `RTCPeerConnection` would need telling apart from a real one.
  return "RTCPeerConnection" in globalThis;
}

/**
 * The bridge's live-call block, or `null` when this phone must draw no Live button — either because
 * the operator never turned it on or because this browser cannot hold a call. One predicate, so the
 * composer's button and anything else that asks can never disagree about whether the feature exists.
 */
export function useLiveCapability(): LiveCapability | null {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  const capability = useSyncExternalStore(
    subscribeOperatorConfig,
    getLiveCapability,
    getLiveCapability,
  );
  // Evaluated per render rather than memoised: it reads browser globals that do not change within a
  // page, and a memo keyed on nothing would only hide that.
  return capability !== null && liveCallSupported() ? capability : null;
}

/**
 * The one word the dock shows, merged from the bridge's phase and the browser's own audio.
 *
 * ORDER IS THE WHOLE RULE, and it is precedence, not preference:
 *   1. `ended` / `error` — the call is over; nothing the microphone is doing changes that.
 *   2. `muted` — the operator's own act, and the one thing they need confirmed above all else.
 *   3. `working` — the bridge saw the model delegate; the agent is typing in the pane.
 *   4. `speaking` — audio is arriving, so the assistant has the floor.
 *   5. `listening` — the line is open and quiet, which is the resting state of a call.
 */
export function phoneLivePhase(
  bridgePhase: LivePhase,
  muted: boolean,
  outputLevel: number,
  mediaUp = false,
): PhoneLivePhase {
  if (bridgePhase === "ended" || bridgePhase === "error") return bridgePhase;
  if (muted) return "muted";
  if (bridgePhase === "working") return "working";
  if (bridgePhase === "connecting" && !mediaUp) return "connecting";
  return outputLevel > SPEAKING_LEVEL ? "speaking" : "listening";
}

/** The two lines a call has on screen — the latest turn from each side, or neither yet. */
export interface LiveTranscriptLines {
  user?: LiveTranscriptRow;
  assistant?: LiveTranscriptRow;
}

/**
 * Fold one poll's rows into the two lines on screen.
 *
 * A later row with the same `(role, turn)` REPLACES the earlier one — that is how a partial
 * transcript grows into its final sentence — and rows arrive ascending, so the last row for each
 * role in a batch is the current one. Only the CURRENT turn is kept: this is a call, not a
 * transcript view, and the dock shows what is being said now.
 */
export function foldTranscriptRows(
  previous: LiveTranscriptLines,
  rows: readonly LiveTranscriptRow[],
): LiveTranscriptLines {
  let { user, assistant } = previous;
  for (const row of rows) {
    const current = row.role === "user" ? user : assistant;
    // A row from an OLDER turn is stale (the poll may overlap a turn boundary); same turn replaces.
    if (current && current.turn > row.turn) continue;
    if (row.role === "user") user = row;
    else assistant = row;
  }
  return { user, assistant };
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Tear the local half down and report why. The bridge is told separately (see `endCall`). */
function teardown(next: Partial<LiveState>): void {
  stopPolling();
  peer?.stop();
  peer = null;
  setState(next);
}

async function poll(): Promise<void> {
  const id = sessionId;
  if (id === null) return;
  let view: LiveViewResponse;
  try {
    view = await pollLive(id, lastSeq);
  } catch {
    // One missed poll is a phone in a lift, not a dead call — the bridge holds the session for 20 s
    // and the next tick is a second away. Only an ANSWERED refusal ends it.
    return;
  }
  if (id !== sessionId) return; // a newer call started while this poll was in flight
  if (!view.ok) {
    // The one refusal a poll can carry: the bridge reaped the session because its 20 s keepalive
    // lapsed while this phone was away. Its own sentence, because "the collie ended it" is a
    // different fact from a call that failed while being held.
    void endCall(t("live.error.gone"));
    return;
  }
  lastSeq = view.seq;
  const folded = foldTranscriptRows(state, view.transcripts);
  if (view.phase === "error") {
    void endCall(view.error ?? t("live.error.generic"));
    return;
  }
  if (view.phase === "ended") {
    // The BRIDGE ended it, so there is nothing to tell it — just release the microphone here.
    sessionId = null;
    teardown({ ...folded, bridgePhase: "ended", status: "ended", usage: view.usage });
    return;
  }
  setState({ ...folded, bridgePhase: view.phase, status: "active", usage: view.usage });
}

/**
 * Open the microphone, sign the call through the bridge, and start polling.
 *
 * The offer goes out inside `LivePeer.start`, so `startLive` is the peer's `sendOffer`: the whole
 * handshake is one request, and a refusal (no Codex login, a busy session, a pane on a peer) rejects
 * the start with the bridge's own sentence rather than leaving a half-open call behind.
 */
export async function startCall(paneId: string, audioElement: HTMLAudioElement): Promise<void> {
  if (state.status === "connecting" || state.status === "active") return;
  lastSeq = 0;
  sessionId = null;
  setState({
    status: "connecting",
    paneId,
    bridgePhase: "connecting",
    mediaUp: false,
    muted: false,
    outputLevel: 0,
    usage: { audioMs: 0 },
    user: undefined,
    assistant: undefined,
    error: undefined,
  });

  const call = new LivePeer({
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeerConnection: () => new RTCPeerConnection(),
    createAudioContext: () => new AudioContext(),
    audioElement,
    playConnectedCue,
    sendOffer: async (sdp) => {
      const answer = await startLive({ paneId, sdp, language: getLocaleSnapshot().locale });
      if (!answer.ok) throw new Error(answer.error);
      sessionId = answer.id;
      return answer.sdp;
    },
    onLevels: (_input, output) => {
      // The level is the ONLY thing that ticks ten times a second, and it is what the `speaking`
      // phase reads. Written straight through rather than debounced: the phase itself is a
      // threshold, so the render only changes when the word does.
      if (state.status === "active" || state.status === "connecting") setState({ outputLevel: output });
    },
    onFailure: (message) => {
      void endCall(message);
    },
    onConnected: () => {
      if (state.status === "active" || state.status === "connecting") setState({ mediaUp: true });
    },
  });
  peer = call;

  try {
    await call.start();
  } catch (error) {
    // A refused microphone is the one failure with a remedy the operator owns, so it gets its own
    // sentence: the browser's own `NotAllowedError` text is a developer string. Every other throw
    // is either the bridge's refusal (`sendOffer` above rethrows its `error` field verbatim) or a
    // transport failure, and both already read as sentences.
    const refused = error instanceof DOMException && error.name === "NotAllowedError";
    const message = error instanceof Error ? error.message : t("live.error.generic");
    await endCall(refused ? t("live.error.mic") : message);
    return;
  }
  if (peer !== call) return; // ended while the handshake was in flight

  setState({ status: "active" });
  stopPolling();
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
}

/** Mute the microphone. Local only — no route, nothing on the wire (the locked contract says so). */
export function toggleMute(): void {
  if (!peer) return;
  const muted = !state.muted;
  peer.setMuted(muted);
  setState({ muted });
}

/**
 * End the call: release the microphone here, and tell the bridge so the pane's agent is not left
 * with a session nobody is on. `reason` is set when the call ended in a failure rather than a tap.
 *
 * Safe from `pagehide` and from an unmount — `stopLive` is a `keepalive` fetch for exactly that.
 */
export async function endCall(reason?: string): Promise<void> {
  const id = sessionId;
  sessionId = null;
  teardown(
    reason === undefined
      ? { status: "ended", bridgePhase: "ended" }
      : { status: "error", bridgePhase: "error", error: reason },
  );
  if (id !== null) await stopLive(id);
}

/** Put the store back to idle — the dock being cleared after a call has ended. */
export function dismissCall(): void {
  if (state.status === "connecting" || state.status === "active") return;
  state = IDLE;
  for (const fn of listeners) fn();
}


/** Test seam — forget the call, as if the page had just opened. */
export function __resetLive(): void {
  stopPolling();
  peer?.stop();
  peer = null;
  sessionId = null;
  lastSeq = 0;
  state = IDLE;
  listeners.clear();
}

/** Test seam — run one poll pass against an active session. */
export async function __pollForTests(id = "test-session"): Promise<void> {
  sessionId = id;
  await poll();
}
