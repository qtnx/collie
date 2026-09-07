import { LivePeer, type LivePeerDeps } from "./live-peer";

// The media half of a call, driven entirely through the injected deps — jsdom has no WebRTC and no
// working AudioContext, which is the reason those are deps in the first place. What is pinned here
// is everything that would fail SILENTLY on a phone: an offer that never reaches the bridge, a mute
// that ends the call instead of muting it, and a stop that leaves the microphone light on.

class FakeTrack {
  enabled = true;
  stopped = false;
  readonly kind = "audio";
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  readonly tracks: FakeTrack[];
  // No parameter-property shorthand: `web/` enables `erasableSyntaxOnly` (CLAUDE.md → Build/run).
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakePeerConnection {
  iceGatheringState: RTCIceGatheringState = "complete";
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: { sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  closed = false;
  readonly channels: string[] = [];
  readonly addedTracks: FakeTrack[] = [];
  ontrack: ((event: { streams: unknown[]; track: unknown }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  createDataChannel(label: string): void {
    this.channels.push(label);
  }
  addTrack(track: FakeTrack): void {
    this.addedTracks.push(track);
  }
  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" };
  }
  async setLocalDescription(description: { sdp: string }): Promise<void> {
    this.localDescription = description;
  }
  async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description;
  }
  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.closed = true;
  }
}

/** The two members of the audio element `LivePeer` touches. */
interface FakeAudioElement {
  srcObject: unknown;
  play(): Promise<void>;
}

/** Every browser object this file stands in for. A named owner type, so the conversion below cannot
 *  be pointed at something that is not one of these three fakes. */
type BrowserFake = FakeStream | FakePeerConnection | FakeAudioElement;

/**
 * THE ONE PLACE A FAKE BECOMES A DOM TYPE, and the reason it is a named function rather than a cast
 * repeated at each dep: `LivePeerDeps` is typed in terms of the real `MediaStream`,
 * `RTCPeerConnection` and `HTMLAudioElement`, while the classes above implement only the members
 * `LivePeer` actually touches — which is the point of a fake, and is not something a structural type
 * can express.
 */
function asBrowserObject<T>(fake: BrowserFake): T {
  // SAFETY: `LivePeer` reaches for exactly the members these three fakes declare, and the tests
  // prove it rather than assume it — a member the class needs and a fake lacks fails loudly as
  // "undefined is not a function" instead of passing quietly. `BrowserFake` bounds the input to
  // those three, and nothing outside this file ever sees the result, so it cannot escape into app
  // code.
  return fake as T;
}

interface Harness {
  peer: LivePeer;
  pc: FakePeerConnection;
  stream: FakeStream;
  offers: string[];
  failures: string[];
  element: FakeAudioElement;
}

function harness(overrides: Partial<LivePeerDeps> = {}): Harness {
  const stream = new FakeStream([new FakeTrack()]);
  const pc = new FakePeerConnection();
  const offers: string[] = [];
  const failures: string[] = [];
  const element: FakeAudioElement = {
    srcObject: null,
    play: async () => {},
  };
  const peer = new LivePeer({
    getUserMedia: async () => asBrowserObject<MediaStream>(stream),
    createPeerConnection: () => asBrowserObject<RTCPeerConnection>(pc),
    createAudioContext: () => {
      throw new Error("no audio context in tests");
    },
    audioElement: asBrowserObject<HTMLAudioElement>(element),
    sendOffer: async (sdp) => {
      offers.push(sdp);
      return "v=0\r\nanswer\r\n";
    },
    onFailure: (message) => failures.push(message),
    setInterval: () => 0,
    clearInterval: () => {},
    ...overrides,
  });
  return { peer, pc, stream, offers, failures, element };
}

describe("LivePeer", () => {
  it("offers one audio track plus the oai-events channel and applies the bridge's answer", async () => {
    const h = harness();

    await h.peer.start();

    expect(h.pc.channels).toEqual(["oai-events"]);
    expect(h.pc.addedTracks).toHaveLength(1);
    expect(h.offers).toHaveLength(1);
    expect(h.offers[0]).toContain("m=audio");
    expect(h.pc.remoteDescription).toEqual({ type: "answer", sdp: "v=0\r\nanswer\r\n" });
  });

  it("mutes by disabling the local track without ending the call", async () => {
    const h = harness();
    await h.peer.start();

    h.peer.setMuted(true);
    expect(h.stream.tracks[0].enabled).toBe(false);
    expect(h.peer.muted).toBe(true);
    expect(h.pc.closed).toBe(false);

    h.peer.setMuted(false);
    expect(h.stream.tracks[0].enabled).toBe(true);
  });

  it("releases the microphone and the peer once, however often stop is called", async () => {
    const h = harness();
    await h.peer.start();

    h.peer.stop();
    h.peer.stop();

    expect(h.stream.tracks[0].stopped).toBe(true);
    expect(h.pc.closed).toBe(true);
    expect(h.element.srcObject).toBeNull();
  });

  it("releases a microphone granted after the call was already ended", async () => {
    // The permission prompt outliving the sheet: End is tapped while the browser is still asking.
    const stream = new FakeStream([new FakeTrack()]);
    const pc = new FakePeerConnection();
    const element: FakeAudioElement = { srcObject: null, play: async () => {} };
    let release = (): void => {};
    const granted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const peer = new LivePeer({
      getUserMedia: async () => {
        await granted;
        return asBrowserObject<MediaStream>(stream);
      },
      createPeerConnection: () => asBrowserObject<RTCPeerConnection>(pc),
      createAudioContext: () => {
        throw new Error("no audio context in tests");
      },
      audioElement: asBrowserObject<HTMLAudioElement>(element),
      sendOffer: async () => "v=0\r\nanswer\r\n",
    });

    const starting = peer.start();
    peer.stop();
    release();
    await starting;

    expect(stream.tracks[0].stopped).toBe(true);
    expect(pc.channels).toEqual([]);
  });

  it("plays the local cue once only after the transport connects", async () => {
    let cueCount = 0;
    const h = harness({
      playConnectedCue: () => {
        cueCount += 1;
      },
    });
    await h.peer.start();

    h.pc.setConnectionState("connecting");
    expect(cueCount).toBe(0);

    h.pc.setConnectionState("connected");
    h.pc.setConnectionState("connected");
    await Promise.resolve();
    expect(cueCount).toBe(1);
  });

  it("keeps the outbound microphone disabled until the connected cue finishes", async () => {
    let release = (): void => {};
    const cue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let trackEnabledDuringCue: boolean | undefined;
    const h = harness({
      playConnectedCue: () => {
        trackEnabledDuringCue = h.stream.tracks[0].enabled;
        return cue;
      },
    });
    await h.peer.start();

    h.pc.setConnectionState("connected");
    await Promise.resolve();
    expect(trackEnabledDuringCue).toBe(false);
    expect(h.stream.tracks[0].enabled).toBe(false);

    release();
    await cue;
    await Promise.resolve();
    expect(h.stream.tracks[0].enabled).toBe(true);
  });

  it("reports a dropped transport instead of failing silently", async () => {
    const h = harness();
    await h.peer.start();

    h.pc.setConnectionState("failed");

    expect(h.failures).toEqual(["The voice connection dropped."]);
  });

  it("surfaces a refused offer instead of leaving the call half-open", async () => {
    const h = harness({
      sendOffer: async () => {
        throw new Error("A live call is already running on this collie.");
      },
    });

    await expect(h.peer.start()).rejects.toThrow("already running");
  });
});
