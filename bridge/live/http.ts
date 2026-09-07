import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../json.ts";
import { jsonRecord, jsonStringField } from "../stt/json.ts";
import type { CodexAuthBroker } from "../stt/codex-auth.ts";
import type {
  LiveCapability,
  LiveErrorCode,
  LiveStartResponse,
  LiveStopResponse,
  LiveViewResponse,
} from "../types.ts";
import {
  type LiveAgentEndpoint,
  type OperatorPanePort,
  type PaneAgentPort,
  createPaneAgentEndpoint,
} from "./agent-pane.ts";
import { createLiveMcpServer, type LiveMcpServer } from "./mcp-server.ts";
import { createOperatorAgentEndpoint } from "./operator-agent.ts";
import type { LiveSettings } from "./config.ts";
import { localUser, renderLiveInstructions } from "./instructions.ts";
import {
  type LiveControlTransport,
  type CodexLiveTransportDeps,
  LiveSignalingError,
  createCodexLiveTransport,
} from "./signaling.ts";
import type { LiveServerEvent } from "./protocol.ts";
import {
  type LiveSessionOptions,
  type LiveSessionView,
  LiveSession,
} from "./session.ts";

// ── HTTP SERVICE FOR REALTIME LIVE CALLS ─────────────────────────────────────
//
// Manages the lifecycle of live voice calls between a phone and an agent in a pane.
// One active call is permitted at a time. The service coordinates:
//  - Configuration checks (503 `live.off` when live.json is absent)
//  - Session initiation with browser SDP offer and OpenAI realtime answer
//  - Polling channel for status, phase transitions, and transcript deltas
//  - Phone-gone timeout (20s inactivity) and retention of ended calls (60s)
//  - Clean session teardown and token broker lifecycle

export type LivePaneResolver = (paneId: string) => Promise<
  | { port: OperatorPanePort; agent: string; cwd: string; session: string }
  | { code: "live.no_pane" | "live.peer_pane" }
>;
export interface LiveSessionLike {
  readonly id: string;
  start(offerSdp: string): Promise<string>;
  view(after: number): LiveSessionView;
  stop(reason?: string): Promise<void>;
  readonly lastSeen: number;
  readonly endedAt: number | undefined;
  handleEvent?(event: LiveServerEvent): void;
}


export interface LiveDeps {
  settings: () => Promise<LiveSettings | null>;
  /** The Codex-CLI broker (`codex app-server`), keyed by the codex binary. */
  broker: (codexBin: string) => CodexAuthBroker;
  /** The omp broker (`ompx token openai-codex`), keyed by the ompx binary. Absent → `auth: ompx` refuses. */
  ompBroker?: (ompxBin: string) => CodexAuthBroker;
  resolvePane: LivePaneResolver;
  now?: () => number;
  createSession?: (opts: LiveSessionOptions) => LiveSessionLike;
  createTransport?: (deps: CodexLiveTransportDeps) => LiveControlTransport;
  createAgent?: (port: PaneAgentPort) => LiveAgentEndpoint;
  operator?: {
    pumpCommand: readonly string[];
    stateDir: string;
  };
}

export interface LiveStartOutcome {
  status: number;
  body: LiveStartResponse;
  session?: string;
  paneId?: string;
}

export interface LiveViewOutcome {
  status: number;
  body: LiveViewResponse;
}

export interface LiveStopOutcome {
  status: number;
  body: LiveStopResponse;
  session?: string;
  paneId?: string;
}

export interface LiveService {
  capability(): Promise<LiveCapability | null>;
  start(body: JsonValue): Promise<LiveStartOutcome>;
  view(id: string, after: number): LiveViewOutcome;
  stop(id: string, reason: string): Promise<LiveStopOutcome>;
  close(): void;
  setResolvePane?(resolver: LivePaneResolver): void;
  reap?(): void;
}

interface StoredSession {
  session: LiveSessionLike;
  paneId: string;
  sessionName: string;
  cleanup?: () => Promise<void>;
}

const PHONE_GONE_TIMEOUT_MS = 20_000;
const ENDED_RETENTION_MS = 60_000;
const REAP_INTERVAL_MS = 5_000;

