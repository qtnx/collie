import { describe, expect, test } from "bun:test";

import type { LiveAgentEndpoint } from "./agent-pane.ts";
import type { LiveClientMessage } from "./protocol.ts";
import type { LiveControlTransport } from "./signaling.ts";
import { LiveSession } from "./session.ts";

class FakeTransport implements LiveControlTransport {
  readonly sent: LiveClientMessage[] = [];
  closed = false;

  async connect(): Promise<string> {
    return "answer-sdp";
  }

  async send(message: LiveClientMessage): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeAgent implements LiveAgentEndpoint {
  readonly started: Array<{ id: string; request: string }> = [];
  private contextHandler: ((id: string, text: string, kind?: "commentary") => void) | undefined;
  private endHandler: ((id: string) => void) | undefined;
  closed = false;

  startDelegation(id: string, request: string): void {
    this.started.push({ id, request });
  }

  onContext(handler: (id: string, text: string, kind?: "commentary") => void): void {
    this.contextHandler = handler;
  }

  onDelegationEnd(handler: (id: string) => void): void {
    this.endHandler = handler;
  }

  emitContext(id: string, text: string, kind?: "commentary"): void {
    this.contextHandler?.(id, text, kind);
  }

  emitEnd(id: string): void {
    this.endHandler?.(id);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function flush(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

describe("LiveSession", () => {
  test("handles a full delegation round trip through context append", async () => {
    let now = 10;
    const transport = new FakeTransport();
    const agent = new FakeAgent();
    const session = new LiveSession({ id: "live-1", transport, agent, now: () => now });

    await expect(session.start("offer-sdp")).resolves.toBe("answer-sdp");
    session.handleEvent({ type: "session.started", session: { id: "remote" } });
    session.handleEvent({
      type: "delegation.created",
      item: { type: "delegation", target: "client", id: "d1", content: [{ type: "input_text", text: "fix" }, { type: "input_text", text: "tests" }] },
    });
    expect(agent.started).toEqual([{ id: "d1", request: "fix\ntests" }]);
    expect(session.view(0).phase).toBe("working");

    agent.emitContext("d1", "done", "commentary");
    await flush();
    expect(transport.sent).toContainEqual({
      type: "delegation.context.append",
      delegation_item_id: "d1",
      channel: "commentary",
      content: [{ type: "input_text", text: "done" }],
    });
    agent.emitEnd("d1");
    expect(session.view(0).phase).toBe("listening");

    session.handleEvent({ type: "output_transcript.added", item: { text: "hel" } });
    session.handleEvent({ type: "output_transcript.added", item: { text: "hello" } });
    session.handleEvent({ type: "turn.done", turn: { role: "assistant", transcript: "hello" } });
    now = 20;
    expect(session.view(1)).toMatchObject({
      seq: 3,
      transcripts: [
        { seq: 2, role: "assistant", turn: 1, text: "hello", final: false },
        { seq: 3, role: "assistant", turn: 1, text: "hello", final: true },
      ],
    });
    expect(session.lastSeen).toBe(20);
  });

  test("error event stops transport and keeps error phase", async () => {
    const transport = new FakeTransport();
    const agent = new FakeAgent();
    const session = new LiveSession({ id: "live-2", transport, agent });

    await session.start("offer");
    session.handleEvent({ type: "error", message: "sideband failed" });
    await session.stop();

    expect(session.view(0)).toMatchObject({ phase: "error", error: "sideband failed" });
    expect(agent.closed).toBe(true);
    expect(transport.closed).toBe(true);
  });

  test("accepts session.started before start() resolves, ignores events after stop", async () => {
    const transport = new FakeTransport();
    const agent = new FakeAgent();
    const session = new LiveSession({ id: "live-3", transport, agent });

    // The sideband opens before connect() resolves, so the first event can beat the answer.
    session.handleEvent({ type: "session.started", session: { id: "early" } });
    expect(session.view(0).phase).toBe("listening");
    await session.start("offer");
    await session.stop();
    session.handleEvent({ type: "session.started", session: { id: "late" } });
    expect(session.view(0).phase).toBe("ended");
  });
});
