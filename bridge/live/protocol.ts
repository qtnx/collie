import type { JsonValue } from "../json.ts";
import { jsonRecord, jsonStringField } from "../stt/json.ts";

/** Frameless Bidi model used by Codex Desktop live calls. */
export const LIVE_MODEL = "gpt-live-1-codex" as const;

/** Maximum UTF-8 payload size accepted by each context append. */
export const CONTEXT_CHUNK_BYTES = 500;

/** Voices accepted by Codex-backed realtime sessions. */
export const LIVE_VOICES = [
  "arbor",
  "breeze",
  "cove",
  "ember",
  "juniper",
  "maple",
  "sol",
  "spruce",
  "vale",
] as const;
export type LiveVoice = (typeof LIVE_VOICES)[number];
export const DEFAULT_LIVE_VOICE: LiveVoice = "sol";

export type LiveContextChannel = "speakable" | "commentary";
export type LiveInputTextContent = { type: "input_text"; text: string };

export type LiveSessionPayload = {
  model: typeof LIVE_MODEL;
  instructions: string;
  audio: { output: { voice: string } };
  delegation: { type: "client" };
};

export type LiveClientMessage =
  | {
      type: "delegation.context.append";
      delegation_item_id: string;
      channel?: LiveContextChannel;
      content: LiveInputTextContent[];
    }
  | { type: "session.context.append"; channel?: LiveContextChannel; content: LiveInputTextContent[] }
  | { type: "session.close" };

export type LiveServerEvent =
  | { type: "session.started" | "session.updated"; session: { id: string; instructions?: string } }
  | { type: "output_audio.delta"; audio: string }
  | { type: "input_transcript.added" | "output_transcript.added"; item: { text: string } }
  | { type: "turn.done"; turn: { role: "user" | "assistant"; transcript: string } }
  | {
      type: "delegation.created";
      item: { type: "delegation"; target: "client"; id: string; content: LiveInputTextContent[] };
    }
  | { type: "error"; message: string }
  | { type: "unknown"; wireType: string };

function parsePayload(payload: JsonValue): JsonValue | null {
  if (typeof payload !== "string") return payload;
  try {
    // SAFETY: JSON.parse produces a JSON-compatible value for text that parsed successfully.
    return JSON.parse(payload) as JsonValue;
  } catch {
    return null;
  }
}

function parseSessionEvent(
  type: "session.started" | "session.updated",
  payload: JsonValue,
): LiveServerEvent | null {
  const session = jsonRecord(payload)?.session;
  const record = jsonRecord(session);
  const id = jsonStringField(record?.id);
  if (id === null) return null;
  const instructions = jsonStringField(record?.instructions);
  return instructions === null ? { type, session: { id } } : { type, session: { id, instructions } };
}

function parseTranscriptAddedEvent(
  type: "input_transcript.added" | "output_transcript.added",
  payload: JsonValue,
): LiveServerEvent | null {
  const text = jsonStringField(jsonRecord(jsonRecord(payload)?.item)?.text);
  return text === null ? null : { type, item: { text } };
}

function parseTurnDoneEvent(payload: JsonValue): LiveServerEvent | null {
  const turn = jsonRecord(jsonRecord(payload)?.turn);
  const role = jsonStringField(turn?.role);
  const transcript = jsonStringField(turn?.transcript);
  if ((role !== "user" && role !== "assistant") || transcript === null) return null;
  return { type: "turn.done", turn: { role, transcript } };
}

function parseDelegationCreatedEvent(payload: JsonValue): LiveServerEvent | null {
  const item = jsonRecord(jsonRecord(payload)?.item);
  const id = jsonStringField(item?.id);
  if (item?.type !== "delegation" || item.target !== "client" || id === null || !Array.isArray(item.content)) {
    return null;
  }
  const content: LiveInputTextContent[] = [];
  for (const candidate of item.content) {
    const record = jsonRecord(candidate);
    const text = jsonStringField(record?.text);
    if (record?.type === "input_text" && text !== null) content.push({ type: "input_text", text });
  }
  return { type: "delegation.created", item: { type: "delegation", target: "client", id, content } };
}

function stringifyErrorValue(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value;
  if (value === undefined) return null;
  return JSON.stringify(value) ?? null;
}

function parseErrorEvent(payload: JsonValue): LiveServerEvent | null {
  const record = jsonRecord(payload);
  const message = jsonStringField(record?.message) ?? jsonStringField(jsonRecord(record?.error)?.message) ?? stringifyErrorValue(record?.error);
  return message === null ? null : { type: "error", message };
}

/** Parse a JSON string or decoded value from the Frameless Bidi data channel. */
export function parseLiveServerEvent(payload: JsonValue): LiveServerEvent | null {
  const parsed = parsePayload(payload);
  const record = jsonRecord(parsed);
  const type = jsonStringField(record?.type);
  if (type === null) return null;
  switch (type) {
    case "session.started":
    case "session.updated":
      return parseSessionEvent(type, parsed);
    case "output_audio.delta": {
      const audio = jsonStringField(record?.audio);
      return audio === null ? null : { type, audio };
    }
    case "input_transcript.added":
    case "output_transcript.added":
      return parseTranscriptAddedEvent(type, parsed);
    case "turn.done":
      return parseTurnDoneEvent(parsed);
    case "delegation.created":
      return parseDelegationCreatedEvent(parsed);
    case "error":
      return parseErrorEvent(parsed);
    default:
      return { type: "unknown", wireType: type };
  }
}

export function buildLiveSessionPayload(instructions: string, voice: string): LiveSessionPayload {
  return { model: LIVE_MODEL, instructions, audio: { output: { voice } }, delegation: { type: "client" } };
}

export function buildDelegationContextAppend(
  delegationItemId: string,
  text: string,
  channel?: LiveContextChannel,
): LiveClientMessage {
  const message: Extract<LiveClientMessage, { type: "delegation.context.append" }> = {
    type: "delegation.context.append",
    delegation_item_id: delegationItemId,
    content: [{ type: "input_text", text }],
  };
  if (channel !== undefined) message.channel = channel;
  return message;
}

export function buildSessionClose(): LiveClientMessage {
  return { type: "session.close" };
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** Split context into character-safe chunks of at most 500 UTF-8 bytes. */
export function chunkLiveContext(text: string): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    const characterBytes = utf8ByteLength(codePoint);
    if (chunkBytes + characterBytes > CONTEXT_CHUNK_BYTES) {
      chunks.push(text.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += characterBytes;
    index += characterLength;
  }
  chunks.push(text.slice(chunkStart));
  return chunks;
}
