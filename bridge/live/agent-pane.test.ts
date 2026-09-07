import { describe, expect, test } from "bun:test";

import type { TranscriptEntry } from "../journal/types.ts";
import { createPaneAgentEndpoint, type PaneAgentPort } from "./agent-pane.ts";

function assistant(uuid: string, text: string): TranscriptEntry {
  return { uuid, ts: "", role: "assistant", parts: [{ kind: "text", text }] };
}

function controlledClock() {
  let time = 0;
  const waits: (() => void)[] = [];
  return {
    now: () => time,
    sleep: () => new Promise<void>((resolve) => waits.push(resolve)),
    async advance(ms = 1): Promise<void> {
      time += ms;
      const next = waits.shift();
      if (!next) throw new Error("watcher did not wait");
      next();
      await Promise.resolve();
      await Promise.resolve();
    },
    async waitForWatcher(): Promise<void> {
      for (let index = 0; index < 20; index += 1) {
        if (waits.length) return;
        await Promise.resolve();
      }
      throw new Error("watcher did not reach sleep");
    },
  };
}

function pane(overrides: Partial<PaneAgentPort> = {}): PaneAgentPort {
  return {
    reply: async () => ({ ok: true }),
    status: () => "idle",
    history: async () => [],
    screen: async () => null,
    ...overrides,
  };
}

describe("createPaneAgentEndpoint", () => {
  test("streams each new assistant entry once then sends final message on working to idle", async () => {
    const clock = controlledClock();
    const old = assistant("old", "old answer");
    const fresh = assistant("new", "new answer");
    let statusCalls = 0;
    let historyCalls = 0;
    const endpoint = createPaneAgentEndpoint(
      pane({
        status: () => (statusCalls++ === 0 ? "working" : "idle"),
        history: async () => (historyCalls++ === 0 ? [old] : [old, fresh]),
      }),
      { now: clock.now, sleep: clock.sleep, pollMs: 1 },
    );
    const contexts: Array<{ text: string; kind?: "commentary" }> = [];
    const ended: string[] = [];
    endpoint.onContext((_id, text, kind) => contexts.push({ text, kind }));
    endpoint.onDelegationEnd((id) => ended.push(id));

    endpoint.startDelegation("d1", "fix it");
    await clock.waitForWatcher();
    await clock.advance();
    await clock.waitForWatcher();
    await clock.advance();

    expect(contexts).toEqual([
      { text: "new answer", kind: "commentary" },
      { text: '"Agent Final Message":\n\nnew answer', kind: undefined },
    ]);
    expect(ended).toEqual(["d1"]);
  });

  test("falls back to terminal screen when journal is unavailable", async () => {
    const clock = controlledClock();
    let statuses = 0;
    const endpoint = createPaneAgentEndpoint(
      pane({
        status: () => (statuses++ === 0 ? "working" : "idle"),
        history: async () => null,
        screen: async () => "x".repeat(1_600) + "terminal answer",
      }),
      { now: clock.now, sleep: clock.sleep, pollMs: 1 },
    );
    const contexts: string[] = [];
    endpoint.onContext((_id, text) => contexts.push(text));

    endpoint.startDelegation("d2", "work");
    await clock.waitForWatcher();
    await clock.advance();
    await clock.waitForWatcher();
    await clock.advance();
    await Promise.resolve();

    expect(contexts.join("")).toBe(`"Agent Final Message":\n\n${("x".repeat(1_600) + "terminal answer").slice(-1_500)}`);
  });

  test("returns a speakable failure when typing is rejected", async () => {
    const endpoint = createPaneAgentEndpoint(pane({ reply: async () => ({ ok: false, reason: "pane gone" }) }));
    const contexts: string[] = [];
    const ended: string[] = [];
    endpoint.onContext((_id, text) => contexts.push(text));
    endpoint.onDelegationEnd((id) => ended.push(id));

    endpoint.startDelegation("d3", "work");
    await Promise.resolve();
    await Promise.resolve();

    expect(contexts).toEqual(['"Agent Final Message":\n\nThe request could not be typed into the terminal: pane gone']);
    expect(ended).toEqual(["d3"]);
  });

  test("supersedes the old watcher", async () => {
    const clock = controlledClock();
    const endpoint = createPaneAgentEndpoint(pane({ history: async () => [assistant("a", "answer")] }), {
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 1,
    });
    const ended: string[] = [];
    endpoint.onDelegationEnd((id) => ended.push(id));

    endpoint.startDelegation("old", "old work");
    await clock.waitForWatcher();
    endpoint.startDelegation("new", "new work");
    await clock.advance();
    await clock.waitForWatcher();
    await endpoint.close();

    expect(ended).not.toContain("old");
  });
});
