import { describe, expect, test } from "bun:test";

import { LIVE_FILENAME } from "../bridge/live/config.ts";
import { capture, context, type FakeFiles, fakeFiles, fakeExec, STATE } from "./fakes.ts";
import { EXIT, type Io } from "./io.ts";
import { cmdLive, cmdLiveOff, cmdLiveOn, cmdLiveStatus, type LiveDeps } from "./live.ts";

const LIVE_CONFIG_PATH = `${STATE}/${LIVE_FILENAME}`;

type Deps = LiveDeps & { io: Io & { stdout: string[]; stderr: string[] }; files: FakeFiles };

function testDeps(
  over: {
    seed?: Record<string, string>;
    answers?: string[];
    absent?: string[];
    interactive?: boolean;
  } = {},
): Deps {
  const io = capture();
  const files = fakeFiles(over.seed ?? {});
  const queued = [...(over.answers ?? [])];
  const interactive = over.interactive ?? queued.length > 0;

  return {
    ctx: context({}),
    io,
    files,
    exec: fakeExec({ absent: over.absent ?? [] }),
    interactive,
    prompt: () => queued.shift() ?? null,
  };
}

describe("collie live on", () => {
  test("enables live with --yes in non-interactive mode", async () => {
    const d = testDeps();
    const code = await cmdLiveOn(d, ["--yes"]);

    expect(code).toBe(EXIT.OK);
    const entry = d.files.entries.get(LIVE_CONFIG_PATH);
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe(0o600);
    // SAFETY: cmdLiveOn serializes this exact object into live.json.
    const parsed = JSON.parse(entry!.text) as { voice: string; codexBin: string };
    expect(parsed.voice).toBe("sol");
    // The RESOLVED path lands in the file, because the bridge's systemd PATH lacks the operator's.
    expect(parsed.codexBin).toBe("/fake/codex");
    expect(d.io.stdout.join("\n")).toContain("enabled live call");
  });

  test("enables live with custom voice", async () => {
    const d = testDeps();
    const code = await cmdLiveOn(d, ["--voice", "ember", "--yes"]);

    expect(code).toBe(EXIT.OK);
    const entry = d.files.entries.get(LIVE_CONFIG_PATH);
    // SAFETY: cmdLiveOn serializes this exact object into live.json.
    const parsed = JSON.parse(entry!.text) as { voice: string; codexBin: string };
    expect(parsed.voice).toBe("ember");
  });

  test("rejects unknown voice", async () => {
    const d = testDeps();
    const code = await cmdLiveOn(d, ["--voice", "robot", "--yes"]);

    expect(code).toBe(EXIT.USAGE);
    expect(d.files.entries.has(LIVE_CONFIG_PATH)).toBe(false);
    expect(d.io.stderr.join("\n")).toContain("unknown voice \"robot\"");
  });

  test("fails when codex binary is missing on PATH", async () => {
    const d = testDeps({ absent: ["codex"] });
    const code = await cmdLiveOn(d, ["--yes"]);

    expect(code).toBe(EXIT.FAIL);
    expect(d.files.entries.has(LIVE_CONFIG_PATH)).toBe(false);
    expect(d.io.stderr.join("\n")).toContain("no `codex` binary was found on PATH");
  });

  test("refuses non-interactive run without --yes", async () => {
    const d = testDeps({ interactive: false });
    const code = await cmdLiveOn(d, []);

    expect(code).toBe(EXIT.USAGE);
    expect(d.files.entries.has(LIVE_CONFIG_PATH)).toBe(false);
    expect(d.io.stderr.join("\n")).toContain("requires consent — pass --yes");
  });

  test("interactive run prompts for consent and accepts 'y'", async () => {
    const d = testDeps({ answers: ["y"] });
    const code = await cmdLiveOn(d, []);

    expect(code).toBe(EXIT.OK);
    expect(d.files.entries.has(LIVE_CONFIG_PATH)).toBe(true);
  });

  test("interactive run prompts for consent and rejects 'n'", async () => {
    const d = testDeps({ answers: ["n"] });
    const code = await cmdLiveOn(d, []);

    expect(code).toBe(EXIT.FAIL);
    expect(d.files.entries.has(LIVE_CONFIG_PATH)).toBe(false);
    expect(d.io.stderr.join("\n")).toContain("live call not enabled");
  });

  test("enables live with --agent ompx and default model", async () => {
    const d = testDeps();
    const code = await cmdLiveOn(d, ["--agent", "ompx", "--yes"]);

    expect(code).toBe(EXIT.OK);
    const entry = d.files.entries.get(LIVE_CONFIG_PATH);
    expect(entry).toBeDefined();
    // SAFETY: cmdLiveOn writes this structure.
    const parsed = JSON.parse(entry!.text) as {
      voice: string;
      codexBin: string;
      agent?: { kind: string; bin: string; model: string };
    };
    expect(parsed.agent).toEqual({
      kind: "ompx",
      bin: "/fake/ompx",
      model: "openai-codex/gpt-5.6-luna",
    });
    expect(d.io.stdout.join("\n")).toContain("agent: ompx [openai-codex/gpt-5.6-luna]");
  });

  test("enables live with --agent ompx and custom --model", async () => {
    const d = testDeps();
    const code = await cmdLiveOn(d, ["--agent", "ompx", "--model", "custom/model", "--yes"]);

    expect(code).toBe(EXIT.OK);
    const entry = d.files.entries.get(LIVE_CONFIG_PATH);
    // SAFETY: cmdLiveOn writes this structure.
    const parsed = JSON.parse(entry!.text) as {
      voice: string;
      codexBin: string;
      agent?: { kind: string; bin: string; model: string };
    };
    expect(parsed.agent).toEqual({
      kind: "ompx",
      bin: "/fake/ompx",
      model: "custom/model",
    });
  });

  test("fails when ompx binary is missing on PATH", async () => {
    const d = testDeps({ absent: ["ompx"] });
    const code = await cmdLiveOn(d, ["--agent", "ompx", "--yes"]);

    expect(code).toBe(EXIT.FAIL);
    expect(d.files.entries.has(LIVE_CONFIG_PATH)).toBe(false);
    expect(d.io.stderr.join("\n")).toContain("no `ompx` binary was found on PATH");
  });

  test("rejects unknown agent kind", async () => {
    const d = testDeps();
    const code = await cmdLiveOn(d, ["--agent", "other", "--yes"]);

    expect(code).toBe(EXIT.USAGE);
    expect(d.files.entries.has(LIVE_CONFIG_PATH)).toBe(false);
    expect(d.io.stderr.join("\n")).toContain("unknown agent \"other\"");
  });

  test("rejects --model without --agent", async () => {
    const d = testDeps();
    const code = await cmdLiveOn(d, ["--model", "custom/model", "--yes"]);

    expect(code).toBe(EXIT.USAGE);
    expect(d.files.entries.has(LIVE_CONFIG_PATH)).toBe(false);
    expect(d.io.stderr.join("\n")).toContain("--model requires --agent ompx");
  });
});

