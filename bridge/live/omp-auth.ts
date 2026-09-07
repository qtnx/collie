import { spawn as spawnChild } from "node:child_process";
import { SttError, type SttStatus } from "../stt/provider.ts";
import type { CodexAccessToken, CodexAuthBroker } from "../stt/codex-auth.ts";

// ── BORROWING THE OPERATOR'S OWN OMP LOGIN ────────────────────────────────────────────────────
//
// The same posture as codex-auth.ts, against a different binary: `ompx token openai-codex` prints
// one short-lived ChatGPT access token on stdout, refreshing it through omp's own credential store
// (or its auth-broker, when the operator configured one) on the way. Collie never opens
// `~/.omp/agent/agent.db` and never learns a refresh token — it asks the tool the operator already
// trusts, once per call, and holds the answer in memory for the length of that call.
//
// Why a second broker at all: the Codex CLI and omp keep SEPARATE logins, and either can be the one
// that is signed in on a given host. The live call takes whichever the operator named at
// `collie live on`; an operator who already runs the operator agent through ompx has that binary
// resolved anyway, so it is the default there.
//
// Same seam as the codex broker — `CodexAuthBroker` — so signaling and the session never learn
// which binary answered. `spawn` is injectable so the tests never look for a real `ompx`.

/** One `ompx token` run, reduced to what this module reads of it. */
export interface OmpTokenRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface OmpTokenBrokerOptions {
  /** The `ompx` binary — a resolved path, because the service's PATH is not the operator's. */
  ompxBin: string;
  /** The run itself, injected by the tests. */
  run?: (argv: readonly string[]) => Promise<OmpTokenRun>;
  /** How long one `ompx token` may take; a refresh dials the identity provider. */
  timeoutMs?: number;
}

const OMP_PROVIDER = "openai-codex";
export const OMP_TOKEN_TIMEOUT_MS = 30_000;

/** The state before anything has been asked of ompx. */
export const OMP_UNPROBED: SttStatus = {
  available: false,
  reason: "the omp sign-in has not been checked yet — run `collie live status`",
};

export function createOmpTokenBroker(options: OmpTokenBrokerOptions): CodexAuthBroker {
  const run = options.run ?? ((argv) => runOmpx(argv, options.timeoutMs ?? OMP_TOKEN_TIMEOUT_MS));
  let known: SttStatus = OMP_UNPROBED;
  let inflight: Promise<CodexAccessToken> | null = null;

  const remember = (reason: string): SttError => {
    known = { available: false, reason };
    return new SttError("unavailable", reason);
  };

  const fetchToken = async (refresh: boolean): Promise<CodexAccessToken> => {
    const argv = [options.ompxBin, "token", OMP_PROVIDER, "--raw"];
    if (refresh) argv.push("--force-refresh");
    let result: OmpTokenRun;
    try {
      result = await run(argv);
    } catch (err) {
      throw remember(`\`ompx token\` could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The LAST non-empty line: ompx may print progress above the credential. A JWT has no spaces.
    const token = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0);
    if (result.exitCode !== 0 || token === undefined || token.includes(" ")) {
      const detail = result.stderr.trim().split("\n").at(-1) ?? "";
      throw remember(
        `omp is not signed in to ${OMP_PROVIDER}${detail ? ` — ${detail}` : ""}; run \`ompx auth-broker login ${OMP_PROVIDER}\` or \`ompx\` and log in`,
      );
    }
    known = { available: true };
    return { accessToken: token };
  };

  return {
    lastKnown: () => known,
    async accessToken(refresh = false) {
      // One run at a time: two callers hitting a 401 together must not race two refreshes.
      if (inflight !== null) return inflight;
      const started = fetchToken(refresh).finally(() => {
        if (inflight === started) inflight = null;
      });
      inflight = started;
      return started;
    },
    async probe() {
      try {
        await fetchToken(false);
      } catch {
        // `fetchToken` already recorded the reason.
      }
      return known;
    },
    close() {
      // Nothing is held open: every token is one short-lived subprocess.
    },
  };
}

/** The real spawn — the only place this module touches `node:child_process`. */
function runOmpx(argv: readonly string[], timeoutMs: number): Promise<OmpTokenRun> {
  const { promise, resolve, reject } = Promise.withResolvers<OmpTokenRun>();
  const [bin, ...args] = argv;
  if (bin === undefined) {
    reject(new Error("no binary"));
    return promise;
  }
  const child = spawnChild(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  timer.unref();
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.on("close", (exitCode) => {
    clearTimeout(timer);
    resolve({ stdout, stderr, exitCode });
  });
  return promise;
}
