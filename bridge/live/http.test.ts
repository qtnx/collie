import { describe, expect, test } from "bun:test";

import type { CodexAccessToken, CodexAuthBroker } from "../stt/codex-auth.ts";
import type { SttStatus } from "../stt/provider.ts";
import type { LiveCapability, LiveErrorCode } from "../types.ts";
import type { LiveServerEvent } from "./protocol.ts";
import type { LiveAgentEndpoint, OperatorPanePort } from "./agent-pane.ts";
import { type LiveDeps, type LiveSessionLike, createLiveService } from "./http.ts";
import type { LiveSessionOptions, LiveSessionView } from "./session.ts";
import { LiveSignalingError, type LiveControlTransport } from "./signaling.ts";

function fakeBroker(available = true, reason?: string): CodexAuthBroker {
  const getStatus = (): SttStatus => {
    const st: SttStatus = { available };
    if (reason !== undefined) st.reason = reason;
    return st;
  };
  return {
    lastKnown: getStatus,
    probe: async () => getStatus(),
    accessToken: async (): Promise<CodexAccessToken> => ({ accessToken: "test-token" }),
    close: () => {},
  };
}

function fakePort(): OperatorPanePort {
  return {
    reply: async () => ({ ok: true }),
    status: () => "idle",
    history: async () => [],
    screen: async () => "screen text",
    meta: { paneId: "p1", agent: "codex", cwd: "/home/work" },
    sendKeys: async () => ({ ok: true }),
    listPanes: () => [],
    waitIdle: async () => ({ status: "idle", settled: true }),
  };
}
class FakeLiveSession implements LiveSessionLike {
  readonly id: string;
  readonly transport: LiveControlTransport;
  readonly agent: LiveAgentEndpoint;
  private _lastSeen: number;
  private _endedAt: number | undefined = undefined;
  private phase: "connecting" | "listening" | "working" | "ended" | "error" = "listening";
  private seq = 1;

  constructor(opts: LiveSessionOptions) {
    this.id = opts.id;
    this.transport = opts.transport;
    this.agent = opts.agent;
    this._lastSeen = opts.now ? opts.now() : Date.now();
  }

  async start(_offerSdp: string): Promise<string> {
    return "answer-sdp";
  }

  view(after: number): LiveSessionView {
    this._lastSeen = Date.now();
    return {
      phase: this.phase,
      seq: this.seq,
      transcripts: after < this.seq ? [{ seq: 1, role: "assistant", turn: 1, text: "hello", final: true }] : [],
      usage: { audioMs: 0 },
    };
  }

  async stop(_reason?: string): Promise<void> {
    this.phase = "ended";
    if (this._endedAt === undefined) {
      this._endedAt = Date.now();
    }
  }

  get lastSeen(): number {
    return this._lastSeen;
  }

  set lastSeen(val: number) {
    this._lastSeen = val;
  }

  get endedAt(): number | undefined {
    return this._endedAt;
  }

  set endedAt(val: number | undefined) {
    this._endedAt = val;
  }

  handleEvent(_event: LiveServerEvent): void {}
}

class ErrorLiveSession implements LiveSessionLike {
  readonly id = "error-id";
  async start(): Promise<string> {
    throw new LiveSignalingError("auth", "Token expired");
  }
  view(_after: number): LiveSessionView {
    return { phase: "error", seq: 0, transcripts: [], usage: { audioMs: 0 } };
  }
  async stop(): Promise<void> {}
  get lastSeen(): number { return 0; }
  get endedAt(): number | undefined { return undefined; }
}

