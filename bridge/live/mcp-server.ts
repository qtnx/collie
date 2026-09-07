import { unlinkSync } from "node:fs";

import type { JsonObject, JsonValue } from "../json.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "../stt/json.ts";
import { isMuxKey } from "../mux/keys.ts";
import type { TranscriptPart } from "../journal/types.ts";
import type { OperatorPanePort } from "./agent-pane.ts";

export const LIVE_MCP_SERVER_NAME = "herdr";
export const LIVE_MCP_TOOLS = ["read_screen", "type_text", "send_keys", "wait_until_idle", "read_history", "list_panes"] as const;

export function liveMcpToolNames(): string[] {
  return LIVE_MCP_TOOLS.map((name) => `mcp__${LIVE_MCP_SERVER_NAME}_${name}`);
}

export interface LiveMcpServer {
  readonly socketPath: string;
  close(): void;
}

type Socket = { data: { buffer: string }; write(data: string): void; end(): void };
type Listen = typeof Bun.listen;
type Request = { id?: JsonValue; method: string; params?: JsonValue };

const toolDefinitions: JsonObject[] = [
  { name: "read_screen", description: "Read the current pane screen.", inputSchema: { type: "object", properties: {} } },
  {
    name: "type_text",
    description: "Type and submit a complete message in the pane.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, submit: { type: "boolean" } }, required: ["text"] },
  },
  {
    name: "send_keys",
    description: "Send validated terminal keys to the pane.",
    inputSchema: { type: "object", properties: { keys: { type: "array", items: { type: "string" }, maxItems: 16 } }, required: ["keys"] },
  },
  {
    name: "wait_until_idle",
    description: "Wait until pane is idle and its screen has settled.",
    inputSchema: { type: "object", properties: { timeoutSec: { type: "number", maximum: 180 } } },
  },
  {
    name: "read_history",
    description: "Read recent pane history.",
    inputSchema: { type: "object", properties: { limit: { type: "number", maximum: 30 } } },
  },
  { name: "list_panes", description: "List Collie's panes.", inputSchema: { type: "object", properties: {} } },
];

function removeSocket(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // No stale socket is normal.
  }
}

function parseRequest(line: string): Request | null {
  try {
    // SAFETY: JSON.parse produces a JSON-compatible value for text that parsed successfully.
    const parsed = jsonRecord(JSON.parse(line) as JsonValue);
    const method = jsonStringField(parsed?.method);
    return method === null ? null : { id: parsed?.id, method, params: parsed?.params };
  } catch {
    return null;
  }
}

function textResult(text: string, isError = false): JsonObject {
  const result: JsonObject = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}


function paramsObject(params: JsonValue | undefined): JsonObject | null {
  if (params === undefined) return {};
  return jsonRecord(params);
}

function screenText(port: OperatorPanePort): Promise<string> {
  return port.screen().then((screen) => screen?.split("\n").slice(-80).join("\n") ?? "screen unavailable");
}

function paneHeader(port: OperatorPanePort): string {
  const status = port.status() ?? "unknown";
  return `pane ${port.meta.paneId} · agent ${port.meta.agent} · status ${status} · cwd ${port.meta.cwd}`;
}

function partText(part: TranscriptPart): string {
  if (part.kind === "text" || part.kind === "thinking") return part.text;
  return `tool ${part.name}: ${part.summary}`;
}

