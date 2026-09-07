# 0036 — A live call borrows Codex Desktop's identity; audio bypasses the bridge

Status: **Accepted** (2026-09-07)

Related: [ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md) (Codex auth rides the operator's own binary) ·
[ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) and
[ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (the phone talks to the lead) ·
[ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) (opt-in is the ceiling).

## Context

Following speech-to-text (ADR 0029), realtime voice interaction with an agent inside a terminal pane
was requested. Unlike one-shot dictation where a recorded clip is uploaded and converted into text in
the composer, a "Live call" is a bidirectional WebRTC audio conversation with OpenAI's realtime model.
When the operator asks the model to perform terminal tasks, the call delegates work directly to the
agent running in the pane, observes its state transitions and journal transcript, and streams the
result back into the conversation.

Realtime voice introduces two architectural concerns beyond dictation:
1. **Network throughput and latency:** routing raw audio streams through the bridge host would add
   bandwidth load, latency, and media transcoding requirements to a lightweight terminal multiplexer.
2. **Identity on the wire:** the realtime call signaling endpoint (`/backend-api/codex/realtime/calls`)
   is a private ChatGPT endpoint that requires Codex Desktop's application identity and the operator's
   own ChatGPT account. Unlike STT where an "honest" User-Agent was probed first (ADR 0029), this
   realtime endpoint rejects any identity other than `Codex Desktop/0.153.0`.

## Decision

**Collie provides realtime voice calls to an agent in a pane via `bridge/live/`, disabled by default,
activated solely by a conscious CLI command (`collie live on`). Audio bypasses the bridge entirely,
and the signaling layer borrows Codex Desktop's identity with explicit operator consent.**

- **Audio bypasses the bridge:** WebRTC audio media flows directly between the browser on the phone
  and OpenAI's servers. The bridge never terminates RTP or media tracks, reducing memory and bandwidth
  costs on the host to near zero.
- **The bridge brokers auth and sideband control:** The bridge uses the operator's local `codex app-server`
  binary to obtain short-lived tokens via `getAuthStatus` (as in ADR 0029). It signs the initial SDP offer
  and maintains the WebSocket control sideband for tool delegation and status observation.
- **Identity is Codex Desktop's, with no honest alternative:** Because the private endpoint hard-rejects
  unrecognized clients, the bridge signs signaling requests as `Codex Desktop/0.153.0` (`originator: Codex Desktop`).
  There is no honest wire option. `collie live on` displays an explicit consent banner warning that
  the private endpoint may break without notice and rate-limit/ban exposure rests with the operator's
  ChatGPT account.
- **Opt-in by CLI act:** Enabled via `collie live on [--voice <name>] [--yes]` which writes `<stateDir>/live.json`
  at mode 0600. The bridge re-reads this file on each request behind an mtime cache. No restart is needed.
  `collie live off` removes the file and disables the feature.
- **Lead-only:** Live calls attach only to local panes on the lead node. A pane on a pack peer is
  refused with `live.peer_pane` (status 409). PACK_PROTOCOL is untouched.
- **Delegation goes through the guarded reply path:** When the model delegates a command or question to the
  terminal, it uses `sendReplySteps` with prompt verification, exactly like a typed user reply.

## Consequences

- **Brittle upstream dependency:** Changes to OpenAI's private `/backend-api/codex/realtime/calls` endpoint
  or protocol format may disable live calls without prior notice.
- **Lead-only limitation:** Panes running on federated pack peers cannot receive live calls; operators must
  interact with them from the lead or via normal typed/dictated replies.
- **Zero media egress from host:** The host runs only lightweight JSON/WebSocket control signaling, leaving
  CPU and network capacity free for development tools and agent execution.