describe("collie live off", () => {
  test("removes live.json when present", () => {
    const d = testDeps({
      seed: { [LIVE_CONFIG_PATH]: JSON.stringify({ voice: "sol", codexBin: "codex" }) },
    });
    expect(d.files.exists(LIVE_CONFIG_PATH)).toBe(true);

    const code = cmdLiveOff(d);
    expect(code).toBe(EXIT.OK);
    expect(d.files.exists(LIVE_CONFIG_PATH)).toBe(false);
    expect(d.io.stdout.join("\n")).toContain("removed");
  });

  test("is clean no-op when already off", () => {
    const d = testDeps();
    const code = cmdLiveOff(d);
    expect(code).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("already off");
  });
});

describe("collie live status", () => {
  test("reports off when live.json missing", () => {
    const d = testDeps();
    const code = cmdLiveStatus(d);
    expect(code).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("live call: off");
  });

  test("reports on when live.json present", () => {
    const d = testDeps({
      seed: { [LIVE_CONFIG_PATH]: JSON.stringify({ voice: "juniper", codexBin: "codex" }) },
    });
    const code = cmdLiveStatus(d);
    expect(code).toBe(EXIT.OK);
    const out = d.io.stdout.join("\n");
    expect(out).toContain("live call: on");
    expect(out).toContain("voice:     juniper");
    expect(out).toContain("codex-bin: codex");
  });

  test("reports agent details when agent present in live.json", () => {
    const d = testDeps({
      seed: {
        [LIVE_CONFIG_PATH]: JSON.stringify({
          voice: "juniper",
          codexBin: "codex",
          agent: { kind: "ompx", bin: "ompx", model: "custom/model" },
        }),
      },
    });
    const code = cmdLiveStatus(d);
    expect(code).toBe(EXIT.OK);
    const out = d.io.stdout.join("\n");
    expect(out).toContain("agent:     ompx [custom/model] (ompx)");
  });
});

describe("collie live dispatcher", () => {
  test("routes to subcommands and usage on unknown", async () => {
    const d = testDeps({ answers: ["y"] });
    expect(await cmdLive(d, ["on"])).toBe(EXIT.OK);
    expect(await cmdLive(d, ["status"])).toBe(EXIT.OK);
    expect(await cmdLive(d, ["off"])).toBe(EXIT.OK);

    const badCode = await cmdLive(d, ["unknown"]);
    expect(badCode).toBe(EXIT.USAGE);
    expect(d.io.stderr.join("\n")).toContain("usage: collie live {on|off|status}");
  });
});
