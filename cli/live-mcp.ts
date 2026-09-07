import { EXIT } from "./io.ts";

export const COLLIE_LIVE_MCP_SOCKET_ENV = "COLLIE_LIVE_MCP_SOCKET";

export interface LiveMcpSocket {
  write(chunk: Uint8Array | string): number | boolean;
  end(): void;
}

export interface LiveMcpConnectOpts {
  unix: string;
  socket: {
    data(socket: LiveMcpSocket, chunk: Buffer | Uint8Array): void;
    close(socket: LiveMcpSocket): void;
    error(socket: LiveMcpSocket, error: Error): void;
    open?(socket: LiveMcpSocket): void;
  };
}

export interface LiveMcpDeps {
  env?: Record<string, string | undefined>;
  stdout?: { write(chunk: Uint8Array | string): boolean | void };
  stderr?: { write(chunk: Uint8Array | string): boolean | void };
  stdinStream?: () => AsyncIterable<Uint8Array>;
  connect?: (opts: LiveMcpConnectOpts) => Promise<LiveMcpSocket> | LiveMcpSocket;
  exit?: (code: number) => void;
}

export async function cmdLiveMcp(deps: LiveMcpDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const socketPath = env[COLLIE_LIVE_MCP_SOCKET_ENV]?.trim();
  const stderr = deps.stderr ?? process.stderr;
  const stdout = deps.stdout ?? process.stdout;

  const terminate = (code: number): void => {
    if (deps.exit) {
      deps.exit(code);
    } else if (deps.connect === undefined) {
      process.exit(code);
    }
  };

  if (!socketPath) {
    stderr.write(`error: ${COLLIE_LIVE_MCP_SOCKET_ENV} environment variable is not set\n`);
    terminate(EXIT.USAGE);
    return EXIT.USAGE;
  }

  const connect =
    deps.connect ??
    (async (opts: LiveMcpConnectOpts): Promise<LiveMcpSocket> => {
      // SAFETY: Bun.connect returns a Socket instance satisfying LiveMcpSocket.
      return (await Bun.connect(opts)) as LiveMcpSocket;
    });
  const stdinStream = deps.stdinStream ?? (() => Bun.stdin.stream());

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      terminate(code);
      resolve(code);
    };

    const pumpStdin = async (socket: LiveMcpSocket): Promise<void> => {
      try {
        for await (const chunk of stdinStream()) {
          if (settled) break;
          socket.write(chunk);
        }
      } catch {
        // stdin stream ended or errored
      } finally {
        try {
          socket.end();
        } catch {
          // ignore socket end error
        }
      }
    };

    void (async (): Promise<void> => {
      try {
        const sock = await connect({
          unix: socketPath,
          socket: {
            data(_socket, chunk) {
              stdout.write(chunk);
            },
            close(_socket) {
              finish(EXIT.OK);
            },
            error(_socket, error) {
              stderr.write(`error: could not connect to live MCP socket: ${error.message}\n`);
              finish(EXIT.USAGE);
            },
          },
        });
        await pumpStdin(sock);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        stderr.write(`error: could not connect to live MCP socket: ${msg}\n`);
        finish(EXIT.USAGE);
      }
    })();
  });
}
