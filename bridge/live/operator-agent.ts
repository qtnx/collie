import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { JsonObject, JsonValue } from "../json.ts";
import { jsonRecord, jsonStringField } from "../stt/json.ts";
import { chunkLiveContext } from "./protocol.ts";
import { type LiveAgentEndpoint, type OperatorPanePort } from "./agent-pane.ts";
import { LIVE_MCP_SERVER_NAME, liveMcpToolNames, type LiveMcpServer } from "./mcp-server.ts";
import { renderOperatorInstructions } from "./operator-instructions.ts";

export interface OperatorAgentSettings {
  kind: "ompx";
  bin: string;
  model: string;
}

export interface OperatorChild {
  stdin: { write(chunk: string): boolean; end(): void };
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export interface OperatorClock {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout> | null): void;
}

export interface OperatorAgentDeps {
  settings: OperatorAgentSettings;
  port: OperatorPanePort;
  workDir: string;
  pumpCommand: readonly string[];
  mcp: LiveMcpServer;
  language: string;
  spawn?: (argv: readonly string[], opts: { cwd: string; env: Record<string, string> }) => OperatorChild;
  files?: { write(path: string, text: string, mode: number): void };
  now?: () => number;
  maxMs?: number;
  clock?: OperatorClock;
}

interface PendingText {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

function childFromProcess(process: ChildProcessWithoutNullStreams): OperatorChild {
  return {
    stdin: {
      write: (chunk) => process.stdin.write(chunk),
      end: () => process.stdin.end(),
    },
    onStdout: (listener) => process.stdout.on("data", listener),
    onStderr: (listener) => process.stderr.on("data", listener),
    onExit: (listener) => process.once("exit", listener),
    kill: () => process.kill(),
  };
}

function writeMcpConfig(deps: OperatorAgentDeps): void {
  const config = {
    mcpServers: {
      [LIVE_MCP_SERVER_NAME]: {
        type: "stdio",
        command: deps.pumpCommand[0],
        args: deps.pumpCommand.slice(1),
        env: { COLLIE_LIVE_MCP_SOCKET: deps.mcp.socketPath },
      },
    },
  };
  const text = JSON.stringify(config);
  if (deps.files) deps.files.write(`${deps.workDir}/mcp.json`, text, 0o600);
  else writeFileSync(`${deps.workDir}/mcp.json`, text, { mode: 0o600 });
}

function textBlocks(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    const record = jsonRecord(block);
    const text = jsonStringField(record?.text);
    return record?.type === "text" && text !== null ? [text] : [];
  });
}

function assistantText(messages: JsonValue | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = jsonRecord(messages[index]);
    if (jsonStringField(message?.role) !== "assistant") continue;
    const text = textBlocks(message?.content).join("").trim();
    if (text) return text;
  }
  return "";
}

function eventText(event: JsonObject): string {
  const message = jsonRecord(event.message);
  return textBlocks(message?.content).join("").trim();
}

function eventStopReason(event: JsonObject): string | null {
  return jsonStringField(event.stopReason) ?? jsonStringField(jsonRecord(event.message)?.stopReason);
}

function toolName(event: JsonObject): string {
  const direct = jsonStringField(event.toolName) ?? jsonStringField(event.name);
  const tool = jsonRecord(event.tool);
  return direct ?? jsonStringField(tool?.name) ?? "unknown";
}

