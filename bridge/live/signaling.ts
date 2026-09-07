import type { JsonValue } from "../json.ts";
import { accountIdFromJwt } from "../stt/codex.ts";
import type { CodexAuthBroker } from "../stt/codex-auth.ts";
import { jsonRecord, jsonStringField } from "../stt/json.ts";
import {
  buildLiveSessionPayload,
  type LiveClientMessage,
  type LiveServerEvent,
  parseLiveServerEvent,
} from "./protocol.ts";

export const LIVE_SIGNALING_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
export const CODEX_DESKTOP_VERSION = "0.153.0";

const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;

type TransportState = "idle" | "connecting" | "connected" | "closing" | "closed";
export interface LiveHeaders {
  Authorization: string;
  "OpenAI-Alpha": "quicksilver=v2";
  "User-Agent": string;
  "x-session-id": string;
  originator: "Codex Desktop";
  version: string;
  "session-id": string;
  "thread-id": string;
  "chatgpt-account-id"?: string;
}

/** Control plane of one live call: signaling + the sideband WebSocket. */
export interface LiveControlTransport {
  /** POST the browser's SDP offer, open the sideband; resolves with the SDP answer. */
  connect(offerSdp: string): Promise<string>;
  send(message: LiveClientMessage): Promise<void>;
  close(): Promise<void>;
}

export interface CodexLiveTransportDeps {
  broker: CodexAuthBroker;
  instructions: string;
  voice: string;
  onEvent(event: LiveServerEvent): void;
  fetch?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  sleep?: (ms: number) => Promise<void>;
}

export class LiveSignalingError extends Error {
  readonly code: "auth" | "signaling";

  constructor(code: "auth" | "signaling", message: string) {
    super(message);
    this.name = "LiveSignalingError";
    this.code = code;
  }
}

export function liveHeaders(
  accessToken: string,
  accountId: string,
  scopedSessionId: string,
  realtimeSessionId: string,
): LiveHeaders {
  const headers: LiveHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "OpenAI-Alpha": "quicksilver=v2",
    "User-Agent": `Codex Desktop/${CODEX_DESKTOP_VERSION}`,
    "x-session-id": realtimeSessionId,
    originator: "Codex Desktop",
    version: CODEX_DESKTOP_VERSION,
    "session-id": scopedSessionId,
    "thread-id": scopedSessionId,
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return headers;
}

export function parseLiveCallId(location: string | null): string | undefined {
  if (!location) return undefined;
  return location
    .split("?", 1)[0]
    ?.split("/")
    .find((segment) => LIVE_CALL_ID_PATTERN.test(segment));
}

export function buildLiveSidebandUrl(callId: string): string {
  const url = new URL(`https://api.openai.com/v1/live/${encodeURIComponent(callId)}`);
  url.protocol = "wss:";
  return url.toString();
}

/** `error.code` from a refusal body, bounded and identifier-shaped, or empty when there is none. */
function parseRefusalCode(body: string): string {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; every field is narrowed below.
    parsed = JSON.parse(body) as JsonValue;
  } catch {
    return "";
  }
  const error = jsonRecord(jsonRecord(parsed)?.error);
  const code = error === null ? null : jsonStringField(error.code);
  return code !== null && /^[\w.-]{1,64}$/.test(code) ? code : "";
}

