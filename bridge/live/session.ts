import type { LiveAgentEndpoint } from "./agent-pane.ts";
import { buildDelegationContextAppend, buildSessionClose, type LiveClientMessage, type LiveServerEvent } from "./protocol.ts";
import type { LiveControlTransport } from "./signaling.ts";
import type { LiveUsage } from "../types.ts";
export type LivePhase = "connecting" | "listening" | "working" | "ended" | "error";

export interface LiveTranscriptRow {
  seq: number;
  role: "user" | "assistant";
  /** Role-local turn number; a later row with the same role+turn replaces the earlier one. */
  turn: number;
  text: string;
  final: boolean;
}

export interface LiveSessionView {
  phase: LivePhase;
  error?: string;
  /** Highest seq issued so far; the phone passes it back as `?after=`. */
  seq: number;
  transcripts: LiveTranscriptRow[];
  usage: LiveUsage;
}

export interface LiveSessionOptions {
  id: string;
  transport: LiveControlTransport;
  agent: LiveAgentEndpoint;
  now?: () => number;
}

/** One bridge-owned live call, independent from browser media transport. */
export class LiveSession {
  readonly id: string;
  private readonly transport: LiveControlTransport;
  private readonly agent: LiveAgentEndpoint;
  private readonly now: () => number;
  private phase: LivePhase = "connecting";
  private errorText: string | undefined;
  private sequence = 0;
  private readonly transcripts: LiveTranscriptRow[] = [];
  private sendChain: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | undefined;

  private stopped = false;
  private lastSeenAt: number;
  private endedAtValue: number | undefined;
  private activeDelegationId: string | undefined;
  private userTranscript = "";
  private assistantTranscript = "";
  private userTranscriptFinal = false;
  private assistantTranscriptFinal = false;
  private userTranscriptTurn = 0;
  private assistantTranscriptTurn = 0;
  private lastTranscript: Omit<LiveTranscriptRow, "seq"> | undefined;
  private audioMs = 0;
  private operatorUsage: NonNullable<LiveUsage["operator"]> | undefined;
  constructor(opts: LiveSessionOptions) {
    this.id = opts.id;
    this.transport = opts.transport;
    this.agent = opts.agent;
    this.now = opts.now ?? Date.now;
    this.lastSeenAt = this.now();
  }

  /** Connect the control plane with the phone's offer; resolves with the SDP answer. */
  async start(offerSdp: string): Promise<string> {
    if (this.stopped) throw new Error("This live session has already stopped");
    this.agent.onContext((delegationId, text, kind) => {
      if (!this.stopped) this.queueSend(buildDelegationContextAppend(delegationId, text, kind));
    });
    this.agent.onDelegationEnd((delegationId) => {
      if (!this.stopped && this.activeDelegationId === delegationId) {
        this.activeDelegationId = undefined;
        this.phase = "listening";
      }
    });
    this.agent.onUsage?.((u) => {
      this.operatorUsage = u;
    });
    try {
      const answer = await this.transport.connect(offerSdp);
      if (this.stopped) throw new Error("This live session stopped while connecting");

      return answer;
    } catch (cause) {
      this.phase = "error";
      this.errorText = cause instanceof Error ? cause.message : String(cause);
      await this.stop();
      throw cause;
    }
  }

  /** Events after terminal cleanup are ignored; `session.started` may land before connect() resolves. */
  handleEvent(event: LiveServerEvent): void {
    if (this.stopped) return;
    // The sideband does not always replay `session.started` (observed: it opens before the media
    // path does and then receives only later traffic), so ANY non-error event proves the session
    // is up. The phone additionally flips itself on its own data channel opening.
    if (this.phase === "connecting" && event.type !== "error") this.phase = "listening";
    switch (event.type) {
      case "session.started":
        this.phase = "listening";
        break;
      case "input_transcript.added":
        this.addTranscript("user", event.item.text);
        break;
      case "session.usage.updated":
        this.audioMs = event.audioMs;
        break;
      case "output_transcript.added":
        this.addTranscript("assistant", event.item.text);
        break;
      case "turn.done":
        this.finishTranscript(event.turn.role, event.turn.transcript);
        break;
      case "delegation.created":
        this.handleDelegation(event);
        break;
      case "error":
        this.phase = "error";
        this.errorText = event.message;
        void this.stop();
        break;
    }
  }

