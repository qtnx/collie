// THE BROWSER'S HALF OF A LIVE CALL — the microphone, the speaker, and the `RTCPeerConnection`.
//
// The bridge owns the credential and the signalling call; this file owns the media. The SDP
// handshake is the only thing that travels through Collie, and it travels once: after the answer is
// applied, audio flows directly between this browser and the realtime service, which is why the
// bridge never sees a byte of it and why muting is a local act (`track.enabled = false`) with no
// route behind it.
//
// EVERY BROWSER DEPENDENCY IS INJECTED, and that is not ceremony: `getUserMedia`, `RTCPeerConnection`
// and `AudioContext` are all absent or inert under jsdom, so a class that reached for them directly
// would be a class no unit test could drive. lib/live.ts supplies the real ones; live-peer.test.ts
// supplies fakes, and the two see the same code path.

/** Data channel the realtime service expects alongside the audio track. */
const EVENT_CHANNEL = "oai-events";
/** ICE gathering is best-effort; a trickle-free offer is sent once this elapses. */
const ICE_GATHER_TIMEOUT_MS = 10_000;
/** Level sampling cadence — fast enough that the "speaking" phase tracks the voice, not the sentence. */
const LEVEL_INTERVAL_MS = 100;

/** Short, quiet success tone; long enough to notice without masking the call. */
const CONNECTED_CUE_DURATION_SECONDS = 0.14;
/** Bounds microphone isolation even if a browser fails to dispatch `ended`. */
const CONNECTED_CUE_TIMEOUT_MS = 500;

/** A promise plus its own resolver — `Promise.withResolvers` under another name. */
interface Settlable {
  promise: Promise<void>;
  settle: () => void;
}

/** Placeholder for the resolver, replaced synchronously by the executor below. Hoisted so it is not
 *  rebuilt on every call (it captures nothing, which is exactly what makes hoisting safe). */
const NOT_YET_SETTLED = (): void => {};

/**
 * `Promise.withResolvers` is ES2024 and this tree's lib is ES2023 (`web/tsconfig.json`), so the
 * resolver is lifted out of the executor here rather than at each of the three sites that want one.
 *
 * The executor runs SYNCHRONOUSLY during construction, so `settle` is the real resolver by the time
 * this returns — the placeholder above is never the value a caller gets.
 */
function settlable(): Settlable {
  let settle = NOT_YET_SETTLED;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * Play the connected cue through a local-only Web Audio graph.
 *
 * A call that has connected sounds exactly like a call that has not until somebody speaks, and the
 * operator is holding a phone waiting to find out. The oscillator is connected only to the browser's
 * output destination — it is never added to the peer connection or any outbound `MediaStream`.
 */
export async function playConnectedCue(): Promise<void> {
  let audio: AudioContext | undefined;
  const timedOut = settlable();
  const timeout = globalThis.setTimeout(timedOut.settle, CONNECTED_CUE_TIMEOUT_MS);
  try {
    audio = new AudioContext();
    if (audio.state === "suspended") await Promise.race([audio.resume(), timedOut.promise]);
    if (audio.state !== "running") return;

    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const now = audio.currentTime;
    const ended = settlable();
    oscillator.addEventListener("ended", ended.settle, { once: true });
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + CONNECTED_CUE_DURATION_SECONDS);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + CONNECTED_CUE_DURATION_SECONDS);
    await Promise.race([ended.promise, timedOut.promise]);
  } catch {
    // Audio output is optional. A missing or blocked backend must not break the call.
  } finally {
    globalThis.clearTimeout(timeout);
    await audio?.close().catch(() => {});
  }
}

export interface LivePeerDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeerConnection(): RTCPeerConnection;
  createAudioContext(): AudioContext;
  /** Element the remote track is attached to; supplied by the sheet. */
  audioElement: HTMLAudioElement;
  /** Hands the local SDP to the bridge and resolves with the answer. */
  sendOffer(sdp: string): Promise<string>;
  /** Input and output levels, 0..1, sampled every 100ms. */
  onLevels?(input: number, output: number): void;
  /** Fatal failure; the call is over. */
  onFailure?(message: string): void;
  /** The WebRTC transport reached `connected`: audio flows from here on. Fired once. */
  onConnected?(): void;
  /** Local-only cue played once the WebRTC transport reaches `connected`. */
  playConnectedCue?(): void | Promise<void>;
  /** Scheduler seam so tests do not depend on wall-clock timers. */
  setInterval?(handler: () => void, ms: number): number;
  clearInterval?(handle: number): void;
}

/** Root-mean-square of a byte-domain analyser frame, normalised to 0..1. */
function frameLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / buffer.length));
}

export class LivePeer {
  readonly #deps: LivePeerDeps;
  #pc: RTCPeerConnection | undefined;
  #stream: MediaStream | undefined;
  #audio: AudioContext | undefined;
  #inputAnalyser: AnalyserNode | undefined;
  #outputAnalyser: AnalyserNode | undefined;
  #levelTimer: number | undefined;
  #muted = false;
  #stopped = false;
  #connectedCueStarted = false;
  #connectedCuePlaying = false;

  constructor(deps: LivePeerDeps) {
    this.#deps = deps;
  }

  get muted(): boolean {
    return this.#muted;
  }

