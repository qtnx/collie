import { describe, expect, test } from "bun:test";

import type { OperatorFileIo } from "../operator-file.ts";
import {
  createLiveSettingsReader,
  LIVE_FILENAME,
  liveSettingsPath,
} from "./config.ts";

function collectWarnings() {
  const lines: string[] = [];
  return { warn: (message: string) => lines.push(message), lines };
}

function fakeIo() {
  const io: OperatorFileIo & { text: string | null; mtime_: number; reads: number } = {
    text: null,
    mtime_: 1,
    reads: 0,
    async mtime() {
      return io.text === null ? null : io.mtime_;
    },
    async read() {
      io.reads += 1;
      if (io.text === null) throw new Error("ENOENT");
      return io.text;
    },
  };
  return io;
}

describe("live settings path", () => {
  test("places live.json under the state directory", () => {
    expect(liveSettingsPath("/var/state")).toBe(`/var/state/${LIVE_FILENAME}`);
  });
});

describe("live settings reader", () => {
  test("returns null when no file exists without warning", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    expect(await read()).toBeNull();
    expect(lines).toEqual([]);
    expect(io.reads).toBe(0);
  });

  test("parses valid settings with defaults", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    io.text = JSON.stringify({ voice: "ember" });
    const settings = await read();
    expect(settings).toEqual({ voice: "ember", codexBin: "codex" });
    expect(lines).toEqual([]);
    expect(io.reads).toBe(1);
  });

  test("uses default voice when none specified", async () => {
    const io = fakeIo();
    const { warn } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    io.text = JSON.stringify({ codexBin: "/usr/local/bin/codex" });
    expect(await read()).toEqual({ voice: "sol", codexBin: "/usr/local/bin/codex" });
  });

  test("rejects unknown voice and warns", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    io.text = JSON.stringify({ voice: "robot" });
    expect(await read()).toBeNull();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("unknown voice");
  });

  test("caches by mtime and updates when mtime changes", async () => {
    const io = fakeIo();
    const { warn } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    io.text = JSON.stringify({ voice: "sol" });
    expect(await read()).toEqual({ voice: "sol", codexBin: "codex" });
    expect(io.reads).toBe(1);

    // Same mtime: not re-read
    expect(await read()).toEqual({ voice: "sol", codexBin: "codex" });
    expect(io.reads).toBe(1);

    // Bump mtime: re-reads
    io.mtime_ = 2;
    io.text = JSON.stringify({ voice: "maple" });
    expect(await read()).toEqual({ voice: "maple", codexBin: "codex" });
    expect(io.reads).toBe(2);
  });

  test("preserves last good settings on corrupt file", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    io.text = JSON.stringify({ voice: "cove" });
    expect(await read()).toEqual({ voice: "cove", codexBin: "codex" });

    // File corrupted
    io.mtime_ = 2;
    io.text = "invalid json {";
    expect(await read()).toEqual({ voice: "cove", codexBin: "codex" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("could not be parsed");
  });

  test("parses valid agent settings", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    io.text = JSON.stringify({
      voice: "ember",
      codexBin: "codex",
      agent: { kind: "ompx", bin: "/usr/bin/ompx", model: "custom/model" },
    });
    const settings = await read();
    expect(settings).toEqual({
      voice: "ember",
      codexBin: "codex",
      agent: { kind: "ompx", bin: "/usr/bin/ompx", model: "custom/model" },
    });
    expect(lines).toEqual([]);
  });

  test("defaults agent model when not specified", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    io.text = JSON.stringify({
      voice: "ember",
      agent: { kind: "ompx", bin: "/usr/bin/ompx" },
    });
    const settings = await read();
    expect(settings?.agent).toEqual({
      kind: "ompx",
      bin: "/usr/bin/ompx",
      model: "openai-codex/gpt-5.6-luna",
    });
    expect(lines).toEqual([]);
  });

  test("rejects invalid agent kind and warns", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    io.text = JSON.stringify({
      agent: { kind: "other", bin: "/usr/bin/ompx" },
    });
    expect(await read()).toBeNull();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("unknown agent kind");
  });

  test("rejects empty agent bin and warns", async () => {
    const io = fakeIo();
    const { warn, lines } = collectWarnings();
    const read = createLiveSettingsReader({ stateDir: "/state", io, warn });

    io.text = JSON.stringify({
      agent: { kind: "ompx", bin: "   " },
    });
    expect(await read()).toBeNull();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("agent bin must be non-empty");
  });
});
