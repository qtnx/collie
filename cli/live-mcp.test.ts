import { describe, expect, test } from "bun:test";

import { EXIT } from "./io.ts";
import { cmdLiveMcp, COLLIE_LIVE_MCP_SOCKET_ENV, type LiveMcpConnectOpts, type LiveMcpSocket } from "./live-mcp.ts";

function fakeStreams() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write(chunk: Uint8Array | string) {
        stdout.push(chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : chunk);
      },
    },
    stderr: {
      write(chunk: Uint8Array | string) {
        stderr.push(chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : chunk);
      },
    },
    outLines: stdout,
    errLines: stderr,
  };
}

describe("cli/live-mcp", () => {
  test("exits with USAGE (2) when COLLIE_LIVE_MCP_SOCKET is not set", async () => {
    const streams = fakeStreams();
    let exitedCode: number | undefined;

    const code = await cmdLiveMcp({
      env: {},
      stdout: streams.stdout,
      stderr: streams.stderr,
      exit: (c) => {
        exitedCode = c;
      },
    });

    expect(code).toBe(EXIT.USAGE);
    expect(exitedCode).toBe(EXIT.USAGE);
    expect(streams.errLines.join("")).toContain("COLLIE_LIVE_MCP_SOCKET environment variable is not set");
  });

  test("exits with USAGE (2) when connection is refused / fails", async () => {
    const streams = fakeStreams();
    let exitedCode: number | undefined;

    const code = await cmdLiveMcp({
      env: { [COLLIE_LIVE_MCP_SOCKET_ENV]: "/tmp/nonexistent.sock" },
      stdout: streams.stdout,
      stderr: streams.stderr,
      connect: async () => {
        throw new Error("Connection refused");
      },
      exit: (c) => {
        exitedCode = c;
      },
    });

    expect(code).toBe(EXIT.USAGE);
    expect(exitedCode).toBe(EXIT.USAGE);
    expect(streams.errLines.join("")).toContain("could not connect to live MCP socket: Connection refused");
  });

  test("exits with USAGE (2) when socket fires error callback", async () => {
    const streams = fakeStreams();
    let exitedCode: number | undefined;

    const code = await cmdLiveMcp({
      env: { [COLLIE_LIVE_MCP_SOCKET_ENV]: "/tmp/test.sock" },
      stdout: streams.stdout,
      stderr: streams.stderr,
      connect: (opts: LiveMcpConnectOpts) => {
        const fakeSock: LiveMcpSocket = {
          write: () => true,
          end: () => {},
        };
        queueMicrotask(() => {
          opts.socket.error(fakeSock, new Error("ECONNREFUSED"));
        });
        return fakeSock;
      },
      exit: (c) => {
        exitedCode = c;
      },
    });

    expect(code).toBe(EXIT.USAGE);
    expect(exitedCode).toBe(EXIT.USAGE);
    expect(streams.errLines.join("")).toContain("could not connect to live MCP socket: ECONNREFUSED");
  });

  test("pipes stdin to socket and socket data to stdout, exits 0 on socket close", async () => {
    const streams = fakeStreams();
    const socketWrites: string[] = [];
    let socketEnded = false;
    let exitedCode: number | undefined;

    let triggerData: ((chunk: Uint8Array) => void) | undefined;
    let triggerClose: (() => void) | undefined;
    let notifyEnded: () => void = () => {};
    const endedPromise = new Promise<void>((resolve) => {
      notifyEnded = resolve;
    });

    async function* fakeStdin() {
      yield new TextEncoder().encode('{"jsonrpc":"2.0","method":"ping"}\n');
    }

    const fakeSock: LiveMcpSocket = {
      write(chunk) {
        socketWrites.push(chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : chunk);
        return true;
      },
      end() {
        socketEnded = true;
        notifyEnded();
      },
    };

    const runPromise = cmdLiveMcp({
      env: { [COLLIE_LIVE_MCP_SOCKET_ENV]: "/tmp/live.sock" },
      stdout: streams.stdout,
      stderr: streams.stderr,
      stdinStream: fakeStdin,
      connect: (opts: LiveMcpConnectOpts) => {
        triggerData = (chunk) => opts.socket.data(fakeSock, chunk);
        triggerClose = () => opts.socket.close(fakeSock);
        return fakeSock;
      },
      exit: (c) => {
        exitedCode = c;
      },
    });

    await endedPromise;
    expect(socketWrites).toEqual(['{"jsonrpc":"2.0","method":"ping"}\n']);
    expect(socketEnded).toBe(true);

    triggerData?.(new TextEncoder().encode('{"jsonrpc":"2.0","result":{}}\n'));
    expect(streams.outLines).toEqual(['{"jsonrpc":"2.0","result":{}}\n']);

    triggerClose?.();
    const code = await runPromise;
    expect(code).toBe(EXIT.OK);
    expect(exitedCode).toBe(EXIT.OK);
  });
});
