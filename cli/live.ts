import { DEFAULT_LIVE_VOICE, LIVE_VOICES } from "../bridge/live/protocol.ts";
import {
  DEFAULT_OPERATOR_MODEL,
  type LiveSettings,
  liveSettingsPath,
  type OperatorAgentSettings,
} from "../bridge/live/config.ts";
import type { JsonValue } from "../bridge/json.ts";
import { jsonRecord, jsonStringField } from "../bridge/stt/json.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec, Files } from "./sys.ts";

// ── THE CLI FOR REALTIME LIVE CALLS ──────────────────────────────────────────
//
// `collie live on | off | status`
//
// Realtime voice calls to an agent in a pane borrow Codex Desktop's identity and
// connect phone WebRTC audio directly to OpenAI's private realtime endpoint.
//
// Like `collie stt setup` for the Codex fallback, enabling this surface is a deliberate
// CLI act on the operator's terminal with an explicit consent step (or `--yes` for scripts).
// The command writes `<stateDir>/live.json` at mode 0600, which the bridge re-reads
// per request behind an mtime check with no restart required.

export const LIVE_SUBCOMMANDS = ["on", "off", "status"] as const;
export type LiveSubcommand = (typeof LIVE_SUBCOMMANDS)[number];

export interface LiveDeps {
  ctx: CliContext;
  io: Io;
  files: Files;
  exec: Exec;
  interactive: boolean;
  prompt(question: string): string | null | Promise<string | null>;
}

export const LIVE_CONSENT_TEXT = [
  "The live call uses a private ChatGPT endpoint wearing Codex Desktop's identity with",
  "the operator's own ChatGPT login; rate-limit/ban exposure is theirs; microphone audio",
  "goes browser→OpenAI directly, never through this host; may break without notice.",
] as const;

export async function cmdLiveOn(
  deps: LiveDeps,
  args: readonly string[],
): Promise<number> {
  let voice: string = DEFAULT_LIVE_VOICE;
  let codexBin = "codex";
  let agentKind: string | null = null;
  let model: string = DEFAULT_OPERATOR_MODEL;
  let hasModel = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--voice") {
      i++;
      if (i >= args.length) {
        deps.io.err("error: --voice requires a voice name");
        return EXIT.USAGE;
      }
      voice = args[i]!;
    } else if (arg.startsWith("--voice=")) {
      voice = arg.slice("--voice=".length);
    } else if (arg === "--codex-bin") {
      i++;
      if (i >= args.length) {
        deps.io.err("error: --codex-bin requires an executable name or path");
        return EXIT.USAGE;
      }
      codexBin = args[i]!;
    } else if (arg.startsWith("--codex-bin=")) {
      codexBin = arg.slice("--codex-bin=".length);
    } else if (arg === "--agent") {
      i++;
      if (i >= args.length) {
        deps.io.err("error: --agent requires an agent kind (ompx)");
        return EXIT.USAGE;
      }
      agentKind = args[i]!;
    } else if (arg.startsWith("--agent=")) {
      agentKind = arg.slice("--agent=".length);
    } else if (arg === "--model") {
      i++;
      if (i >= args.length) {
        deps.io.err("error: --model requires a model name");
        return EXIT.USAGE;
      }
      model = args[i]!;
      hasModel = true;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      hasModel = true;
    } else {
      deps.io.err(`error: unknown option \`${arg}\``);
      return EXIT.USAGE;
    }
  }

  if (hasModel && agentKind === null) {
    deps.io.err("error: --model requires --agent ompx");
    return EXIT.USAGE;
  }

  if (agentKind !== null && agentKind !== "ompx") {
    deps.io.err(`error: unknown agent "${agentKind}" (expected ompx)`);
    return EXIT.USAGE;
  }

  if (!LIVE_VOICES.some((v) => v === voice)) {
    deps.io.err(
      `error: unknown voice "${voice}" (expected ${LIVE_VOICES.join(", ")})`,
    );
    return EXIT.USAGE;
  }

  const which = deps.exec.which(codexBin);
  if (which === null) {
    deps.io.err(`error: no \`${codexBin}\` binary was found on PATH.`);
    deps.io.err(
      "       The live call borrows that binary's sign-in; install it, or sign in with `codex login`.",
    );
    return EXIT.FAIL;
  }

  let agentConfig: OperatorAgentSettings | undefined;
  if (agentKind === "ompx") {
    const ompxWhich = deps.exec.which("ompx");
    if (ompxWhich === null) {
      deps.io.err("error: no `ompx` binary was found on PATH.");
      deps.io.err(
        "       The operator agent runs inside ompx; install it, or make it available on PATH.",
      );
      return EXIT.FAIL;
    }
    agentConfig = { kind: "ompx", bin: ompxWhich, model };
  }
  for (const line of LIVE_CONSENT_TEXT) {
    deps.io.out(line);
  }

  if (!yes) {
    if (!deps.interactive) {
      deps.io.err(
        "error: live on requires consent — pass --yes in non-interactive environments",
      );
      return EXIT.USAGE;
    }
    const answer = await deps.prompt("Enable live call? [y/N]: ");
    if (
      answer === null ||
      (answer.trim().toLowerCase() !== "y" &&
        answer.trim().toLowerCase() !== "yes")
    ) {
      deps.io.err("live call not enabled.");
      return EXIT.FAIL;
    }
  }

  const path = liveSettingsPath(deps.ctx.stateDir);
  // The RESOLVED path, never the bare name: the bridge runs under systemd with a PATH that does not
  // include the operator's npm/bun bin dirs, so a bare `codex` in live.json spawns nothing there.
  // Same rule `collie stt setup` follows (cli/stt.ts locateCodex).
  const configData: LiveSettings = { voice, codexBin: which };
  if (agentConfig !== undefined) {
    configData.agent = agentConfig;
  }
  const payload = JSON.stringify(configData, null, 2) + "\n";
  try {
    deps.files.write(path, payload, 0o600);
  } catch (err) {
    deps.io.err(
      `error: could not write ${path} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT.FAIL;
  }

  const agentNotice = agentConfig !== undefined ? `, agent: ompx [${agentConfig.model}]` : "";
  deps.io.out(
    `✓ enabled live call (voice: ${voice}${agentNotice}) — written to ${path} (no restart needed).`,
  );
  return EXIT.OK;
}

export function cmdLiveOff(deps: LiveDeps): number {
  const path = liveSettingsPath(deps.ctx.stateDir);
  const existed = deps.files.exists(path);
  try {
    deps.files.remove(path);
  } catch (err) {
    deps.io.err(
      `error: could not remove ${path} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT.FAIL;
  }

  deps.io.out(
    existed
      ? `✓ removed ${path} — live call is off from the next request (no restart needed).`
      : `live call was already off — no ${path} to remove.`,
  );
  return EXIT.OK;
}