/** Create a transport whose I/O seams keep signaling and socket behavior testable. */
export function createCodexLiveTransport(deps: CodexLiveTransportDeps): LiveControlTransport {
  const fetchImpl = deps.fetch ?? fetch;
  const WebSocketImpl = deps.WebSocketImpl ?? WebSocket;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const scopedSessionId = crypto.randomUUID();
  const realtimeSessionId = crypto.randomUUID();
  let state: TransportState = "idle";
  let sideband: WebSocket | undefined;
  let sendTail: Promise<void> = Promise.resolve();
  let connectPromise: Promise<string> | undefined;
  let closePromise: Promise<void> | undefined;
  let unexpectedFailureReported = false;

  const reportFailure = (message: string): void => {
    if ((state !== "connecting" && state !== "connected") || unexpectedFailureReported) return;
    unexpectedFailureReported = true;
    deps.onEvent({ type: "error", message });
  };

  const signal = async (offerSdp: string): Promise<{ answer: string; callId: string; headers: LiveHeaders }> => {
    let token: string;
    try {
      token = (await deps.broker.accessToken()).accessToken;
    } catch (cause) {
      throw new LiveSignalingError("auth", `Codex authentication failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let accountId: string;
      try {
        accountId = accountIdFromJwt(token);
      } catch (cause) {
        throw new LiveSignalingError("auth", `Codex authentication failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const headers = liveHeaders(token, accountId, scopedSessionId, realtimeSessionId);
      const response = await fetchImpl(LIVE_SIGNALING_URL, {
        method: "POST",
        headers: { ...headers, Accept: "*/*", "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: offerSdp, session: buildLiveSessionPayload(deps.instructions, deps.voice) }),
        redirect: "manual",
      });
      if (response.status === 401 && attempt === 0) {
        try {
          token = (await deps.broker.accessToken(true)).accessToken;
        } catch (cause) {
          throw new LiveSignalingError("auth", `Codex authentication failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        continue;
      }
      if (!response.ok) {
        // The endpoint's own `error.code` (an identifier like `invalid_offer`, never prose that could
        // name the account) rides the journal line; the phone still sees the status alone.
        const refusal = parseRefusalCode(await response.text().catch(() => ""));
        throw new LiveSignalingError(
          "signaling",
          `Codex live signaling refused the call (${response.status}${refusal ? ` ${refusal}` : ""})`,
        );
      }
      const answer = await response.text();
      if (!answer.trim()) throw new LiveSignalingError("signaling", "Codex live signaling returned an empty SDP answer");
      const callId = parseLiveCallId(response.headers.get("Location"));
      if (!callId) throw new LiveSignalingError("signaling", "Codex live signaling returned no valid call ID");
      return { answer, callId, headers };
    }
    throw new LiveSignalingError("auth", "Codex authentication failed");
  };

  const openSideband = (callId: string, headers: LiveHeaders): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const socket: WebSocket = Reflect.construct(WebSocketImpl, [buildLiveSidebandUrl(callId), { headers }]);
      let opened = false;
      let settled = false;
      const timeout = setTimeout(() => {
        socket.close(1000, "connect timeout");
        if (!settled) {
          settled = true;
          reject(new Error("Codex live sideband connection timed out"));
        }
      }, SIDEBAND_CONNECT_TIMEOUT_MS);
      timeout.unref?.();
      const rejectConnect = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(message));
      };
      socket.addEventListener("open", () => {
        if (settled) {
          socket.close(1000, "stale");
          return;
        }
        opened = true;
        settled = true;
        clearTimeout(timeout);
        sideband = socket;
        console.log(`[live] sideband open for ${callId}`);
        resolve();
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof Blob || event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
          reportFailure("Codex live sideband returned an unexpected binary frame.");
          return;
        }
        if (state === "closing" || state === "closed") return;
        const eventValue = parseLiveServerEvent(event.data);
        if (eventValue?.type === "unknown") console.log(`[live] sideband event ${eventValue.wireType}`);
        if (eventValue) deps.onEvent(eventValue);
      });
      socket.addEventListener("error", (event) => {
        const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : "";
        if (!opened) {
          socket.close(1011, "connection failed");
          rejectConnect(`Codex live sideband connection failed${detail}`);
          return;
        }
        reportFailure(`Codex live sideband failed${detail}`);
      });
      socket.addEventListener("close", (event) => {
        if (!opened) {
          rejectConnect(`Codex live sideband closed before connecting (${event.code})`);
          return;
        }
        if (sideband !== socket) return;
        sideband = undefined;
        console.log(`[live] sideband closed (${event.code}) ${event.reason}`);
        reportFailure(`Codex live sideband closed (${event.code})${event.reason ? `: ${event.reason}` : ""}`);
      });
    });

  const connectSideband = async (callId: string, headers: LiveHeaders): Promise<void> => {
    let failure = new Error("Codex live sideband connection failed");
    for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt += 1) {
      try {
        await openSideband(callId, headers);
        return;
      } catch (cause) {
        failure = cause instanceof Error ? cause : new Error(String(cause));
        if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) await sleep(200 * 2 ** attempt);
      }
    }
    throw failure;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      state = "closing";
      const socket = sideband;
      sideband = undefined;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close(1000, "done");
      state = "closed";
    })();
    return closePromise;
  };

  return {
    connect(offerSdp: string): Promise<string> {
      if (state === "connected" && connectPromise) return connectPromise;
      if (connectPromise) return connectPromise;
      if (state === "closing" || state === "closed") return Promise.reject(new Error("Live transport is closed"));
      state = "connecting";
      connectPromise = (async () => {
        try {
          const { answer, callId, headers } = await signal(offerSdp);
          await connectSideband(callId, headers);
          if (state !== "connecting") throw new Error("Live transport closed while connecting");
          state = "connected";
          return answer;
        } catch (cause) {
          await close();
          throw cause;
        }
      })();
      return connectPromise;
    },
    send(message: LiveClientMessage): Promise<void> {
      const operation = sendTail.then(() => {
        if (state !== "connected" || !sideband || sideband.readyState !== WebSocket.OPEN) {
          throw new Error("Codex live sideband is not connected");
        }
        sideband.send(JSON.stringify(message));
        return undefined;
      });
      sendTail = operation.catch(() => undefined);
      return operation;
    },
    close,
  };
}