async function callTool(port: OperatorPanePort, name: string, params: JsonObject): Promise<JsonObject> {
  switch (name) {
    case "read_screen":
      if (Object.keys(params).length !== 0) throw new Error("read_screen takes no parameters");
      return textResult(`${paneHeader(port)}\n\n${await screenText(port)}`);
    case "type_text": {
      const text = jsonStringField(params.text);
      const submit = params.submit;
      if (text === null || (submit !== undefined && submit !== true && submit !== false)) throw new Error("text must be a string");
      const result = await port.reply(text);
      return result.ok ? textResult("Message sent.") : textResult(result.reason, true);
    }
    case "send_keys": {
      const rawKeys = params.keys;
      if (!Array.isArray(rawKeys) || rawKeys.length > 16) return textResult("Invalid key; use Collie's neutral key names and at most 16 keys.", true);
      const keys: string[] = [];
      for (const rawKey of rawKeys) {
        const key = jsonStringField(rawKey);
        if (key === null || !isMuxKey(key)) return textResult("Invalid key; use Collie's neutral key names and at most 16 keys.", true);
        keys.push(key);
      }
      const result = await port.sendKeys(keys);
      return result.ok ? textResult("Keys sent.") : textResult(result.reason, true);
    }
    case "wait_until_idle": {
      const raw = params.timeoutSec;
      const seconds = raw === undefined ? 60 : jsonNumberField(raw);
      if (seconds === null || seconds < 0 || seconds > 180) throw new Error("timeoutSec must be between 0 and 180");
      const result = await port.waitIdle(seconds * 1_000);
      return textResult(`${paneHeader(port)}\n\n${await screenText(port)}\n\nsettled: ${String(result.settled)}`);
    }
    case "read_history": {
      const raw = params.limit;
      const limit = raw === undefined ? 10 : jsonNumberField(raw);
      if (limit === null || !Number.isInteger(limit) || limit < 0 || limit > 30) throw new Error("limit must be an integer between 0 and 30");
      const entries = await port.history();
      if (entries === null) return textResult("history unavailable");
      return textResult(entries.slice(-limit).map((entry) => `${entry.role}: ${entry.parts.map(partText).join(" ")}`).join("\n"));
    }
    case "list_panes": {
      if (Object.keys(params).length !== 0) throw new Error("list_panes takes no parameters");
      return textResult(port.listPanes().map((pane) => `pane ${pane.paneId} · agent ${pane.agent} · status ${pane.status} · cwd ${pane.cwd}${pane.label === undefined ? "" : ` · label ${pane.label}`}`).join("\n"));
    }
    default:
      throw new Error("unknown tool");
  }
}

export function createLiveMcpServer(opts: {
  socketPath: string;
  port: OperatorPanePort;
  listen?: Listen;
  onToolCall?: (name: string, args: JsonValue) => void;
}): LiveMcpServer {
  removeSocket(opts.socketPath);
  const listen = opts.listen ?? Bun.listen;
  const server = listen<{ buffer: string }>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: "" };
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        let newline = socket.data.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = socket.data.buffer.slice(0, newline);
          socket.data.buffer = socket.data.buffer.slice(newline + 1);
          handleLine(socket, line);
          newline = socket.data.buffer.indexOf("\n");
        }
      },
    },
  });

  function handleLine(socket: Socket, line: string): void {
    const request = parseRequest(line);
    if (request === null) {
      socket.end();
      return;
    }
    if (request.id === undefined && request.method === "notifications/initialized") return;
    if (request.id === undefined) return;
    void (async () => {
      let response: JsonObject;
      if (request.method === "initialize") {
        response = { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "collie-live", version: "1.0.0" } } };
      } else if (request.method === "ping") {
        response = { jsonrpc: "2.0", id: request.id, result: {} };
      } else if (request.method === "tools/list") {
        response = { jsonrpc: "2.0", id: request.id, result: { tools: toolDefinitions } };
      } else if (request.method === "tools/call") {
        const params = paramsObject(request.params);
        const name = jsonStringField(params?.name);
        const args = jsonRecord(params?.arguments ?? {});
        if (name === null || args === null) {
          response = { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "invalid tools/call parameters" } };
        } else {
          opts.onToolCall?.(name, args);
          try {
            response = { jsonrpc: "2.0", id: request.id, result: await callTool(opts.port, name, args) };
          } catch (error) {
            response = { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: error instanceof Error ? error.message : "invalid tool parameters" } };
          }
        }
      } else {
        response = { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
      }
      socket.write(`${JSON.stringify(response)}\n`);
    })();
  }

  return {
    socketPath: opts.socketPath,
    close() {
      server.stop(true);
      removeSocket(opts.socketPath);
    },
  };
}