describe("createLiveService", () => {
  test("capability returns null when settings are null (feature off)", async () => {
    const service = createLiveService({
      settings: async () => null,
      broker: () => fakeBroker(),
      resolvePane: async () => ({ code: "live.no_pane" }),
    });

    expect(await service.capability()).toBeNull();
    service.close();
  });

  test("capability returns capability object when settings are present", async () => {
    const service = createLiveService({
      settings: async () => ({ voice: "sol", codexBin: "codex", auth: "codex" }),
      broker: () => fakeBroker(true),
      resolvePane: async () => ({ code: "live.no_pane" }),
    });

    const cap = await service.capability();
    expect(cap).toEqual({
      available: true,
      voice: "sol",
    } satisfies LiveCapability);
    service.close();
  });

  test("capability includes agent when settings.agent is present", async () => {
    const service = createLiveService({
      settings: async () => ({
        voice: "sol",
        codexBin: "codex",
        auth: "codex",
        agent: { kind: "ompx", bin: "/usr/bin/ompx", model: "openai-codex/gpt-5.6-luna" },
      }),
      broker: () => fakeBroker(true),
      resolvePane: async () => ({ code: "live.no_pane" }),
    });

    const cap = await service.capability();
    expect(cap?.agent).toEqual({ model: "openai-codex/gpt-5.6-luna" });
    service.close();
  });

  test("start returns 503 live.off when feature is disabled", async () => {
    const service = createLiveService({
      settings: async () => null,
      broker: () => fakeBroker(),
      resolvePane: async () => ({ code: "live.no_pane" }),
    });

    const res = await service.start({ paneId: "p1", sdp: "offer-sdp" });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    if (!res.body.ok) {
      expect(res.body.code).toBe("live.off" satisfies LiveErrorCode);
    }
    service.close();
  });

  test("start returns 400 live.bad_body on invalid payload", async () => {
    const service = createLiveService({
      settings: async () => ({ voice: "sol", codexBin: "codex", auth: "codex" }),
      broker: () => fakeBroker(),
      resolvePane: async () => ({ code: "live.no_pane" }),
    });

    const bad1 = await service.start(null);
    expect(bad1.status).toBe(400);

    const bad2 = await service.start({ paneId: "", sdp: "offer" });
    expect(bad2.status).toBe(400);

    const bad3 = await service.start({ paneId: "p1", sdp: "" });
    expect(bad3.status).toBe(400);

    const bad4 = await service.start({ paneId: "p1", sdp: "offer", language: "this-language-tag-is-too-long-to-be-valid" });
    expect(bad4.status).toBe(400);

    service.close();
  });

  test("start returns 404 live.no_pane when pane does not exist", async () => {
    const service = createLiveService({
      settings: async () => ({ voice: "sol", codexBin: "codex", auth: "codex" }),
      broker: () => fakeBroker(),
      resolvePane: async () => ({ code: "live.no_pane" }),
    });

    const res = await service.start({ paneId: "p1", sdp: "offer" });
    expect(res.status).toBe(404);
    if (!res.body.ok) {
      expect(res.body.code).toBe("live.no_pane");
    }
    service.close();
  });

  test("start returns 409 live.peer_pane when pane belongs to a peer", async () => {
    const service = createLiveService({
      settings: async () => ({ voice: "sol", codexBin: "codex", auth: "codex" }),
      broker: () => fakeBroker(),
      resolvePane: async () => ({ code: "live.peer_pane" }),
    });

    const res = await service.start({ paneId: "p1", sdp: "offer" });
    expect(res.status).toBe(409);
    if (!res.body.ok) {
      expect(res.body.code).toBe("live.peer_pane");
    }
    service.close();
  });

  test("happy path: connects, returns 200, handles view, stop, and reap", async () => {
    let fakeNow = 1000;
    let activeSessionInstance: FakeLiveSession | null = null;

    const deps: LiveDeps = {
      settings: async () => ({ voice: "sol", codexBin: "codex", auth: "codex" }),
      broker: () => fakeBroker(),
      resolvePane: async () => ({
        port: fakePort(),
        agent: "codex",
        cwd: "/home/work",
        session: "s1",
      }),
      now: () => fakeNow,
      createTransport: () => ({
        connect: async () => "answer-sdp",
        send: async () => {},
        close: async () => {},
      }),
      createAgent: () => ({
        startDelegation: () => {},
        onContext: () => {},
        onDelegationEnd: () => {},
        close: async () => {},
      }),
      createSession: (opts) => {
        const s = new FakeLiveSession(opts);
        activeSessionInstance = s;
        return s;
      },
    };

    const service = createLiveService(deps);

    // 1. Happy path start
    const startRes = await service.start({ paneId: "p1", sdp: "offer-sdp" });
    expect(startRes.status).toBe(200);
    expect(startRes.body.ok).toBe(true);
    expect(startRes.paneId).toBe("p1");
    if (!startRes.body.ok) throw new Error("expected success");
    const sessionId = startRes.body.id;
    expect(sessionId).toBeString();
    expect(startRes.body.sdp).toBe("answer-sdp");

    // 2. Busy check while active
    const busyRes = await service.start({ paneId: "p2", sdp: "offer-sdp-2" });
    expect(busyRes.status).toBe(409);
    if (!busyRes.body.ok) {
      expect(busyRes.body.code).toBe("live.busy");
    }

    // 3. View check
    const viewRes0 = service.view(sessionId, 0);
    expect(viewRes0.status).toBe(200);
    if (viewRes0.body.ok) {
      expect(viewRes0.body.transcripts.length).toBe(1);
      expect(viewRes0.body.seq).toBe(1);
    }

    const viewRes1 = service.view(sessionId, 1);
    expect(viewRes1.status).toBe(200);
    if (viewRes1.body.ok) {
      expect(viewRes1.body.transcripts.length).toBe(0);
    }

    // 4. Idempotent stop
    const stopRes1 = await service.stop(sessionId, "user hangup");
    expect(stopRes1.status).toBe(200);
    expect(stopRes1.body.ok).toBe(true);
    expect(stopRes1.session).toBe("s1");
    expect(stopRes1.paneId).toBe("p1");

    const stopRes2 = await service.stop(sessionId, "user hangup again");
    expect(stopRes2.status).toBe(200);
    expect(stopRes2.body.ok).toBe(true);

    // 5. Still readable within retention window (60s)
    fakeNow += 30_000;
    const viewAfterStop = service.view(sessionId, 0);
    expect(viewAfterStop.status).toBe(200);

    // 6. Reaped after 60s
    fakeNow += 35_000;
    activeSessionInstance!.endedAt = fakeNow - 65_000;
    service.reap?.();

    const viewReaped = service.view(sessionId, 0);
    expect(viewReaped.status).toBe(404);
    if (!viewReaped.body.ok) {
      expect(viewReaped.body.code).toBe("live.gone");
    }

    const stopReaped = await service.stop(sessionId, "after reap");
    expect(stopReaped.status).toBe(404);
    if (!stopReaped.body.ok) {
      expect(stopReaped.body.code).toBe("live.gone");
    }

    service.close();
  });

  test("phone gone reaper ends active session after 20s of silence", async () => {
    let fakeNow = 1000;

    const deps: LiveDeps = {
      settings: async () => ({ voice: "sol", codexBin: "codex", auth: "codex" }),
      broker: () => fakeBroker(),
      resolvePane: async () => ({
        port: fakePort(),
        agent: "codex",
        cwd: "/home/work",
        session: "s1",
      }),
      now: () => fakeNow,
      createTransport: () => ({
        connect: async () => "answer-sdp",
        send: async () => {},
        close: async () => {},
      }),
      createAgent: () => ({
        startDelegation: () => {},
        onContext: () => {},
        onDelegationEnd: () => {},
        close: async () => {},
      }),
      createSession: (opts) => new FakeLiveSession(opts),
    };

    const service = createLiveService(deps);
    const startRes = await service.start({ paneId: "p1", sdp: "offer" });
    expect(startRes.status).toBe(200);

    // Advance clock past 20s with no calls
    fakeNow += 25_000;
    service.reap?.();

    // Now a new session can start because previous was stopped due to phone gone!
    const nextStart = await service.start({ paneId: "p1", sdp: "offer-2" });
    expect(nextStart.status).toBe(200);

    service.close();
  });

  test("handles LiveSignalingError auth and signaling properly", async () => {
    const depsAuth: LiveDeps = {
      settings: async () => ({ voice: "sol", codexBin: "codex", auth: "codex" }),
      broker: () => fakeBroker(),
      resolvePane: async () => ({
        port: fakePort(),
        agent: "codex",
        cwd: "/home/work",
        session: "s1",
      }),
      createTransport: () => ({
        connect: async () => {
          throw new LiveSignalingError("auth", "Token expired");
        },
        send: async () => {},
        close: async () => {},
      }),
      createAgent: () => ({
        startDelegation: () => {},
        onContext: () => {},
        onDelegationEnd: () => {},
        close: async () => {},
      }),
      createSession: () => new ErrorLiveSession(),
    };

    const serviceAuth = createLiveService(depsAuth);
    const resAuth = await serviceAuth.start({ paneId: "p1", sdp: "offer" });
    expect(resAuth.status).toBe(502);
    if (!resAuth.body.ok) {
      expect(resAuth.body.code).toBe("live.auth");
    }
    serviceAuth.close();
  });

  test("start with settings.agent and operator deps spawns operator agent and cleans up", async () => {
    const tmpDir = `/tmp/collie-test-operator-${Date.now()}`;
    const service = createLiveService({
      settings: async () => ({
        voice: "sol",
        codexBin: "codex",
        auth: "codex",
        agent: { kind: "ompx", bin: "/fake/ompx", model: "openai-codex/gpt-5.6-luna" },
      }),
      broker: () => fakeBroker(),
      resolvePane: async () => ({
        port: fakePort(),
        agent: "codex",
        cwd: "/home/work",
        session: "s1",
      }),
      operator: {
        pumpCommand: ["collie", "live-mcp"],
        stateDir: tmpDir,
      },
      createTransport: () => ({
        connect: async () => "answer-sdp",
        send: async () => {},
        close: async () => {},
      }),
      createSession: (opts) => new FakeLiveSession(opts),
    });

    const startRes = await service.start({ paneId: "p1", sdp: "offer" });
    expect(startRes.status).toBe(200);
    if (startRes.body.ok) {
      const id = startRes.body.id;
      const stopRes = await service.stop(id, "done");
      expect(stopRes.status).toBe(200);
    }
    service.close();
  });

  test("start with settings.agent but missing operator deps warns and falls back to direct path", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    let directAgentCreated = false;

    try {
      const service = createLiveService({
        settings: async () => ({
          voice: "sol",
          codexBin: "codex",
          auth: "codex",
          agent: { kind: "ompx", bin: "/fake/ompx", model: "openai-codex/gpt-5.6-luna" },
        }),
        broker: () => fakeBroker(),
        resolvePane: async () => ({
          port: fakePort(),
          agent: "codex",
          cwd: "/home/work",
          session: "s1",
        }),
        createAgent: (_port) => {
          directAgentCreated = true;
          return {
            startDelegation: () => {},
            onContext: () => {},
            onDelegationEnd: () => {},
            close: async () => {},
          };
        },
        createTransport: () => ({
          connect: async () => "answer-sdp",
          send: async () => {},
          close: async () => {},
        }),
        createSession: (opts) => new FakeLiveSession(opts),
      });

      const res = await service.start({ paneId: "p1", sdp: "offer" });
      expect(res.status).toBe(200);
      expect(directAgentCreated).toBe(true);
      expect(warnings.some((w) => w.includes("operator agent configured but operator dependencies missing"))).toBe(true);
      service.close();
    } finally {
      console.warn = originalWarn;
    }
  });
});