export function createLiveService(deps: LiveDeps): LiveService {
  const clock = deps.now ?? Date.now;
  let paneResolver = deps.resolvePane;
  let operatorWarned = false;

  let cachedBroker: CodexAuthBroker | null = null;
  let cachedBrokerKey: string | null = null;
  let primed = false;
  let activeSession: LiveSessionLike | null = null;
  const sessions = new Map<string, StoredSession>();

  /** One broker per distinct (source, binary); the outgoing one is closed as the new one is built. */
  function getBroker(settings: LiveSettings): CodexAuthBroker {
    const useOmp = settings.auth === "ompx" && settings.agent !== undefined;
    const bin = useOmp && settings.agent !== undefined ? settings.agent.bin : settings.codexBin;
    const key = `${useOmp ? "ompx" : "codex"}:${bin}`;
    if (cachedBroker && cachedBrokerKey === key) {
      return cachedBroker;
    }
    cachedBroker?.close();
    cachedBroker = useOmp && deps.ompBroker ? deps.ompBroker(bin) : deps.broker(bin);
    cachedBrokerKey = key;
    primed = false;
    return cachedBroker;
  }

  function reap(): void {
    const now = clock();
    // 1. Phone gone detection on active session
    if (activeSession && activeSession.endedAt === undefined) {
      if (now - activeSession.lastSeen > PHONE_GONE_TIMEOUT_MS) {
        void activeSession.stop("phone gone").catch(() => {});
        activeSession = null;
      }
    }
    // 2. Cleanup reaped ended sessions
    for (const [id, item] of sessions) {
      const endedAt = item.session.endedAt;
      if (endedAt !== undefined && now - endedAt >= ENDED_RETENTION_MS) {
        void item.cleanup?.();
        sessions.delete(id);
        if (activeSession === item.session) {
          activeSession = null;
        }
      }
    }
  }

  const timer = setInterval(() => {
    reap();
  }, REAP_INTERVAL_MS);
  timer.unref?.();

  return {
    async capability(): Promise<LiveCapability | null> {
      const currentSettings = await deps.settings();
      if (!currentSettings) return null;
      const broker = getBroker(currentSettings);
      if (!primed) {
        primed = true;
        // Ask for a TOKEN, not merely the auth method: Codex reports `chatgpt` for a login whose
        // refresh token was revoked, and only the token fetch reveals it. The answer lands in
        // `lastKnown()`, so the button appears only when a call can actually be signed.
        void broker.accessToken().catch(() => {});
      }
      const known = broker.lastKnown();
      const cap: LiveCapability = {
        available: known.available,
        voice: currentSettings.voice,
      };
      if (currentSettings.agent !== undefined) {
        cap.agent = { model: currentSettings.agent.model };
      }
      // The broker's words name `collie stt test`, the verb that owns IT; on this surface the
      // operator's next move is `collie live status`, so the sentence is rewritten to say so.
      if (known.reason !== undefined) cap.reason = known.reason.replace("`collie stt test`", "`collie live status`");
      return cap;
    },

    async start(body: JsonValue): Promise<LiveStartOutcome> {
      reap();
      const currentSettings = await deps.settings();
      if (!currentSettings) {
        return {
          status: 503,
          body: {
            ok: false,
            code: "live.off",
            error: "Live call is disabled; run `collie live on` to configure",
          },
        } satisfies LiveStartOutcome;
      }

      const rec = jsonRecord(body);
      if (rec === null) {
        return {
          status: 400,
          body: {
            ok: false,
            code: "live.bad_body",
            error: "Invalid live call request body",
          },
        } satisfies LiveStartOutcome;
      }

      const paneId = jsonStringField(rec.paneId)?.trim();
      // NEVER trimmed: an SDP ends in CRLF by grammar, and the endpoint refuses one that does not
      // (`invalid_offer`). Emptiness is judged on a trimmed copy below; the bytes go through as sent.
      const sdp = jsonStringField(rec.sdp);
      const languageVal = rec.language;
      const language = jsonStringField(languageVal)?.trim();

      if (
        paneId === undefined ||
        paneId === "" ||
        sdp === undefined || sdp === null ||
        sdp.trim() === "" ||
        (languageVal !== undefined && (language === undefined || language.length > 16))
      ) {
        return {
          status: 400,
          body: {
            ok: false,
            code: "live.bad_body",
            error: "Request must include non-empty paneId, sdp, and optional language code (<= 16 chars)",
          },
        } satisfies LiveStartOutcome;
      }

      if (activeSession && activeSession.endedAt === undefined) {
        return {
          status: 409,
          body: {
            ok: false,
            code: "live.busy",
            error: "Another live call is currently active",
          },
        } satisfies LiveStartOutcome;
      }

      const resolved = await paneResolver(paneId);
      if ("code" in resolved) {
        if (resolved.code === "live.no_pane") {
          return {
            status: 404,
            body: {
              ok: false,
              code: "live.no_pane",
              error: `Pane ${paneId} was not found on this host`,
            },
          } satisfies LiveStartOutcome;
        }
        return {
          status: 409,
          body: {
            ok: false,
            code: "live.peer_pane",
            error: "Live call is only supported on panes owned by this host, not on peer panes",
          },
        } satisfies LiveStartOutcome;
      }

      const id = randomUUID();
      const broker = getBroker(currentSettings);
      const user = localUser();
      const instructions = renderLiveInstructions({
        ...user,
        agent: resolved.agent,
        cwd: resolved.cwd,
        language: language && language !== "" ? language : "en",
      });

      let session: LiveSessionLike | undefined;
      const transportFactory = deps.createTransport ?? createCodexLiveTransport;
      const transport = transportFactory({
        broker,
        instructions,
        voice: currentSettings.voice,
        onEvent: (event) => session?.handleEvent?.(event),
      });

      let agent: LiveAgentEndpoint;
      let mcpServer: LiveMcpServer | undefined;
      let sessionWorkDir: string | undefined;

      if (currentSettings.agent !== undefined) {
        if (!deps.operator) {
          if (!operatorWarned) {
            operatorWarned = true;
            console.warn(
              "[live] operator agent configured but operator dependencies missing; falling back to direct pane path",
            );
          }
          const agentFactory = deps.createAgent ?? createPaneAgentEndpoint;
          agent = agentFactory(resolved.port);
        } else {
          const liveDir = join(deps.operator.stateDir, "live");
          sessionWorkDir = join(liveDir, id);
          await mkdir(sessionWorkDir, { recursive: true, mode: 0o700 });
          const socketPath = join(sessionWorkDir, "mcp.sock");
          mcpServer = createLiveMcpServer({ socketPath, port: resolved.port });
          agent = createOperatorAgentEndpoint({
            settings: currentSettings.agent,
            port: resolved.port,
            workDir: sessionWorkDir,
            pumpCommand: deps.operator.pumpCommand,
            mcp: mcpServer,
            language: language && language !== "" ? language : "en",
            now: clock,
          });
        }
      } else {
        const agentFactory = deps.createAgent ?? createPaneAgentEndpoint;
        agent = agentFactory(resolved.port);
      }

      const cleanup = async (): Promise<void> => {
        try {
          mcpServer?.close();
        } catch {
          // ignore
        }
        if (sessionWorkDir) {
          try {
            await rm(sessionWorkDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      };

      const sessionFactory =
        deps.createSession ?? ((opts: LiveSessionOptions) => new LiveSession(opts));
      const liveSession = sessionFactory({
        id,
        transport,
        agent,
        now: clock,
      });
      session = liveSession;
      try {
        const answerSdp = await liveSession.start(sdp);
        activeSession = liveSession;
        sessions.set(id, {
          session: liveSession,
          paneId,
          sessionName: resolved.session,
          cleanup,
        });
        return {
          status: 200,
          body: { ok: true, id, sdp: answerSdp },
          session: resolved.session,
          paneId,
        } satisfies LiveStartOutcome;
      } catch (err) {
        await cleanup();
        await session.stop(String(err)).catch(() => {});
        // endpoint message can name the account and must not reach a browser.
        console.warn(`[live] start failed: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof LiveSignalingError) {
          const code: LiveErrorCode = err.code === "auth" ? "live.auth" : "live.signaling";
          const error =
            err.code === "auth"
              ? "Codex sign-in could not be authorized"
              : "Live signaling handshake with OpenAI realtime failed";
          return {
            status: 502,
            body: { ok: false, code, error },
            session: resolved.session,
            paneId,
          } satisfies LiveStartOutcome;
        }

        return {
          status: 502,
          body: {
            ok: false,
            code: "live.signaling",
            error: "Live call signaling connection failed",
          },
          session: resolved.session,
          paneId,
        } satisfies LiveStartOutcome;
      }
    },
    view(id: string, after: number): LiveViewOutcome {
      reap();
      const stored = sessions.get(id);
      if (!stored) {
        return {
          status: 404,
          body: {
            ok: false,
            code: "live.gone",
            error: "Live session was not found or has been reaped",
          },
        } satisfies LiveViewOutcome;
      }

      const v = stored.session.view(after);
      const body: LiveViewResponse = {
        ok: true,
        phase: v.phase,
        seq: v.seq,
        transcripts: v.transcripts,
      };
      if (v.error !== undefined) body.error = v.error;
      return {
        status: 200,
        body,
      } satisfies LiveViewOutcome;
    },

    async stop(id: string, reason: string): Promise<LiveStopOutcome> {
      reap();
      const stored = sessions.get(id);
      if (!stored) {
        return {
          status: 404,
          body: {
            ok: false,
            code: "live.gone",
            error: "Live session was not found or has been reaped",
          },
        } satisfies LiveStopOutcome;
      }

      await stored.session.stop(reason).catch(() => {});
      if (activeSession === stored.session) {
        activeSession = null;
      }
      await stored.cleanup?.();
      return {
        status: 200,
        body: { ok: true },
        session: stored.sessionName,
        paneId: stored.paneId,
      } satisfies LiveStopOutcome;
    },

    close(): void {
      clearInterval(timer);
      if (activeSession) {
        void activeSession.stop("service closed").catch(() => {});
        activeSession = null;
      }
      for (const item of sessions.values()) {
        void item.cleanup?.();
      }
      sessions.clear();
      cachedBroker?.close();
      cachedBroker = null;
      cachedBrokerKey = null;
    },

    setResolvePane(resolver: LivePaneResolver): void {
      paneResolver = resolver;
    },

    reap(): void {
      reap();
    },
  };
}
