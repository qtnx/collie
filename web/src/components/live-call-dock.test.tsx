import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import type * as LiveModule from "@/lib/live";
import type { LiveState } from "@/lib/live";
import { RootLayout } from "@/routes/root";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { fixtureAgents, fixtureShellPanes } from "@/test/handlers";

// The dock is what makes a live call a BACKGROUND FACT rather than a modal task, and the two halves
// of that claim are what this file holds to: it is mounted by the root layout (so it outlives every
// route change), and it is not a dialog (no `aria-modal`, no backdrop, nothing trapping focus).
//
// The store is stubbed rather than driven: `startCall` wants a microphone and an `RTCPeerConnection`,
// neither of which exists under jsdom, and none of the behaviour asserted here is about the
// handshake. `phoneLivePhase` — the merge the phase word is read through — stays REAL, so a change
// to the phase rules still moves these tests.
/** The stubbed store, named rather than anonymous: `vi.hoisted` runs above this file's imports, so
 *  the holder cannot infer its `state` from `IDLE` below and needs a contract of its own. */
interface LiveStub {
  /** Null until `beforeEach` sets it; the mock's reader is only ever called from a render. */
  state: LiveState | null;
  toggleMute: () => void;
  endCall: () => void;
  dismissCall: () => void;
  startCall: () => void;
}

const live = vi.hoisted(
  (): LiveStub => ({
    state: null,
    toggleMute: vi.fn(),
    endCall: vi.fn(),
    dismissCall: vi.fn(),
    startCall: vi.fn(),
  }),
);

vi.mock("@/lib/live", async (importOriginal) => {
  const actual = await importOriginal<typeof LiveModule>();
  return {
    ...actual,
    useLiveState: () => live.state ?? IDLE,
    startCall: live.startCall,
    endCall: live.endCall,
    dismissCall: live.dismissCall,
    toggleMute: live.toggleMute,
  };
});

const IDLE: LiveState = {
  status: "idle",
  paneId: null,
  bridgePhase: "connecting",
  mediaUp: false,
  muted: false,
  outputLevel: 0,
  usage: { audioMs: 0 },
};

function calling(over: Partial<LiveState> = {}): LiveState {
  return {
    ...IDLE,
    status: "active",
    // fixtureAgents[0] — a claude pane in the "webapp" space, so the pill has a real name to show.
    paneId: "w1:p1",
    bridgePhase: "listening",
    mediaUp: true,
    ...over,
  };
}

function home(): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: fixtureAgents,
    shellPanes: fixtureShellPanes,
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
    lastSeenAt: 0,
  };
}

/** The root layout, with a second route to navigate to — the dock must survive the trip. */
function renderApp() {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => home(),
        element: <RootLayout />,
        children: [
          { index: true, element: <p>dashboard</p> },
          { path: "settings", element: <p>settings</p> },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  const view = render(<RouterProvider router={router} />);
  return { ...view, router };
}

/** The dock's own subtree, once it is on screen — the root route's loader resolves on a microtask,
 *  so nothing is mounted on the first render. Scoped by `data-slot`, never by a bare role query:
 *  `ui/strip-host.tsx` mounts two permanent `sr-only` live regions, so `getByRole("status")` is
 *  ambiguous in any tree with a header in it and would fail as "missing" rather than "duplicated". */
async function findDock(): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.body.querySelector<HTMLElement>('[data-slot="live-call-dock"]');
    expect(found).not.toBeNull();
    return found!;
  });
}

beforeEach(() => {
  live.state = IDLE;
  vi.clearAllMocks();
});