  /** Rows with seq > after; also stamps `lastSeen`. */
  view(after: number): LiveSessionView {
    this.lastSeenAt = this.now();
    const view: LiveSessionView = {
      phase: this.phase,
      seq: this.sequence,
      transcripts: this.transcripts.filter((row) => row.seq > after),
      usage: this.usage,
    };
    if (this.errorText !== undefined) view.error = this.errorText;
    return view;
  }

  get usage(): LiveUsage {
    const usage: LiveUsage = { audioMs: this.audioMs };
    if (this.operatorUsage) usage.operator = this.operatorUsage;
    return usage;
  }

  stop(_reason?: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopped = true;
      try {
        await this.agent.close();
      } catch {
        // Cleanup continues because closing transport is more important than pane watcher failure.
      }
      await this.sendChain;
      try {
        await this.transport.send(buildSessionClose());
      } catch {
        // A lost sideband has already made session.close impossible.
      }
      try {
        await this.transport.close();
      } catch {
        // Transport cleanup is best effort after a remote terminal event.
      }
      if (this.phase !== "error") this.phase = "ended";
      this.endedAtValue = this.now();
    })();
    return this.stopPromise;
  }

  get lastSeen(): number {
    return this.lastSeenAt;
  }

  get endedAt(): number | undefined {
    return this.endedAtValue;
  }

  private handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
    const request = event.item.content
      .filter((content) => content.type === "input_text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!request) return;
    this.activeDelegationId = event.item.id;
    this.phase = "working";
    this.agent.startDelegation(event.item.id, request);
  }

  private addTranscript(role: LiveTranscriptRow["role"], text: string): void {
    if (!text) return;
    const current = role === "user" ? this.userTranscript : this.assistantTranscript;
    const wasFinal = role === "user" ? this.userTranscriptFinal : this.assistantTranscriptFinal;
    let next: string;
    if (!current) {
      this.startTranscriptTurn(role);
      next = text;
    } else if (wasFinal) {
      if (text === current || current.endsWith(text)) return;
      this.startTranscriptTurn(role);
      next = text;
    } else if (text.startsWith(current)) {
      next = text;
    } else if (current.endsWith(text)) {
      next = current;
    } else {
      next = current + text;
    }
    this.storeTranscript(role, next, false);
  }

  private finishTranscript(role: LiveTranscriptRow["role"], text: string): void {
    if (!text) return;
    const current = role === "user" ? this.userTranscript : this.assistantTranscript;
    const wasFinal = role === "user" ? this.userTranscriptFinal : this.assistantTranscriptFinal;
    if (!current) {
      this.startTranscriptTurn(role);
    } else if (wasFinal) {
      if (text === current) return;
      this.startTranscriptTurn(role);
    }
    this.storeTranscript(role, !wasFinal && current.startsWith(text) && current.length > text.length ? current : text, true);
  }

  private startTranscriptTurn(role: LiveTranscriptRow["role"]): void {
    if (role === "user") this.userTranscriptTurn += 1;
    else this.assistantTranscriptTurn += 1;
  }

  private storeTranscript(role: LiveTranscriptRow["role"], text: string, final: boolean): void {
    const normalized = text.trim();
    if (!normalized) return;
    const turn = role === "user" ? this.userTranscriptTurn : this.assistantTranscriptTurn;
    if (role === "user") {
      this.userTranscript = normalized;
      this.userTranscriptFinal = final;
    } else {
      this.assistantTranscript = normalized;
      this.assistantTranscriptFinal = final;
    }
    const transcript = { role, turn, text: normalized, final };
    if (
      this.lastTranscript?.role === transcript.role &&
      this.lastTranscript.turn === transcript.turn &&
      this.lastTranscript.text === transcript.text &&
      this.lastTranscript.final === transcript.final
    ) {
      return;
    }
    this.lastTranscript = transcript;
    this.sequence += 1;
    this.transcripts.push({ seq: this.sequence, ...transcript });
  }

  private queueSend(message: LiveClientMessage): void {
    this.sendChain = this.sendChain
      .then(async () => {
        if (!this.stopped) await this.transport.send(message);
        return undefined;
      })
      .catch((cause: unknown) => {
        if (this.stopped) return;
        this.phase = "error";
        this.errorText = cause instanceof Error ? cause.message : String(cause);
        void this.stop();
      });
  }
}
