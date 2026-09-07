import { describe, expect, test } from "bun:test";
import { createOmpTokenBroker, OMP_UNPROBED, type OmpTokenRun } from "./omp-auth.ts";

// The broker over `ompx token openai-codex`: what it runs, what it reads off stdout, and what it
// remembers. The run is faked; no `ompx` is looked for.

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig";

function fakeRun(answers: OmpTokenRun[]) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (argv: readonly string[]): Promise<OmpTokenRun> => {
      calls.push([...argv]);
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      return next;
    },
  };
}

describe("createOmpTokenBroker", () => {
  test("starts unprobed, then reads the last stdout line as the token", async () => {
    const { run, calls } = fakeRun([{ stdout: `Working...\n${JWT}\n`, stderr: "", exitCode: 0 }]);
    const broker = createOmpTokenBroker({ ompxBin: "/opt/ompx", run });
    expect(broker.lastKnown()).toEqual(OMP_UNPROBED);
    expect(await broker.accessToken()).toEqual({ accessToken: JWT });
    expect(calls).toEqual([["/opt/ompx", "token", "openai-codex", "--raw"]]);
    expect(broker.lastKnown()).toEqual({ available: true });
  });

  test("a refresh asks ompx to force one", async () => {
    const { run, calls } = fakeRun([{ stdout: `${JWT}\n`, stderr: "", exitCode: 0 }]);
    const broker = createOmpTokenBroker({ ompxBin: "ompx", run });
    await broker.accessToken(true);
    expect(calls[0]).toContain("--force-refresh");
  });

  test("a non-zero exit is remembered as not signed in, with ompx's last stderr line", async () => {
    const { run } = fakeRun([{ stdout: "", stderr: "boom\nNo credential for openai-codex\n", exitCode: 1 }]);
    const broker = createOmpTokenBroker({ ompxBin: "ompx", run });
    await expect(broker.accessToken()).rejects.toThrow(/not signed in to openai-codex — No credential/);
    expect(broker.lastKnown().available).toBe(false);
    expect(broker.lastKnown().reason).toContain("ompx auth-broker login openai-codex");
  });

  test("a stdout that is prose, not a token, is refused", async () => {
    const { run } = fakeRun([{ stdout: "Please log in first\n", stderr: "", exitCode: 0 }]);
    const broker = createOmpTokenBroker({ ompxBin: "ompx", run });
    await expect(broker.accessToken()).rejects.toThrow(/not signed in/);
  });

  test("probe records the answer and never throws", async () => {
    const { run } = fakeRun([{ stdout: "", stderr: "", exitCode: 2 }]);
    const broker = createOmpTokenBroker({ ompxBin: "ompx", run });
    expect((await broker.probe()).available).toBe(false);
  });

  test("concurrent callers share one run", async () => {
    const { run, calls } = fakeRun([{ stdout: `${JWT}\n`, stderr: "", exitCode: 0 }]);
    const broker = createOmpTokenBroker({ ompxBin: "ompx", run });
    const [a, b] = await Promise.all([broker.accessToken(), broker.accessToken()]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });
});