describe("LiveCallDock — mounted by the root layout", () => {
  it("draws nothing at all while there is no call", async () => {
    renderApp();
    await screen.findByText("dashboard");
    expect(document.body.querySelector('[data-slot="live-call-dock"]')).toBeNull();
  });

  it("renders the phase as a status while a call is up", async () => {
    live.state = calling();
    renderApp();
    const panel = await findDock();
    // The phase word is the one thing here that changes on its own, so it is announced.
    expect(within(panel).getByRole("status")).toHaveTextContent("Listening");
    // …and the pane it is delegating into, by the name `paneDisplayName` gives it — this fixture
    // carries no label of its own, so that is the agent running in it.
    expect(within(panel).getByText("claude")).toBeInTheDocument();
  });

  it("is NOT a dialog: no aria-modal, no backdrop, and the page underneath stays tappable", async () => {
    live.state = calling();
    renderApp();
    const panel = await findDock();
    // The whole reason this replaced the sheet. A modal would take the app away for the call's
    // duration — which is exactly what a call must not do.
    expect(panel.querySelector("[aria-modal]")).toBeNull();
    expect(panel.getAttribute("role")).toBeNull();
    expect(panel.className).toContain("pointer-events-none");
    // The route under the dock is still rendered and still reachable.
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("keeps the call up across a route change", async () => {
    live.state = calling();
    const { router } = renderApp();
    await findDock();

    await act(async () => {
      await router.navigate("/settings");
    });

    expect(await screen.findByText("settings")).toBeInTheDocument();
    // Same call, still on screen: the dock is mounted OUTSIDE the outlet, so a navigation cannot
    // unmount it — and nothing here ended the call on the way.
    expect(within(await findDock()).getByRole("status")).toHaveTextContent("Listening");
    expect(live.endCall).not.toHaveBeenCalled();
  });

  it("shows what the call has spent once the pill is expanded", async () => {
    const user = userEvent.setup();
    live.state = calling({
      user: { seq: 1, role: "user", turn: 1, text: "why is the build red", final: true },
      usage: {
        audioMs: 83_400,
        operator: {
          inputTokens: 900,
          outputTokens: 348,
          cacheReadTokens: 0,
          totalTokens: 1248,
          costUsd: 0.0132,
          turns: 2,
        },
      },
    });
    renderApp();
    const panel = await findDock();

    await user.click(within(panel).getByRole("button", { expanded: false }));

    // mm:ss off `audioMs`, tokens and cost off the operator agent's own totals.
    expect(within(panel).getByText(/01:23 of call/)).toBeInTheDocument();
    expect(within(panel).getByText(/1248 tokens/)).toBeInTheDocument();
    expect(within(panel).getByText(/\$0\.0132/)).toBeInTheDocument();
    // The transcript rides in the card, not the pill.
    expect(within(panel).getByText("why is the build red")).toBeInTheDocument();
  });

  it("omits tokens and cost when the call ran no operator agent", async () => {
    const user = userEvent.setup();
    live.state = calling({ usage: { audioMs: 4_000 } });
    renderApp();
    const panel = await findDock();

    await user.click(within(panel).getByRole("button", { expanded: false }));

    expect(within(panel).getByText("00:04 of call")).toBeInTheDocument();
    expect(within(panel).queryByText(/token/)).toBeNull();
    expect(within(panel).queryByText(/\$/)).toBeNull();
  });

  it("navigates to the call's own pane from the expanded card", async () => {
    const user = userEvent.setup();
    live.state = calling();
    const { router } = renderApp();
    const panel = await findDock();

    await user.click(within(panel).getByRole("button", { expanded: false }));
    await user.click(within(panel).getByRole("button", { name: "Show pane" }));

    // The pane the call was STARTED for, not whatever route happens to be on screen.
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w1%3Ap1"));
  });

  it("hangs up on End", async () => {
    const user = userEvent.setup();
    live.state = calling();
    renderApp();
    await user.click(within(await findDock()).getByRole("button", { name: "End call" }));
    expect(live.endCall).toHaveBeenCalled();
  });

  it("offers a dismiss instead once the call is already over", async () => {
    const user = userEvent.setup();
    // An ended call leaves the dock standing so the operator can read why it ended — the same
    // control now clears it rather than hanging up a call that is already down.
    live.state = calling({ status: "ended", bridgePhase: "ended" });
    renderApp();
    const panel = await findDock();

    expect(within(panel).getByRole("status")).toHaveTextContent("Call ended");
    await user.click(within(panel).getByRole("button", { name: "Dismiss" }));
    expect(live.dismissCall).toHaveBeenCalled();
    expect(live.endCall).not.toHaveBeenCalled();
  });

  it("mutes without a route — the toggle is local to this browser", async () => {
    const user = userEvent.setup();
    live.state = calling();
    renderApp();
    await user.click(within(await findDock()).getByRole("button", { name: "Mute" }));
    expect(live.toggleMute).toHaveBeenCalledTimes(1);
  });
});