export function createOperatorAgentEndpoint(deps: OperatorAgentDeps): LiveAgentEndpoint {
  const spawn = deps.spawn ?? ((argv, options) => {
    const binary = argv[0];
    if (binary === undefined) throw new Error("operator agent binary is missing");
    return childFromProcess(spawnChild(binary, argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] }));
  });
  const maxMs = deps.maxMs ?? 20 * 60 * 1_000;
  const now = deps.now ?? Date.now;
  const clock: OperatorClock = deps.clock ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (timer) => globalThis.clearTimeout(timer ?? undefined),
  };
  let child: OperatorChild | null = null;
  let ready: Promise<void> | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let buffer = "";
  let decoder = new TextDecoder();
  let closed = false;
  let active: { id: string; startedAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let contextHandler: ((delegationId: string, text: string, kind?: "commentary") => void) | undefined;
  let endHandler: ((delegationId: string) => void) | undefined;
  let nextId = 1;
  let pendingText: PendingText | null = null;

  const emit = (id: string, text: string, kind?: "commentary"): void => {
    for (const chunk of chunkLiveContext(text)) contextHandler?.(id, chunk, kind);
  };

  const finish = (id: string, text: string): void => {
    const current = active;
    if (current === null || current.id !== id) return;
    clock.clearTimeout(current.timer);
    active = null;
    emit(id, `"Agent Final Message":\n\n${text}`);
    endHandler?.(id);
  };

  const send = (message: JsonObject): void => {
    child?.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const handleEvent = (event: JsonObject): void => {
    const type = jsonStringField(event.type);
    if (type === "ready") {
      if (readyResolve) readyResolve();
      return;
    }
    if (type === "tool_execution_start" && active) {
      const name = toolName(event).replace(/^mcp__herdr_/, "");
      emit(active.id, `Using ${name}`, "commentary");
      return;
    }
    if (type === "message_end" && active && jsonStringField(jsonRecord(event.message)?.role) === "assistant" && eventStopReason(event) === "toolUse") {
      const text = eventText(event);
      if (text) emit(active.id, text, "commentary");
      return;
    }
    if (type === "agent_end" && active && event.isTerminal !== false) {
      const id = active.id;
      const text = assistantText(event.messages);
      if (text) {
        finish(id, text);
      } else {
        const requestId = nextId++;
        pendingText = {
          resolve: (fallback) => finish(id, fallback || "The operator agent finished without a message."),
          timer: clock.setTimeout(() => {
            pendingText = null;
            finish(id, "The operator agent finished without a message.");
          }, 2_000),
        };
        send({ id: requestId, type: "get_last_assistant_text" });
      }
    }
  };

  const onLine = (line: string): void => {
    try {
      // SAFETY: JSON.parse produces a JSON-compatible value for text that parsed successfully.
      const value = JSON.parse(line) as JsonValue;
      const event = jsonRecord(value);
      if (!event) return;
      const command = jsonStringField(event.command);
      const responseData = jsonRecord(event.data);
      if (command === "get_last_assistant_text" && pendingText) {
        clock.clearTimeout(pendingText.timer);
        const pending = pendingText;
        pendingText = null;
        pending.resolve(jsonStringField(responseData?.text) ?? "");
        return;
      }
      handleEvent(event);
    } catch {
      // Ignore non-JSON diagnostics on stdout; RPC events remain line-delimited JSON.
    }
  };

  const attach = (process: OperatorChild): void => {
    process.onStdout((chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    process.onStderr(() => {});
    process.onExit(() => {
      child = null;
      if (readyReject) readyReject(new Error("operator agent exited before ready"));
      ready = null;
      readyResolve = null;
      readyReject = null;
      if (active) {
        const id = active.id;
        clock.clearTimeout(active.timer);
        active = null;
        emit(id, '"Agent Final Message":\n\nThe operator agent stopped unexpectedly.');
        endHandler?.(id);
      }
    });
  };

  const ensureReady = async (): Promise<void> => {
    if (closed) throw new Error("operator agent is closed");
    if (child && ready === null) return;
    if (ready) return ready;
    writeMcpConfig(deps);
    const argv = [
      deps.settings.bin,
      "--mode=rpc",
      `--model=${deps.settings.model}`,
      "--no-tools",
      `--tools=${liveMcpToolNames().join(",")}`,
      `--system-prompt=${renderOperatorInstructions({ agent: deps.port.meta.agent, cwd: deps.port.meta.cwd, paneId: deps.port.meta.paneId, language: deps.language })}`,
      `--cwd=${deps.workDir}`,
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-lsp",
      "--no-prewalk",
    ];
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.COLLIE_LIVE_MCP_SOCKET = deps.mcp.socketPath;
    const childProcess = spawn(argv, { cwd: deps.workDir, env });
    child = childProcess;
    attach(childProcess);
    ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      readyTimer = clock.setTimeout(() => {
        ready = null;
        readyResolve = null;
        readyReject = null;
        childProcess.kill();
        reject(new Error("operator agent did not become ready"));
      }, 30_000);
    }).finally(() => {
      clock.clearTimeout(readyTimer);
      readyTimer = null;
    });
    return ready;
  };

  const start = async (id: string, request: string): Promise<void> => {
    try {
      await ensureReady();
    } catch {
      emit(id, '"Agent Final Message":\n\nThe operator agent could not start.');
      endHandler?.(id);
      return;
    }
    if (closed) return;
    if (active) {
      const previous = active;
      clock.clearTimeout(previous.timer);
      active = { id, startedAt: now(), timer: clock.setTimeout(() => timeout(id), maxMs) };
      send({ type: "steer", message: request });
      return;
    }
    active = { id, startedAt: now(), timer: clock.setTimeout(() => timeout(id), maxMs) };
    send({ id: nextId++, type: "prompt", message: request });
  };

  function timeout(id: string): void {
    if (!active || active.id !== id) return;
    send({ type: "abort" });
    finish(id, "The operator agent ran out of time.");
  }

  return {
    startDelegation(id, request) {
      void start(id, request);
    },
    onContext(handler) {
      contextHandler = handler;
    },
    onDelegationEnd(handler) {
      endHandler = handler;
    },
    async close() {
      closed = true;
      clock.clearTimeout(readyTimer);
      clock.clearTimeout(active?.timer ?? null);
      const process = child;
      child = null;
      if (!process) return;
      process.stdin.end();
      const deferred = Promise.withResolvers<void>();
      clock.setTimeout(() => {
        process.kill();
        deferred.resolve();
      }, 3_000);
      await deferred.promise;
    },
  };
}
