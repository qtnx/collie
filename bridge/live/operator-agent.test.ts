import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../json.ts";

import type { OperatorPanePort } from "./agent-pane.ts";
import { createOperatorAgentEndpoint, type OperatorChild, type OperatorClock } from "./operator-agent.ts";
import type { LiveMcpServer } from "./mcp-server.ts";

class FakeClock implements OperatorClock {
  readonly delays: number[] = [];
  private readonly callbacks = new Map<ReturnType<typeof setTimeout>, () => void>();

  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = globalThis.setTimeout(() => undefined, 0);
    globalThis.clearTimeout(timer);
    this.delays.push(ms);
    this.callbacks.set(timer, fn);
    return timer;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) this.callbacks.delete(timer);
  }

  fire(ms: number): void {
    for (const [timer, callback] of this.callbacks) {
      if (this.delays.includes(ms)) {
        this.callbacks.delete(timer);
        callback();
        return;
      }
    }
    throw new Error(`no timer for ${ms}`);
  }
}

function pane(): OperatorPanePort {
  return {
    meta: { paneId: "p1", agent: "claude", cwd: "/repo" },
    reply: async () => ({ ok: true }),
    status: () => "idle",
    history: async () => [],
    screen: async () => "screen",
    sendKeys: async () => ({ ok: true }),
    listPanes: () => [],
    waitIdle: async () => ({ status: "idle", settled: true }),
  };
}

function fakeChild() {
  let stdout: ((chunk: Uint8Array) => void) | undefined;
  let exited: ((code: number | null) => void) | undefined;
  const writes: string[] = [];
  let ended = false;
  let killed = false;
  const child: OperatorChild = {
    stdin: { write: (chunk) => (writes.push(chunk), true), end: () => { ended = true; } },
    onStdout: (listener) => { stdout = listener; },
    onStderr: () => {},
    onExit: (listener) => { exited = listener; },
    kill: () => { killed = true; },
  };
  const send = (frame: JsonObject) => stdout?.(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
  return { child, writes, send, exit: () => exited?.(1), get ended() { return ended; }, get killed() { return killed; } };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createOperatorAgentEndpoint", () => {
  test("replays RPC events, writes MCP config, and steers active delegation", async () => {
    const fake = fakeChild();
    const clock = new FakeClock();
    const writes: Array<{ path: string; text: string; mode: number }> = [];
    let argv: readonly string[] = [];
    const endpoint = createOperatorAgentEndpoint({
      settings: { kind: "ompx", bin: "/bin/ompx", model: "model" },
      port: pane(),
      workDir: "/private/live",
      pumpCommand: ["/bin/collie", "live-mcp"],
      mcp: { socketPath: "/private/live/mcp.sock", close: () => {} } satisfies LiveMcpServer,
      language: "English",
      clock,
      files: { write: (path, text, mode) => writes.push({ path, text, mode }) },
      spawn: (command) => { argv = command; return fake.child; },
    });
    const contexts: Array<{ id: string; text: string; kind?: string }> = [];
    const ended: string[] = [];
    endpoint.onContext((id, text, kind) => contexts.push({ id, text, kind }));
    endpoint.onDelegationEnd((id) => ended.push(id));

    endpoint.startDelegation("first", "fix it");
    fake.send({ type: "ready", protocolVersion: 1 });
    await settle();
    expect(argv).toContain("--mode=rpc");
    expect(argv).toContain("--tools=mcp__herdr_read_screen,mcp__herdr_type_text,mcp__herdr_send_keys,mcp__herdr_wait_until_idle,mcp__herdr_read_history,mcp__herdr_list_panes");
    expect(fake.writes.join("")).toContain('"type":"prompt"');
    expect(writes).toEqual([{ path: "/private/live/mcp.json", text: '{"mcpServers":{"herdr":{"type":"stdio","command":"/bin/collie","args":["live-mcp"],"env":{"COLLIE_LIVE_MCP_SOCKET":"/private/live/mcp.sock"}}}}', mode: 0o600 }]);

    endpoint.startDelegation("second", "new request");
    await settle();
    expect(fake.writes.join("")).toContain('"type":"steer"');
    fake.send({ type: "tool_execution_start", toolName: "mcp__herdr_read_screen" });
    fake.send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Working." }] }, stopReason: "toolUse" });
    fake.send({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Finished." }] }] });
    await settle();
    expect(contexts).toContainEqual({ id: "second", text: "Using read_screen", kind: "commentary" });
    expect(contexts).toContainEqual({ id: "second", text: "Working.", kind: "commentary" });
    expect(contexts).toContainEqual({ id: "second", text: '"Agent Final Message":\n\nFinished.', kind: undefined });
    expect(ended).toEqual(["second"]);
  });

  test("reports an unexpected child exit and kills after injected close timer", async () => {
    const fake = fakeChild();
    const clock = new FakeClock();
    const endpoint = createOperatorAgentEndpoint({
      settings: { kind: "ompx", bin: "/bin/ompx", model: "model" }, port: pane(), workDir: "/private/live", pumpCommand: ["/bin/collie", "live-mcp"], mcp: { socketPath: "/socket", close: () => {} }, language: "English", clock,
      files: { write: () => {} }, spawn: () => fake.child,
    });
    const contexts: string[] = [];
    const ended: string[] = [];
    endpoint.onContext((_id, text) => contexts.push(text));
    endpoint.onDelegationEnd((id) => ended.push(id));
    endpoint.startDelegation("d1", "work");
    fake.send({ type: "ready" });
    await settle();
    fake.exit();
    expect(contexts).toContain('"Agent Final Message":\n\nThe operator agent stopped unexpectedly.');
    expect(ended).toEqual(["d1"]);

    const closingFake = fakeChild();
    const closing = createOperatorAgentEndpoint({
      settings: { kind: "ompx", bin: "/bin/ompx", model: "model" }, port: pane(), workDir: "/private/closing", pumpCommand: ["/bin/collie", "live-mcp"], mcp: { socketPath: "/socket", close: () => {} }, language: "English", clock,
      files: { write: () => {} }, spawn: () => closingFake.child,
    });
    closing.startDelegation("d2", "work");
    closingFake.send({ type: "ready" });
    await settle();
    const closingPromise = closing.close();
    expect(closingFake.ended).toBe(true);
    clock.fire(3_000);
    await closingPromise;
    expect(closingFake.killed).toBe(true);
  });
});
