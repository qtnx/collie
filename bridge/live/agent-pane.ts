import type { TranscriptEntry } from "../journal/types.ts";
import type { AgentStatus } from "../types.ts";
import { chunkLiveContext } from "./protocol.ts";

/** Everything the agent plane needs from ONE pane, injected so the watcher is pure under `bun test`. */
export interface PaneAgentPort {
  /** Type the request and submit it — the guarded reply path, never a raw key send. */
  reply(request: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The pane's current status from the state engine; undefined when the pane is gone. */
  status(): AgentStatus | undefined;
  /** Newest journal turns (oldest-first), or null when this pane has no readable journal. */
  history(): Promise<TranscriptEntry[] | null>;
  /** ANSI-stripped recent screen text, or null when unreadable. */
  screen(): Promise<string | null>;
}

/** Extended pane controls used by the live operator's MCP server. */
export interface OperatorPanePort extends PaneAgentPort {
  readonly meta: { paneId: string; agent: string; cwd: string; label?: string };
  sendKeys(keys: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** This collie's panes, read-only. */
  listPanes(): Array<{ paneId: string; agent: string; status: AgentStatus; cwd: string; label?: string }>;
  /** Resolve when the pane is not working and its screen settled, or at the deadline. */
  waitIdle(timeoutMs: number): Promise<{ status: AgentStatus | undefined; settled: boolean }>;
}

/** Agent side of a live call: runs delegated requests and streams their outcome back as context. */
export interface LiveAgentEndpoint {
  startDelegation(id: string, request: string): void;
  onContext(handler: (delegationId: string, text: string, kind?: "commentary") => void): void;
  onDelegationEnd(handler: (delegationId: string) => void): void;
  close(): Promise<void>;
}

export interface PaneAgentOptions {
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Hard cap on one delegation's watch; default 20 minutes. */
  maxMs?: number;
}

function assistantText(entry: TranscriptEntry): string {
  return entry.parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Watch one pane's journal until delegated terminal work completes. */
export function createPaneAgentEndpoint(port: PaneAgentPort, opts: PaneAgentOptions = {}): LiveAgentEndpoint {
  const pollMs = opts.pollMs ?? 1_500;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? Date.now;
  const maxMs = opts.maxMs ?? 20 * 60 * 1_000;
  let contextHandler: ((delegationId: string, text: string, kind?: "commentary") => void) | undefined;
  let endHandler: ((delegationId: string) => void) | undefined;
  let generation = 0;
  let closed = false;

  const emit = (id: string, text: string, kind?: "commentary"): void => {
    for (const chunk of chunkLiveContext(text)) contextHandler?.(id, chunk, kind);
  };

  return {
    startDelegation(id: string, request: string): void {
      const current = ++generation;
      closed = false;
      void (async () => {
        const initialHistory = await port.history();
        if (closed || current !== generation) return;
        const cursor = new Set((initialHistory ?? []).map((entry) => entry.uuid));
        const reply = await port.reply(request);
        if (closed || current !== generation) return;
        if (!reply.ok) {
          emit(id, `"Agent Final Message":\n\nThe request could not be typed into the terminal: ${reply.reason}`);
          endHandler?.(id);
          return;
        }

        const startedAt = now();
        let sawWorking = false;
        let newAssistantSeen = false;
        let finalText = "";
        let historyUnavailable = initialHistory === null;
        for (;;) {
          if (closed || current !== generation) return;
          await sleep(pollMs);
          if (closed || current !== generation) return;
          const status = port.status();
          sawWorking ||= status === "working";
          const history = await port.history();
          if (closed || current !== generation) return;
          if (history === null) {
            historyUnavailable = true;
          } else {
            for (const entry of history) {
              if (cursor.has(entry.uuid)) continue;
              cursor.add(entry.uuid);
              if (entry.role !== "assistant") continue;
              const text = assistantText(entry);
              if (!text) continue;
              newAssistantSeen = true;
              finalText = text;
              emit(id, text, "commentary");
            }
          }
          const elapsed = now() - startedAt;
          if (
            (sawWorking && status !== "working") ||
            (!sawWorking && elapsed >= 15_000 && newAssistantSeen) ||
            elapsed >= maxMs
          ) {
            break;
          }
        }
        if (closed || current !== generation) return;
        if (!finalText && historyUnavailable) finalText = (await port.screen())?.slice(-1_500).trim() ?? "";
        if (!finalText) finalText = "The agent finished but no answer text could be read; check the pane.";
        emit(id, `"Agent Final Message":\n\n${finalText}`);
        if (!closed && current === generation) endHandler?.(id);
      })();
    },
    onContext(handler): void {
      contextHandler = handler;
    },
    onDelegationEnd(handler): void {
      endHandler = handler;
    },
    async close(): Promise<void> {
      closed = true;
      generation += 1;
    },
  };
}