  /**
   * Acquire the microphone, negotiate through the bridge, and start playing the assistant's audio.
   * Rejects with a user-presentable message — a refused microphone and a refused call both land
   * here, and lib/live.ts turns the throw into the one line the sheet shows.
   */
  async start(): Promise<void> {
    const stream = await this.#deps.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.#stream = stream;
    // The permission prompt can outlive the sheet: an operator who taps End (or backgrounds the
    // page) while it is up would otherwise be left with a hot microphone and no call.
    if (this.#stopped) {
      this.#releaseTracks();
      return;
    }

    const pc = this.#deps.createPeerConnection();
    this.#pc = pc;
    pc.createDataChannel(EVENT_CHANNEL);
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    pc.ontrack = (event) => this.#attachRemote(event.streams[0] ?? new MediaStream([event.track]));
    pc.onconnectionstatechange = () => this.#handleConnectionState(pc);
    pc.oniceconnectionstatechange = () => this.#handleConnectionState(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.#waitForIce(pc);
    const localSdp = pc.localDescription?.sdp ?? offer.sdp;
    if (!localSdp) throw new Error("The browser did not produce a session description.");

    const answer = await this.#deps.sendOffer(localSdp);
    if (this.#stopped) return;
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    this.#startMetering(stream);
  }

  /** Toggle the microphone without tearing the call down. */
  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#syncOutboundTrackState();
  }

  /** Release the microphone, the peer, and the audio graph. Safe to call repeatedly. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#levelTimer !== undefined) {
      (this.#deps.clearInterval ?? globalThis.clearInterval)(this.#levelTimer);
      this.#levelTimer = undefined;
    }
    this.#releaseTracks();
    const pc = this.#pc;
    this.#pc = undefined;
    if (pc) {
      pc.ontrack = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    const audio = this.#audio;
    this.#audio = undefined;
    void audio?.close().catch(() => {});
    this.#deps.audioElement.srcObject = null;
  }

  #handleConnectionState(pc: RTCPeerConnection): void {
    if (pc.connectionState === "failed" || pc.iceConnectionState === "failed") {
      if (!this.#stopped) this.#deps.onFailure?.("The voice connection dropped.");
      return;
    }
    if (
      pc.connectionState !== "connected" &&
      pc.iceConnectionState !== "connected" &&
      pc.iceConnectionState !== "completed"
    ) {
      return;
    }
    this.#startConnectedCue();
  }

  #startConnectedCue(): void {
    if (this.#stopped || this.#connectedCueStarted) return;
    this.#connectedCueStarted = true;
    this.#deps.onConnected?.();
    const play = this.#deps.playConnectedCue;
    if (!play) return;

    // A speaker cue can be picked up acoustically by the microphone even though its Web Audio graph
    // is not part of the outbound stream. Hold the sender silent until playback settles, then
    // restore the operator's own mute state — which may have changed while the tone was playing.
    this.#connectedCuePlaying = true;
    this.#syncOutboundTrackState();
    const finish = (): void => {
      this.#connectedCuePlaying = false;
      this.#syncOutboundTrackState();
    };
    try {
      const pending = play();
      if (pending) void pending.catch(() => {}).finally(finish);
      else finish();
    } catch {
      finish();
    }
  }

  #syncOutboundTrackState(): void {
    for (const track of this.#stream?.getAudioTracks() ?? []) {
      track.enabled = !this.#muted && !this.#connectedCuePlaying;
    }
  }

  #releaseTracks(): void {
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
  }

  #attachRemote(stream: MediaStream): void {
    if (this.#stopped) return;
    this.#deps.audioElement.srcObject = stream;
    void this.#deps.audioElement.play().catch(() => {
      // Autoplay can be refused until the user interacts; the Live button already was one.
    });
    const audio = this.#ensureAudioContext();
    if (!audio) return;
    const analyser = audio.createAnalyser();
    audio.createMediaStreamSource(stream).connect(analyser);
    this.#outputAnalyser = analyser;
  }

  #startMetering(local: MediaStream): void {
    const audio = this.#ensureAudioContext();
    if (!audio) return;
    const analyser = audio.createAnalyser();
    audio.createMediaStreamSource(local).connect(analyser);
    this.#inputAnalyser = analyser;

    const inputBuffer = new Uint8Array(analyser.fftSize);
    // The seam's contract is a numeric handle (a browser's `setInterval` returns one). Under Node —
    // which is what Vitest runs — the global returns a `Timeout` object instead, so the fallback
    // converts it with `Number()` rather than asserting the two apart. `Timeout` defines
    // `Symbol.toPrimitive`, so this is the id Node itself hands back, not a coercion accident.
    const schedule =
      this.#deps.setInterval ??
      ((handler: () => void, ms: number) => Number(globalThis.setInterval(handler, ms)));
    this.#levelTimer = schedule(() => {
      if (this.#stopped) return;
      const input = this.#muted || !this.#inputAnalyser ? 0 : frameLevel(this.#inputAnalyser, inputBuffer);
      const output = this.#outputAnalyser
        ? frameLevel(this.#outputAnalyser, new Uint8Array(this.#outputAnalyser.fftSize))
        : 0;
      this.#deps.onLevels?.(input, output);
    }, LEVEL_INTERVAL_MS);
  }

  #ensureAudioContext(): AudioContext | undefined {
    if (!this.#audio) {
      try {
        this.#audio = this.#deps.createAudioContext();
      } catch {
        // Level metering is cosmetic; a blocked AudioContext must not end the call.
        return undefined;
      }
    }
    return this.#audio;
  }

  /**
   * Wait for ICE gathering, but never longer than {@link ICE_GATHER_TIMEOUT_MS}.
   *
   * The offer is sent whole rather than trickled, so the candidates have to be in it — but a network
   * that never finishes gathering (a blocked STUN server) must not hang the call forever. What has
   * been gathered by the deadline is what goes out.
   */
  async #waitForIce(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return;
    const gathered = settlable();
    const finish = (): void => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      gathered.settle();
    };
    const onChange = (): void => {
      if (pc.iceGatheringState === "complete") finish();
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    const timer = globalThis.setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    await gathered.promise;
    globalThis.clearTimeout(timer);
  }
}
