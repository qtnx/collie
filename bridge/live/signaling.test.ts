import { describe, expect, test } from "bun:test";

import type { CodexAuthBroker } from "../stt/codex-auth.ts";
import {
  CODEX_DESKTOP_VERSION,
  type LiveHeaders,
  LiveSignalingError,
  createCodexLiveTransport,
} from "./signaling.ts";

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

class FakeWebSocket extends EventTarget implements WebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1 as const;
  static CONNECTING = 0 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;
  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;
  binaryType: BinaryType = "blob";
  readonly bufferedAmount = 0;
  readonly extensions = "";
  onclose: ((this: WebSocket, event: CloseEvent) => void) | null = null;
  onerror: ((this: WebSocket, event: Event) => void) | null = null;
  onmessage: ((this: WebSocket, event: MessageEvent) => void) | null = null;
  onopen: ((this: WebSocket, event: Event) => void) | null = null;
  readonly protocol = "";
  readyState: 0 | 1 | 2 | 3 = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly options: { headers: LiveHeaders } | undefined;
  readonly sent: string[] = [];

  constructor(url: string | URL, protocols?: string | string[]);
  constructor(url: string, options: { headers: LiveHeaders });
  constructor(url: string | URL, options?: string | string[] | { headers: LiveHeaders }) {
    super();
    this.url = url.toString();
    if (options instanceof Object && "headers" in options) {
      // SAFETY: transport constructs this fake with the live-only `{ headers }` options overload.
      this.options = options as { headers: LiveHeaders };
    }
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function accessToken(accountId = "acct-live"): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth.chatgpt_account_id": accountId })).toString("base64url");
  return `header.${payload}.signature`;
}

function broker(tokens: string[], reject = false): CodexAuthBroker {
  let index = 0;
  return {
    lastKnown: () => ({ available: true, provider: "codex", checkedAt: 0 }),
    accessToken: async () => {
      if (reject) throw new Error("sign in required");
      return { accessToken: tokens[Math.min(index++, tokens.length - 1)] ?? accessToken() };
    },
    probe: async () => ({ available: true, provider: "codex", checkedAt: 0 }),
    close: () => {},
  };
}

function transport(fetchImpl: FetchStub, auth = broker([accessToken()])) {
  FakeWebSocket.instances = [];
  const WebSocketImpl: typeof WebSocket = FakeWebSocket;
  // SAFETY: fetch stubs receive only URL and RequestInit values the transport passes, and return real Responses.
  const fetch = fetchImpl as typeof globalThis.fetch;
  return createCodexLiveTransport({
    broker: auth,
    instructions: "instructions",
    voice: "sol",
    fetch,
    WebSocketImpl,
    onEvent: () => {},
  });
}

describe("createCodexLiveTransport", () => {
  test("posts Desktop identity then opens a header-authenticated sideband", async () => {
    let request: Request | undefined;
    const live = transport(async (input, init) => {
      request = new Request(input, init);
      return new Response("answer-sdp", { status: 200, headers: { Location: "/v1/live/rtc_call" } });
    });

    await expect(live.connect("offer-sdp")).resolves.toBe("answer-sdp");
    expect(await request?.json()).toEqual({
      sdp: "offer-sdp",
      session: { model: "gpt-live-1-codex", instructions: "instructions", audio: { output: { voice: "sol" } }, delegation: { type: "client" } },
    });
    expect(request?.headers.get("user-agent")).toBe(`Codex Desktop/${CODEX_DESKTOP_VERSION}`);
    expect(FakeWebSocket.instances[0]?.options?.headers).toMatchObject({
      Authorization: `Bearer ${accessToken()}`,
      originator: "Codex Desktop",
      "chatgpt-account-id": "acct-live",
    });
  });
  test("refreshes token once after signaling 401", async () => {
    let calls = 0;
    const live = transport(async () => {
      calls += 1;
      return calls === 1
        ? new Response("expired", { status: 401 })
        : new Response("answer", { status: 200, headers: { Location: "/rtc_retry" } });
    }, broker([accessToken("acct-old"), accessToken("acct-new")]));

    await expect(live.connect("offer")).resolves.toBe("answer");
    expect(calls).toBe(2);
    expect(FakeWebSocket.instances[0]?.options?.headers.Authorization).toBe(`Bearer ${accessToken("acct-new")}`);
  });

  test("keeps forbidden response body out of signaling error", async () => {
    const live = transport(async () => new Response("private upstream body", { status: 403 }));
    await expect(live.connect("offer")).rejects.toMatchObject({
      code: "signaling",
      message: "Codex live signaling refused the call (403)",
    } satisfies Partial<LiveSignalingError>);
  });

  test("maps broker rejection to an auth error", async () => {
    const live = transport(async () => new Response("unused"), broker([], true));
    await expect(live.connect("offer")).rejects.toMatchObject({ code: "auth" } satisfies Partial<LiveSignalingError>);
  });
});

test("Bun WebSocket options forward custom headers", async () => {
  const received = Promise.withResolvers<string | null>();
  const bridge = Bun.serve<{ header: string | null }>({
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request, { data: { header: request.headers.get("x-live-test") } })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        socket.send(socket.data.header ?? "");
      },
      message() {},
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const socket: WebSocket = Reflect.construct(WebSocket, [
        `ws://127.0.0.1:${bridge.port}`,
        { headers: { "x-live-test": "arrived" } },
      ]);
      socket.addEventListener("message", (event) => {
        received.resolve(String(event.data));
        socket.close();
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => reject(new Error("local WebSocket failed")), { once: true });
    });
    await expect(received.promise).resolves.toBe("arrived");
  } finally {
    bridge.stop(true);
  }
});
