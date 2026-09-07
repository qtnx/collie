// Drive the live call's OPERATOR plane against a real pane, without the voice plane: the same
// herdr adapter, MCP socket server and ompx child the bridge uses, one delegation, and every context
// chunk the voice model would have received printed to stdout. For diagnosing the operator agent
// when the realtime endpoint is unavailable (a revoked Codex login, a network without it).
//
//   bun scripts/live-operator-probe.ts <paneId> "<request>"
//
// Needs a running herdr and a `live.json` with an `agent` block (`collie live on --agent ompx`).
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../bridge/config.ts";
import { isMuxKey } from "../bridge/mux/keys.ts";
import { herdrMuxFactory } from "../bridge/mux/herdr/adapter.ts";
import { createLiveSettingsReader } from "../bridge/live/config.ts";
import type { OperatorPanePort } from "../bridge/live/agent-pane.ts";
import { createLiveMcpServer } from "../bridge/live/mcp-server.ts";
import { createOperatorAgentEndpoint } from "../bridge/live/operator-agent.ts";
import { stripAnsi } from "../bridge/journal/text.ts";
import { sendReplySteps } from "../bridge/server.ts";

const [paneId, request] = process.argv.slice(2);
if (!paneId || !request) {
  console.error("usage: bun scripts/live-operator-probe.ts <paneId> <request>");
  process.exit(2);
}

const cfg = loadConfig();
const settings = await createLiveSettingsReader({ stateDir: cfg.stateDir, warn: console.warn })();
if (!settings?.agent) {
  console.error("live.json has no agent block — run `collie live on --agent ompx`");
  process.exit(2);
}
const herdr = herdrMuxFactory.create({ endpoint: cfg.muxEndpoint, timeoutMs: 5_000, options: {} });
const snapshot = await herdr.snapshot();
const pane = snapshot.panes.find((p) => p.paneId === paneId);
if (!pane) {
  console.error(`pane ${paneId} not found; panes: ${snapshot.panes.map((p) => p.paneId).join(" ")}`);
  process.exit(2);
}

const status = async () => (await herdr.snapshot()).panes.find((p) => p.paneId === paneId)?.status;
const screen = async () => {
  const read = await herdr.readGrid(paneId, { scope: "recent", lines: 80, styling: "preserve" });
  return read.ok ? stripAnsi(read.value.text) : null;
};
const port: OperatorPanePort = {
  meta: { paneId, agent: pane.agent, cwd: pane.cwd },
  async reply(text) {
    const out = await sendReplySteps(herdr, paneId, text, true, cfg.submitKeys);
    return out.ok ? { ok: true } : { ok: false, reason: out.error ?? "send failed" };
  },
  status: () => undefined,
  history: async () => null,
  screen,
  async sendKeys(keys) {
    if (!keys.every(isMuxKey)) return { ok: false, reason: "unknown key" };
    const out = await herdr.sendKeys(paneId, keys);
    return out.ok ? { ok: true } : { ok: false, reason: out.detail };
  },
  listPanes: () => snapshot.panes.map((p) => ({ paneId: p.paneId, agent: p.agent, status: p.status, cwd: p.cwd })),
  async waitIdle(timeoutMs) {
    const until = Date.now() + timeoutMs;
    let last = await screen();
    while (Date.now() < until) {
      await Bun.sleep(1_000);
      const next = await screen();
      if (next === last && (await status()) !== "working") return { status: await status(), settled: true };
      last = next;
    }
    return { status: await status(), settled: false };
  },
};

const workDir = join(cfg.stateDir, "live", `probe-${Date.now()}`);
await mkdir(workDir, { recursive: true, mode: 0o700 });
const mcp = createLiveMcpServer({ socketPath: join(workDir, "mcp.sock"), port, onToolCall: (name, args) => console.log(`[tool] ${name} ${JSON.stringify(args)}`) });
const collieBinary = join(import.meta.dir, "..", "bin", "collie");
const agent = createOperatorAgentEndpoint({
  settings: settings.agent,
  port,
  workDir,
  pumpCommand: [collieBinary, "live-mcp"],
  mcp,
  language: "vi",
});
const done = Promise.withResolvers<void>();
agent.onContext((_id, text, kind) => console.log(`[${kind ?? "speakable"}] ${text}`));
agent.onDelegationEnd(() => done.resolve());
const started = Date.now();
agent.startDelegation("probe-1", request);
await Promise.race([done.promise, Bun.sleep(180_000)]);
console.log(`[probe] finished in ${Date.now() - started} ms`);
await agent.close();
mcp.close();
await rm(workDir, { recursive: true, force: true });
process.exit(0);
