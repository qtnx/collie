import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { diskIo, type OperatorFileIo } from "../operator-file.ts";
import { jsonRecord, jsonStringField } from "../stt/json.ts";
import { DEFAULT_LIVE_VOICE, LIVE_VOICES } from "./protocol.ts";
import type { OperatorAgentSettings } from "./operator-agent.ts";

export type { OperatorAgentSettings };
// ── WHERE THE REALTIME LIVE CALL SETTINGS COME FROM ──────────────────────────
//
// Stored in `<stateDir>/live.json` as a small JSON document (`{"voice": "sol", "codexBin": "codex"}`).
// The file lives in the STATE directory alongside `stt.json` and pairing secrets, written by
// `collie live on` and removed by `collie live off`.
//
// It is re-read per request behind an mtime check through `OperatorFileIo` (the same pattern
// `commands.toml` and `stt.json` follow), so `collie live on` goes live immediately with no restart.
// An absent file means the feature is off (returns null). A malformed file warns once and preserves
// the last-known good settings so a corrupt transient write does not tear down a running bridge.

/** The file under the state directory holding live call settings. */
export const LIVE_FILENAME = "live.json";

/** Default model for the live operator agent. */
export const DEFAULT_OPERATOR_MODEL = "openai-codex/gpt-5.6-luna";



/** Resolved settings for realtime live calls. */
export interface LiveSettings {
  /** Text-to-speech voice name validated against `LIVE_VOICES`. */
  voice: string;
  /** Path or binary name for `codex` command. */
  codexBin: string;
  /** Present when live calls delegate through an operator agent. */
  agent?: OperatorAgentSettings;
}

/** The path `live.json` sits at given the bridge's state dir. */
export function liveSettingsPath(stateDir: string): string {
  return join(stateDir, LIVE_FILENAME);
}

/**
 * A reader for `<stateDir>/live.json` cached behind an mtime check.
 *
 * Missing file returns null (live calls off). An invalid voice warns and turns the feature off.
 */
export function createLiveSettingsReader(opts: {
  stateDir: string;
  warn: (message: string) => void;
  io?: OperatorFileIo;
}): () => Promise<LiveSettings | null> {
  const path = liveSettingsPath(opts.stateDir);
  const io = opts.io ?? diskIo;
  let seen: number | null | undefined;
  let lastGood: LiveSettings | null = null;

  return async (): Promise<LiveSettings | null> => {
    const mtime = await io.mtime(path);
    if (mtime !== seen) {
      seen = mtime;
      if (mtime === null) {
        lastGood = null;
      } else {
        try {
          // SAFETY: JSON.parse returns a JsonValue; jsonRecord checks that it is an object.
          const raw = JSON.parse(await io.read(path)) as JsonValue;
          const o = jsonRecord(raw);
          if (o === null) {
            opts.warn(`${path} is not a JSON object`);
            lastGood = null;
          } else {
            const voiceRaw = jsonStringField(o.voice)?.trim();
            const voice = voiceRaw || DEFAULT_LIVE_VOICE;
            if (!LIVE_VOICES.some((known) => known === voice)) {
              opts.warn(
                `live is off: unknown voice "${voice}" (expected ${LIVE_VOICES.join(", ")})`,
              );
              lastGood = null;
            } else {
              const codexBin = jsonStringField(o.codexBin)?.trim() || "codex";
              let agent: OperatorAgentSettings | undefined;
              let agentValid = true;
              if (o.agent !== undefined) {
                const agentObj = jsonRecord(o.agent);
                if (agentObj === null) {
                  opts.warn(`${path}: agent must be an object`);
                  agentValid = false;
                } else {
                  const kind = jsonStringField(agentObj.kind)?.trim();
                  const bin = jsonStringField(agentObj.bin)?.trim();
                  const modelRaw = jsonStringField(agentObj.model)?.trim();
                  const model = modelRaw || DEFAULT_OPERATOR_MODEL;
                  if (kind !== "ompx") {
                    opts.warn(`${path}: unknown agent kind "${String(kind)}" (expected "ompx")`);
                    agentValid = false;
                  } else if (!bin) {
                    opts.warn(`${path}: agent bin must be non-empty`);
                    agentValid = false;
                  } else {
                    agent = { kind: "ompx", bin, model };
                  }
                }
              }
              if (!agentValid) {
                lastGood = null;
              } else {
                const settings: LiveSettings = { voice, codexBin };
                if (agent !== undefined) {
                  settings.agent = agent;
                }
                lastGood = settings;
              }
            }
          }
        } catch (err) {
          opts.warn(`${path} could not be parsed (${String(err)}) — keeping the last good settings`);
        }
      }
    }
    return lastGood;
  };
}