export function cmdLiveStatus(deps: LiveDeps): number {
  const path = liveSettingsPath(deps.ctx.stateDir);
  if (!deps.files.exists(path)) {
    deps.io.out(
      "live call: off — no live.json in state dir. Enable with `collie live on`.",
    );
    return EXIT.OK;
  }

  const content = deps.files.read(path);
  if (content === null) {
    deps.io.err(`error: could not read ${path}`);
    return EXIT.FAIL;
  }

  try {
    // SAFETY: live.json content parses into JsonValue; jsonRecord narrows it to an object.
    const raw = jsonRecord(JSON.parse(content) as JsonValue);
    const voice = jsonStringField(raw?.voice)?.trim() || DEFAULT_LIVE_VOICE;
    const codexBin = jsonStringField(raw?.codexBin)?.trim() || "codex";
    const found = deps.exec.which(codexBin);

    deps.io.out("live call: on");
    deps.io.out(`  file:      ${path}`);
    deps.io.out(`  voice:     ${voice}`);
    deps.io.out(
      `  codex-bin: ${codexBin}${found !== null ? ` (${found})` : " [NOT FOUND ON PATH]"}`,
    );
    const agentObj = jsonRecord(raw?.agent);
    if (agentObj !== null) {
      const agentKind = jsonStringField(agentObj.kind)?.trim() || "ompx";
      const agentBin = jsonStringField(agentObj.bin)?.trim() || "ompx";
      const agentModel = jsonStringField(agentObj.model)?.trim() || DEFAULT_OPERATOR_MODEL;
      const agentFound = deps.exec.which(agentBin);
      deps.io.out(
        `  agent:     ${agentKind} [${agentModel}] (${agentBin}${agentFound !== null ? "" : " [NOT FOUND ON PATH]"})`,
      );
    }
    return EXIT.OK;
  } catch (err) {
    deps.io.err(
      `error: could not parse ${path} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT.FAIL;
  }
}

export async function cmdLive(
  deps: LiveDeps,
  args: readonly string[],
): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "on":
      return await cmdLiveOn(deps, rest);
    case "off":
      return cmdLiveOff(deps);
    case "status":
      return cmdLiveStatus(deps);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`error: unknown live subcommand \`${sub}\``);
      }
      deps.io.err(`usage: collie live {${LIVE_SUBCOMMANDS.join("|")}}`);
      deps.io.err("  on      enable live call (--voice <name>, --yes)");
      deps.io.err("  off     disable live call (removes live.json)");
      deps.io.err(
        "  status  show live call configuration and codex binary status",
      );
      return EXIT.USAGE;
  }
}
