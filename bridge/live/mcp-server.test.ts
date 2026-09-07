import { describe, expect, test } from "bun:test";
import type { JsonObject, JsonValue } from "../json.ts";
import { jsonRecord } from "../stt/json.ts";
import { jsonStringField } from "../stt/json.ts";

import type { TranscriptEntry } from "../journal/types.ts";
import type { OperatorPanePort } from "./agent-pane.ts";
import { createLiveMcpServer, liveMcpToolNames } from "./mcp-server.ts";

function port(): OperatorPanePort {
  const entry: TranscriptEntry = { uuid: "1", ts: "", role: "assistant", parts: [{ kind: "text", text: "done" }] };
  return {
    meta: { paneId: "p1", agent: "claude", cwd: "/repo" },
    reply: async () => ({ ok: true }),
    status: () => "idle",
    history: async () => [entry],
    screen: async () => "screen\nline",
    sendKeys: async () => ({ ok: true }),
    listPanes: () => [{ paneId: "p1", agent: "claude", status: "idle", cwd: "/repo" }],
    waitIdle: async () => ({ status: "idle", settled: true }),
  };
}

async function request(socketPath: string, message: JsonObject): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(message)}\n`);
        },
        data(socket, chunk) {
          buffer += chunk.toString();
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          socket.end();
          try {
            // SAFETY: test client only decodes server JSON response.
            const response = jsonRecord(JSON.parse(buffer.slice(0, newline)) as JsonValue);
            if (response === null) reject(new Error("server response was not an object"));
            else resolve(response);
          } catch (error) {
            reject(error);
          }
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

describe("live MCP server", () => {
  test("serves handshake, tool list, calls, and method errors over unix socket", async () => {
    const socketPath = `/tmp/collie-live-${crypto.randomUUID()}.sock`;
    const server = createLiveMcpServer({ socketPath, port: port() });
    try {
      const initialized = await request(socketPath, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(initialized.result).toEqual({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "collie-live", version: "1.0.0" } });
      const listed = await request(socketPath, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const tools = jsonRecord(listed.result)?.tools;
      expect(Array.isArray(tools) ? tools.map((tool) => jsonStringField(jsonRecord(tool)?.name)) : []).toEqual(["read_screen", "type_text", "send_keys", "wait_until_idle", "read_history", "list_panes"]);
      const screen = await request(socketPath, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_screen", arguments: {} } });
      expect(screen.result).toEqual({ content: [{ type: "text", text: "pane p1 · agent claude · status idle · cwd /repo\n\nscreen\nline" }] });
      const badKey = await request(socketPath, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "send_keys", arguments: { keys: ["nope"] } } });
      const badKeyResult = jsonRecord(badKey.result);
      expect(badKeyResult?.isError).toBe(true);
      const content = badKeyResult?.content;
      expect(Array.isArray(content) ? jsonStringField(jsonRecord(content[0])?.text) : null).toContain("Invalid key");
      const unknown = await request(socketPath, { jsonrpc: "2.0", id: 5, method: "wat", params: {} });
      expect(unknown.error).toEqual({ code: -32601, message: "Method not found: wat" });
    } finally {
      server.close();
    }
  });

  test("builds exact allowlist names", () => {
    expect(liveMcpToolNames()).toEqual(["mcp__herdr_read_screen", "mcp__herdr_type_text", "mcp__herdr_send_keys", "mcp__herdr_wait_until_idle", "mcp__herdr_read_history", "mcp__herdr_list_panes"]);
  });
});
