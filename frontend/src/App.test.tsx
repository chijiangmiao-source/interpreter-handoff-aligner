import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

afterEach(() => cleanup());

const okBody = {
  steps: [
    {
      action: "match",
      left: { time: 0, text: "各位媒体朋友下午好" },
      right: { time: 150, text: "各位媒体朋友下午好" },
      cost: 150,
      cumulative_cost: 150,
    },
    {
      action: "match",
      left: { time: 4200, text: "新产品将于下月上市" },
      right: { time: 4100, text: "新产品将于下月上市" },
      cost: 100,
      cumulative_cost: 250,
    },
    {
      action: "right_gap",
      left: { time: 9000, text: "感谢各位的提问" },
      right: null,
      cost: 2000,
      cumulative_cost: 2250,
    },
    {
      action: "left_gap",
      left: null,
      right: { time: 12000, text: "交接后的补充记录" },
      cost: 2000,
      cumulative_cost: 4250,
    },
  ],
  total_cost: 4250,
  counts: { match: 2, left_gap: 1, right_gap: 1 },
  costs: { gap: 2000, mismatch_penalty: 3000 },
};

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const anchoredBody = {
  steps: [
    {
      action: "match",
      left: { time: 0, text: "各位媒体朋友下午好" },
      right: { time: 150, text: "各位媒体朋友下午好" },
      cost: 150,
      cumulative_cost: 150,
      origin: "anchor",
    },
    {
      action: "match",
      left: { time: 4200, text: "新产品将于下月上市" },
      right: { time: 4100, text: "新产品将于下月上市" },
      cost: 100,
      cumulative_cost: 250,
      origin: "auto",
    },
    {
      action: "right_gap",
      left: { time: 9000, text: "感谢各位的提问" },
      right: null,
      cost: 2000,
      cumulative_cost: 2250,
      origin: "auto",
    },
    {
      action: "left_gap",
      left: null,
      right: { time: 12000, text: "交接后的补充记录" },
      cost: 2000,
      cumulative_cost: 4250,
      origin: "auto",
    },
  ],
  total_cost: 4250,
  counts: { match: 2, left_gap: 1, right_gap: 1 },
  anchors: [{ left: 0, right: 0 }],
  costs: { gap: 2000, mismatch_penalty: 3000 },
};

// Golden body with an equal-cost runner-up: the tail gap rows swap order.
const compareBody = {
  ...okBody,
  alternative: {
    steps: [
      okBody.steps[0],
      okBody.steps[1],
      {
        action: "left_gap",
        left: null,
        right: { time: 12000, text: "交接后的补充记录" },
        cost: 2000,
        cumulative_cost: 2250,
      },
      {
        action: "right_gap",
        left: { time: 9000, text: "感谢各位的提问" },
        right: null,
        cost: 2000,
        cumulative_cost: 4250,
      },
    ],
    total_cost: 4250,
    cost_diff: 0,
    first_divergence: { left: null, right: 2 },
  },
};

// Strict (more expensive) runner-up: two mismatch-free matches cost 8000 vs
// the primary gap+match+gap at 7000.
const strictGapBody = {
  steps: [
    {
      action: "right_gap",
      left: { time: 0, text: "a" },
      right: null,
      cost: 2000,
      cumulative_cost: 2000,
    },
    {
      action: "match",
      left: { time: 4000, text: "b" },
      right: { time: 4000, text: "a" },
      cost: 3000,
      cumulative_cost: 5000,
    },
    {
      action: "left_gap",
      left: null,
      right: { time: 8000, text: "b" },
      cost: 2000,
      cumulative_cost: 7000,
    },
  ],
  total_cost: 7000,
  counts: { match: 1, left_gap: 1, right_gap: 1 },
  costs: { gap: 2000, mismatch_penalty: 3000 },
  alternative: {
    steps: [
      {
        action: "match",
        left: { time: 0, text: "a" },
        right: { time: 4000, text: "a" },
        cost: 4000,
        cumulative_cost: 4000,
      },
      {
        action: "match",
        left: { time: 4000, text: "b" },
        right: { time: 8000, text: "b" },
        cost: 4000,
        cumulative_cost: 8000,
      },
    ],
    total_cost: 8000,
    cost_diff: 1000,
    first_divergence: { left: 0, right: 0 },
  },
};

describe("App", () => {
  it("renders both JSON inputs and sample data on load", () => {
    render(<App />);
    const left = screen.getByTestId("input-left") as HTMLTextAreaElement;
    const right = screen.getByTestId("input-right") as HTMLTextAreaElement;
    expect(left.value).toContain("各位媒体朋友下午好");
    expect(right.value).toContain("交接后的补充记录");
  });

  it("renders the timeline row by row with costs after a valid run", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(okBody));
    render(<App />);
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    const rows = screen.getAllByTestId("timeline-row");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveAttribute("data-action", "match");
    // Row 2 keeps the left 9000 note with the right side blank -> right_gap;
    // row 3 keeps the right 12000 note with the left side blank -> left_gap.
    expect(rows[2]).toHaveAttribute("data-action", "right_gap");
    expect(rows[3]).toHaveAttribute("data-action", "left_gap");
    expect(screen.getByTestId("total-cost")).toHaveTextContent("4250");

    const costs = screen
      .getAllByTestId("step-cost")
      .map((el) => el.textContent);
    expect(costs).toEqual(["150", "100", "2000", "2000"]);
    const cumulative = screen
      .getAllByTestId("step-cumulative")
      .map((el) => el.textContent);
    expect(cumulative).toEqual(["150", "250", "2250", "4250"]);

    vi.unstubAllGlobals();
  });

  it("keeps the raw input and marks exactly the first error path from API", async () => {
    const fetchMock = mockFetchOnce(
      { error: "未严格递增", path: "left[1].time" },
      422,
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const left = screen.getByTestId("input-left") as HTMLTextAreaElement;
    const before = left.value;
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("error-banner")).toBeInTheDocument(),
    );
    // Input preserved verbatim.
    expect((screen.getByTestId("input-left") as HTMLTextAreaElement).value).toBe(
      before,
    );
    // Exactly one error banner / path.
    expect(screen.getAllByTestId("error-path")).toHaveLength(1);
    expect(screen.getByTestId("error-path").textContent).toContain("left[1].time");
    // The mark is rendered inside the left textarea backdrop only.
    expect(screen.getByTestId("input-left-mark")).toBeInTheDocument();
    expect(screen.queryByTestId("input-right-mark")).toBeNull();
    expect(screen.queryByTestId("result-panel")).toBeNull();

    vi.unstubAllGlobals();
  });

  it("highlights malformed JSON locally without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<App />);
    fireEvent.change(screen.getByTestId("input-left"), {
      target: { value: `[{"time": 1, "text": "a"} ,]` },
    });
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("error-banner")).toBeInTheDocument(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("input-left-mark")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("rejects duplicate times locally with the first-offender path", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<App />);
    fireEvent.change(screen.getByTestId("input-left"), {
      target: {
        value: JSON.stringify([
          { time: 1, text: "a" },
          { time: 1, text: "b" },
        ]),
      },
    });
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("error-banner")).toBeInTheDocument(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-path").textContent).toContain("left[1].time");
    vi.unstubAllGlobals();
  });

  it("supports step-by-step replay of the timeline", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(okBody));
    render(<App />);
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getAllByTestId("timeline-row")).toHaveLength(4),
    );

    // Walk back to the first step: one row, running total 150.
    fireEvent.click(screen.getByTestId("step-back"));
    fireEvent.click(screen.getByTestId("step-back"));
    fireEvent.click(screen.getByTestId("step-back"));
    expect(screen.getAllByTestId("timeline-row")).toHaveLength(1);
    expect(screen.getByTestId("replay-count").textContent).toContain("复算 1 / 4");
    expect(screen.getByTestId("total-cost").textContent).toBe("150");

    // Advance one step at a time.
    fireEvent.click(screen.getByTestId("step-next"));
    expect(screen.getAllByTestId("timeline-row")).toHaveLength(2);
    expect(screen.getByTestId("total-cost").textContent).toBe("250");
    fireEvent.click(screen.getByTestId("step-next"));
    expect(screen.getByTestId("total-cost").textContent).toBe("2250");
    vi.unstubAllGlobals();
  });

  it("clear button resets both inputs", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("clear"));
    expect((screen.getByTestId("input-left") as HTMLTextAreaElement).value).toBe("[]");
    expect((screen.getByTestId("input-right") as HTMLTextAreaElement).value).toBe("[]");
  });

  it("handles huge increasing timestamps (beyond safe integers) without a false duplicate", async () => {
    let sentBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = init!.body as string;
        // Response timestamps are small here; this case only checks the
        // request forwarding and that local validation does not flag the
        // two huge, double-colliding input times as duplicates.
        return new Response(
          JSON.stringify({
            steps: [
              {
                action: "right_gap",
                left: { time: 9007199254740992, text: "a" },
                right: null,
                cost: 2000,
                cumulative_cost: 2000,
              },
              {
                action: "right_gap",
                left: { time: 9007199254740996, text: "b" },
                right: null,
                cost: 2000,
                cumulative_cost: 4000,
              },
            ],
            total_cost: 4000,
            counts: { match: 0, left_gap: 0, right_gap: 2 },
            costs: { gap: 2000, mismatch_penalty: 3000 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByTestId("input-left"), {
      target: {
        value: `[\n  {"time": 9007199254740993, "text": "a"},\n  {"time": 9007199254740995, "text": "b"}\n]`,
      },
    });
    fireEvent.change(screen.getByTestId("input-right"), {
      target: { value: "[]" },
    });
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    // No validation banner despite the double-precision collision.
    expect(screen.queryByTestId("error-banner")).toBeNull();
    // Exact digits were forwarded verbatim to the API.
    expect(sentBody).toContain("9007199254740993");
    expect(sentBody).toContain("9007199254740995");
    vi.unstubAllGlobals();
  });

  // ------------------------------------------------------------------ //
  // Human-confirmed anchors.
  // ------------------------------------------------------------------ //

  it("renders the anchor picker with one row per parsed record", () => {
    render(<App />);
    expect(screen.getByTestId("anchor-panel")).toBeInTheDocument();
    // No anchors yet: the empty state is shown and there are no anchor rows.
    expect(screen.getByTestId("anchor-empty")).toBeInTheDocument();
    expect(screen.queryAllByTestId("anchor-item")).toHaveLength(0);
    // Sample data has 3 records on each side.
    expect(screen.getByTestId("pick-left-0")).toBeInTheDocument();
    expect(screen.getByTestId("pick-right-2")).toBeInTheDocument();
  });

  it("pins a pair by clicking one record on each side and lists it", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("pick-left-1"));
    fireEvent.click(screen.getByTestId("pick-right-1"));

    const items = screen.getAllByTestId("anchor-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("left[1]");
    expect(items[0]).toHaveTextContent("right[1]");
    // The picked records are shown as used.
    expect(screen.getByTestId("pick-left-1")).toHaveAttribute("data-used", "true");
    expect(screen.getByTestId("pick-right-1")).toHaveAttribute("data-used", "true");
  });

  it("keeps a crossing pair and flags the first offending anchor", () => {
    render(<App />);
    // First valid anchor (1, 1).
    fireEvent.click(screen.getByTestId("pick-left-1"));
    fireEvent.click(screen.getByTestId("pick-right-1"));
    // Then pick left 2 ... and right 0 -> right must grow, so this crosses.
    fireEvent.click(screen.getByTestId("pick-left-2"));
    fireEvent.click(screen.getByTestId("pick-right-0"));

    // The crossing candidate is kept as a listed anchor, not dropped.
    const items = screen.getAllByTestId("anchor-item");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent("left[2]");
    expect(items[1]).toHaveTextContent("right[0]");
    // Both crossed records stay marked as pinned.
    expect(screen.getByTestId("pick-left-2")).toHaveAttribute("data-used", "true");
    expect(screen.getByTestId("pick-right-0")).toHaveAttribute("data-used", "true");
    // The first offending anchor is flagged beside its row and in the banner.
    expect(items[1]).toHaveClass("invalid");
    expect(items[0]).not.toHaveClass("invalid");
    expect(screen.getByTestId("anchor-error")).toBeInTheDocument();
    expect(screen.getByTestId("error-banner")).toBeInTheDocument();
    expect(screen.getByTestId("error-path").textContent).toContain("anchors[1].right");
    // No possibly-valid timeline appears.
    expect(screen.queryByTestId("result-panel")).toBeNull();
  });

  it("unflagging a crossing pair (via unpin) clears the error", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("pick-left-1"));
    fireEvent.click(screen.getByTestId("pick-right-1"));
    fireEvent.click(screen.getByTestId("pick-left-2"));
    fireEvent.click(screen.getByTestId("pick-right-0"));
    expect(screen.getByTestId("error-banner")).toBeInTheDocument();

    // Clicking a pinned record of the offending pair unpins the whole anchor.
    fireEvent.click(screen.getByTestId("pick-right-0"));
    expect(screen.getAllByTestId("anchor-item")).toHaveLength(1);
    expect(screen.queryByTestId("error-banner")).toBeNull();
    expect(screen.queryByTestId("anchor-error")).toBeNull();
  });

  it("resets a half-made selection when clearing and reloading the sample", () => {
    render(<App />);
    // Pick only a left record, then clear and reload the sample.
    fireEvent.click(screen.getByTestId("pick-left-0"));
    expect(screen.getByTestId("pick-left-0")).toHaveAttribute("data-selected", "true");
    fireEvent.click(screen.getByTestId("clear"));
    fireEvent.click(screen.getByTestId("sample"));

    // No pending selection survives: nothing is marked selected...
    expect(screen.getByTestId("pick-left-0")).toHaveAttribute("data-selected", "false");
    // ...and the next single pick starts a fresh pair instead of completing
    // one with the stale left record.
    fireEvent.click(screen.getByTestId("pick-right-1"));
    expect(screen.queryAllByTestId("anchor-item")).toHaveLength(0);
    expect(screen.getByTestId("pick-right-1")).toHaveAttribute("data-selected", "true");
  });

  it("places each timeline cell under its own header", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(anchoredBody));
    render(<App />);
    fireEvent.click(screen.getByTestId("pick-left-0"));
    fireEvent.click(screen.getByTestId("pick-right-0"));
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "#",
      "左侧口译员",
      "动作",
      "右侧口译员",
      "来源",
      "单步代价",
      "累计代价",
      "复算",
    ]);
    // First (anchor) row: the right note sits under 右侧口译员 and the
    // source tag under 来源 — not the other way around.
    const cells = screen
      .getAllByTestId("timeline-row")[0]
      .querySelectorAll("td");
    expect(cells[1]).toHaveTextContent("0 ms");
    expect(cells[3]).toHaveTextContent("150 ms");
    expect(cells[3]).toHaveTextContent("各位媒体朋友下午好");
    expect(cells[4]).toHaveTextContent("人工锚点");
    vi.unstubAllGlobals();
  });

  it("does not show a response that returns after the input changed", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ) as unknown as typeof fetch,
    );
    render(<App />);
    fireEvent.click(screen.getByTestId("submit"));

    // The notes change while the request is still in flight.
    fireEvent.change(screen.getByTestId("input-left"), {
      target: { value: "[]" },
    });
    // The stale response (computed from the pre-edit notes) arrives late.
    resolveFetch(
      new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("submit")).not.toBeDisabled(),
    );
    // The out-of-date timeline is not shown under the new input.
    expect(screen.queryByTestId("result-panel")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("does not show a stale 422 after the input changed mid-flight", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ) as unknown as typeof fetch,
    );
    render(<App />);
    fireEvent.click(screen.getByTestId("submit"));
    fireEvent.change(screen.getByTestId("input-left"), {
      target: { value: "[]" },
    });
    resolveFetch(
      new Response(
        JSON.stringify({ error: "未严格递增", path: "left[1].time" }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );

    await waitFor(() =>
      expect(screen.getByTestId("submit")).not.toBeDisabled(),
    );
    expect(screen.queryByTestId("error-banner")).toBeNull();
    expect(screen.queryByTestId("result-panel")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("sends anchors on submit, then shows anchor vs auto origins", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(anchoredBody));
    render(<App />);
    fireEvent.click(screen.getByTestId("pick-left-0"));
    fireEvent.click(screen.getByTestId("pick-right-0"));
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    const rows = screen.getAllByTestId("timeline-row");
    expect(rows[0]).toHaveAttribute("data-origin", "anchor");
    expect(rows[1]).toHaveAttribute("data-origin", "auto");
    const origins = screen.getAllByTestId("step-origin").map((el) => el.textContent);
    expect(origins).toEqual(["人工锚点", "算法生成", "算法生成", "算法生成"]);
    expect(screen.getByTestId("legend-anchors")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("omits anchors from the request when none are marked (legacy body)", async () => {
    let sentBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = init!.body as string;
        return new Response(JSON.stringify(okBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(<App />);
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    expect(sentBody).not.toContain("anchors");
    // Unanchored rows carry no provenance tag.
    expect(screen.queryAllByTestId("step-origin")).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("flags the offending anchor on a 422 and keeps inputs and markers", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce(
        { error: "锚点顺序交叉", path: "anchors[1].left" },
        422,
      ),
    );
    render(<App />);
    // Two markers are selected before submit.
    fireEvent.click(screen.getByTestId("pick-left-0"));
    fireEvent.click(screen.getByTestId("pick-right-0"));
    fireEvent.click(screen.getByTestId("pick-left-2"));
    fireEvent.click(screen.getByTestId("pick-right-2"));
    const leftBefore = (screen.getByTestId("input-left") as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("error-banner")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("error-path").textContent).toContain("anchors[1].left");
    // No possibly-valid timeline is shown.
    expect(screen.queryByTestId("result-panel")).toBeNull();
    // Both inputs and both selected markers survive.
    expect((screen.getByTestId("input-left") as HTMLTextAreaElement).value).toBe(
      leftBefore,
    );
    expect(screen.getAllByTestId("anchor-item")).toHaveLength(2);
    const items = screen.getAllByTestId("anchor-item");
    expect(items[1]).toHaveClass("invalid");
    expect(screen.getByTestId("anchor-error")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("unpinning an anchor removes it; resubmitting sends the rest", async () => {
    let sentBody = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = init!.body as string;
      return new Response(JSON.stringify(anchoredBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(screen.getByTestId("pick-left-0"));
    fireEvent.click(screen.getByTestId("pick-right-0"));
    expect(screen.getAllByTestId("anchor-item")).toHaveLength(1);

    // Remove via the row's cancel button.
    fireEvent.click(screen.getByTestId("anchor-remove-0"));
    expect(screen.queryAllByTestId("anchor-item")).toHaveLength(0);
    expect(screen.getByTestId("anchor-empty")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    // Cancelling every anchor restores the original (anchor-free) request.
    expect(sentBody).not.toContain("anchors");
    vi.unstubAllGlobals();
  });

  it("clears anchors when loading the sample or clearing", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("pick-left-0"));
    fireEvent.click(screen.getByTestId("pick-right-0"));
    expect(screen.getAllByTestId("anchor-item")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("clear"));
    expect(screen.queryAllByTestId("anchor-item")).toHaveLength(0);
    // Empty arrays leave no pickable records.
    expect(screen.queryByTestId("pick-left-0")).toBeNull();
  });

  // ------------------------------------------------------------------ //
  // Strictly second-best ("compare alternative") path.
  // ------------------------------------------------------------------ //

  it("compare checkbox defaults off and adds no request field", async () => {
    let sentBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = init!.body as string;
        return new Response(JSON.stringify(okBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(<App />);
    const toggle = screen.getByTestId("compare-alternative") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    expect(sentBody).not.toContain("compare_alternative");
    // Legacy response: no alternative summary and no unique-path notice.
    expect(screen.queryByTestId("alternative-summary")).toBeNull();
    expect(screen.queryByTestId("alternative-empty")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("sends compare_alternative when checked and shows the equal-cost alt", async () => {
    let sentBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = init!.body as string;
        return new Response(JSON.stringify(compareBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(<App />);
    fireEvent.click(screen.getByTestId("compare-alternative"));
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("alternative-summary")).toBeInTheDocument(),
    );
    expect(sentBody).toContain('"compare_alternative":true');
    // Primary timeline stays the 4-row body of the page.
    expect(screen.getAllByTestId("timeline-row")).toHaveLength(4);
    // Equal-cost runner-up: total 4250, gap 0, deterministic tie note.
    expect(screen.getByTestId("alternative-total").textContent!.trim()).toBe("4250");
    expect(screen.getByTestId("alternative-diff").textContent!.trim()).toBe("0");
    expect(screen.getByTestId("alternative-summary").textContent).toContain(
      "平局规则",
    );
    // First divergence: left side blank, right[2].
    expect(screen.getByTestId("alternative-divergence").textContent).toContain(
      "left[∅]",
    );
    expect(screen.getByTestId("alternative-divergence").textContent).toContain(
      "right[2]",
    );
    // Exactly one expansion row, placed right after primary row #3 (idx 2),
    // and it shows the alternative's left-gap pairing of right[2].
    const altRows = screen.getAllByTestId("alternative-row");
    expect(altRows).toHaveLength(1);
    expect(altRows[0].getAttribute("data-row")).toBe("2");
    expect(altRows[0].textContent).toContain("交接后的补充记录");
    expect(altRows[0].textContent).toContain("成本差 +0");
    // The primary divergence row is marked.
    expect(screen.getAllByTestId("timeline-row")[2]).toHaveClass(
      "row-divergence",
    );
    vi.unstubAllGlobals();
  });

  it("shows a strictly costlier alt with the gap and first row divergence", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(strictGapBody));
    render(<App />);
    fireEvent.click(screen.getByTestId("compare-alternative"));
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("alternative-summary")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("alternative-total").textContent!.trim()).toBe("8000");
    expect(screen.getByTestId("alternative-diff").textContent!.trim()).toBe("1000");
    expect(screen.getByTestId("alternative-divergence").textContent).toContain(
      "left[0]",
    );
    expect(screen.getByTestId("alternative-divergence").textContent).toContain(
      "right[0]",
    );
    // Expansion under the very first primary row.
    const altRow = screen.getByTestId("alternative-row");
    expect(altRow.getAttribute("data-row")).toBe("0");
    expect(altRow.textContent).toContain("成本差 +1000");
    expect(altRow.textContent).toContain("配对");
    vi.unstubAllGlobals();
  });

  it("shows the unique-path notice while still displaying the optimum", async () => {
    const uniqueBody = {
      steps: [],
      total_cost: 0,
      counts: { match: 0, left_gap: 0, right_gap: 0 },
      costs: { gap: 2000, mismatch_penalty: 3000 },
      alternative: null,
    };
    vi.stubGlobal("fetch", mockFetchOnce(uniqueBody));
    render(<App />);
    fireEvent.click(screen.getByTestId("compare-alternative"));
    // Start from the empty-input state for a genuinely unique path.
    fireEvent.click(screen.getByTestId("clear"));
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("alternative-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("alternative-summary")).toBeNull();
    expect(screen.queryByTestId("alternative-row")).toBeNull();
    // The optimal (empty) result is still shown normally.
    expect(screen.getByTestId("result-panel")).toBeInTheDocument();
    expect(screen.getByTestId("total-cost").textContent).toBe("0");
    vi.unstubAllGlobals();
  });

  it("toggling the compare switch drops a stale result", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(compareBody));
    render(<App />);
    fireEvent.click(screen.getByTestId("compare-alternative"));
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("alternative-summary")).toBeInTheDocument(),
    );
    // Unchecking must not leave the old comparison on screen.
    fireEvent.click(screen.getByTestId("compare-alternative"));
    expect(screen.queryByTestId("result-panel")).toBeNull();
    expect(screen.queryByTestId("alternative-summary")).toBeNull();
    vi.unstubAllGlobals();
  });
});

// Term-aware alignment: a lead-declared synonym correspondence waives the
// mismatch penalty on exact hits, marked in the timeline as "术语等价".
const termBody = {
  steps: [
    {
      action: "match",
      left: { time: 0, text: "人工智能" },
      right: { time: 100, text: "AI" },
      cost: 100,
      cumulative_cost: 100,
      term_pair: { left_text: "人工智能", right_text: "AI" },
    },
    {
      action: "match",
      left: { time: 9000, text: "结束语" },
      right: { time: 9200, text: "结束语" },
      cost: 200,
      cumulative_cost: 300,
    },
  ],
  total_cost: 300,
  counts: { match: 2, left_gap: 0, right_gap: 0 },
  costs: { gap: 2000, mismatch_penalty: 3000 },
  term_pairs: [{ left_text: "人工智能", right_text: "AI" }],
};

const termNotes = {
  left: [
    { time: 0, text: "人工智能" },
    { time: 9000, text: "结束语" },
  ],
  right: [
    { time: 100, text: "AI" },
    { time: 9200, text: "结束语" },
  ],
};

describe("App: term pairs", () => {
  it("renders the term panel with an empty state", () => {
    render(<App />);
    expect(screen.getByTestId("term-panel")).toBeInTheDocument();
    expect(screen.getByTestId("term-empty")).toBeInTheDocument();
    expect(screen.queryAllByTestId("term-item")).toHaveLength(0);
  });

  it("adds a term pair from the two inputs and removes it", () => {
    render(<App />);
    fireEvent.change(screen.getByTestId("term-input-left"), {
      target: { value: " 人工智能 " },
    });
    fireEvent.change(screen.getByTestId("term-input-right"), {
      target: { value: "AI" },
    });
    fireEvent.click(screen.getByTestId("term-add"));

    const items = screen.getAllByTestId("term-item");
    expect(items).toHaveLength(1);
    // Drafts are trimmed when stored and cleared after adding.
    expect(items[0]).toHaveTextContent("人工智能");
    expect(items[0]).toHaveTextContent("AI");
    expect((screen.getByTestId("term-input-left") as HTMLInputElement).value).toBe(
      "",
    );

    fireEvent.click(screen.getByTestId("term-remove-0"));
    expect(screen.queryAllByTestId("term-item")).toHaveLength(0);
    expect(screen.getByTestId("term-empty")).toBeInTheDocument();
  });

  it("keeps a conflicting term pair and flags the first conflict once", () => {
    render(<App />);
    const add = (l: string, r: string) => {
      fireEvent.change(screen.getByTestId("term-input-left"), {
        target: { value: l },
      });
      fireEvent.change(screen.getByTestId("term-input-right"), {
        target: { value: r },
      });
      fireEvent.click(screen.getByTestId("term-add"));
    };
    add("人工智能", "AI");
    add("人工智能", "机器学习");

    const items = screen.getAllByTestId("term-item");
    // The conflicting candidate is kept, not silently dropped.
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveClass("invalid");
    expect(items[0]).not.toHaveClass("invalid");
    expect(screen.getByTestId("term-error")).toBeInTheDocument();
    expect(screen.getByTestId("error-path").textContent).toContain(
      "term_pairs[1].left_text",
    );
    // Exactly one banner.
    expect(screen.getAllByTestId("error-banner")).toHaveLength(1);
    // No possibly-valid timeline.
    expect(screen.queryByTestId("result-panel")).toBeNull();

    // Removing the offending pair clears the flag.
    fireEvent.click(screen.getByTestId("term-remove-1"));
    expect(screen.queryByTestId("error-banner")).toBeNull();
    expect(screen.queryByTestId("term-error")).toBeNull();
  });

  it("blocks submit locally on a term conflict without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<App />);
    const add = (l: string, r: string) => {
      fireEvent.change(screen.getByTestId("term-input-left"), {
        target: { value: l },
      });
      fireEvent.change(screen.getByTestId("term-input-right"), {
        target: { value: r },
      });
      fireEvent.click(screen.getByTestId("term-add"));
    };
    add("a", "x");
    add("a", "y");
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("error-banner")).toBeInTheDocument(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-path").textContent).toContain(
      "term_pairs[1].left_text",
    );
    vi.unstubAllGlobals();
  });

  it("sends term_pairs and shows the 术语等价 source and replay formula", async () => {
    let sentBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = init!.body as string;
        return new Response(JSON.stringify(termBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByTestId("input-left"), {
      target: { value: JSON.stringify(termNotes.left) },
    });
    fireEvent.change(screen.getByTestId("input-right"), {
      target: { value: JSON.stringify(termNotes.right) },
    });
    fireEvent.change(screen.getByTestId("term-input-left"), {
      target: { value: "人工智能" },
    });
    fireEvent.change(screen.getByTestId("term-input-right"), {
      target: { value: "AI" },
    });
    fireEvent.click(screen.getByTestId("term-add"));
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    expect(sentBody).toContain(
      `"term_pairs":[{"left_text":"人工智能","right_text":"AI"}]`,
    );

    const rows = screen.getAllByTestId("timeline-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-term-hit", "true");
    expect(rows[1]).toHaveAttribute("data-term-hit", "false");
    const termTags = screen.getAllByTestId("step-term");
    expect(termTags).toHaveLength(1);
    expect(termTags[0].textContent).toBe("术语等价");
    // The non-hit equal-text row keeps the ordinary dash source.
    expect(screen.queryAllByTestId("step-origin")).toHaveLength(0);
    // Waived penalty: cost 100, replay formula states the equivalence.
    expect(screen.getAllByTestId("step-cost")[0].textContent).toBe("100");
    expect(screen.getAllByTestId("step-explain")[0].textContent).toMatch(
      /术语等价/,
    );
    expect(screen.getByTestId("legend-terms")).toBeInTheDocument();
    expect(screen.getByTestId("total-cost").textContent).toBe("300");
    vi.unstubAllGlobals();
  });

  it("omits term_pairs from the request when all pairs are deleted", async () => {
    let sentBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sentBody = init!.body as string;
        return new Response(JSON.stringify(okBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByTestId("term-input-left"), {
      target: { value: "人工智能" },
    });
    fireEvent.change(screen.getByTestId("term-input-right"), {
      target: { value: "AI" },
    });
    fireEvent.click(screen.getByTestId("term-add"));
    expect(screen.getAllByTestId("term-item")).toHaveLength(1);
    // Delete every term pair: the legacy request must be restored.
    fireEvent.click(screen.getByTestId("term-remove-0"));
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    expect(sentBody).not.toContain("term_pairs");
    // Unmarked rows carry no term source.
    expect(screen.queryAllByTestId("step-term")).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("keeps notes and term rows on a term 422 and flags the conflict row", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce(
        {
          error: "同一侧术语不可重复对应。",
          path: "term_pairs[1].left_text",
        },
        422,
      ),
    );
    render(<App />);
    // Two locally-valid pairs (the server-side conflict simulates a race).
    for (const [l, r] of [
      ["a", "x"],
      ["b", "y"],
    ]) {
      fireEvent.change(screen.getByTestId("term-input-left"), {
        target: { value: l },
      });
      fireEvent.change(screen.getByTestId("term-input-right"), {
        target: { value: r },
      });
      fireEvent.click(screen.getByTestId("term-add"));
    }
    const leftBefore = (screen.getByTestId("input-left") as HTMLTextAreaElement)
      .value;
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("error-banner")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("error-path").textContent).toContain(
      "term_pairs[1].left_text",
    );
    // Inputs and both term rows are preserved; no new timeline is shown.
    expect((screen.getByTestId("input-left") as HTMLTextAreaElement).value).toBe(
      leftBefore,
    );
    expect(screen.getAllByTestId("term-item")).toHaveLength(2);
    expect(screen.getAllByTestId("term-item")[1]).toHaveClass("invalid");
    expect(screen.getByTestId("term-error")).toBeInTheDocument();
    expect(screen.queryByTestId("result-panel")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("sends anchors, term pairs and compare together and marks term alt rows", async () => {
    // Distant term-equivalent notes: the optimum gaps both sides (4000),
    // while the strict runner-up is the synonym match (9000), so the single
    // expansion row under primary row 0 is a term-hit pairing.
    const notes = {
      left: [{ time: 0, text: "人工智能" }],
      right: [{ time: 9000, text: "AI" }],
    };
    const body = {
      steps: [
        {
          action: "right_gap",
          left: { time: 0, text: "人工智能" },
          right: null,
          cost: 2000,
          cumulative_cost: 2000,
        },
        {
          action: "left_gap",
          left: null,
          right: { time: 9000, text: "AI" },
          cost: 2000,
          cumulative_cost: 4000,
        },
      ],
      total_cost: 4000,
      counts: { match: 0, left_gap: 1, right_gap: 1 },
      costs: { gap: 2000, mismatch_penalty: 3000 },
      term_pairs: [{ left_text: "人工智能", right_text: "AI" }],
      alternative: {
        steps: [
          {
            action: "match",
            left: { time: 0, text: "人工智能" },
            right: { time: 9000, text: "AI" },
            cost: 9000,
            cumulative_cost: 9000,
            term_pair: { left_text: "人工智能", right_text: "AI" },
          },
        ],
        total_cost: 9000,
        cost_diff: 5000,
        first_divergence: { left: 0, right: 0 },
      },
    };
    vi.stubGlobal("fetch", mockFetchOnce(body));
    render(<App />);
    fireEvent.change(screen.getByTestId("input-left"), {
      target: { value: JSON.stringify(notes.left) },
    });
    fireEvent.change(screen.getByTestId("input-right"), {
      target: { value: JSON.stringify(notes.right) },
    });
    fireEvent.change(screen.getByTestId("term-input-left"), {
      target: { value: "人工智能" },
    });
    fireEvent.change(screen.getByTestId("term-input-right"), {
      target: { value: "AI" },
    });
    fireEvent.click(screen.getByTestId("term-add"));
    fireEvent.click(screen.getByTestId("compare-alternative"));
    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() =>
      expect(screen.getByTestId("alternative-summary")).toBeInTheDocument(),
    );
    // The primary timeline carries no term tag (both rows are gaps), and the
    // single expansion row for the strict runner-up carries the term source.
    expect(screen.queryAllByTestId("step-term")).toHaveLength(0);
    expect(screen.getByTestId("alternative-step-term")).toHaveTextContent(
      "术语等价",
    );
    expect(screen.getByTestId("alternative-row-gap").textContent).toContain(
      "成本差 +5000",
    );
    vi.unstubAllGlobals();
  });

  it("keeps the last valid timeline when a conflicting term pair is added", async () => {
    const fetchMock = mockFetchOnce(termBody);
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.change(screen.getByTestId("input-left"), {
      target: { value: JSON.stringify(termNotes.left) },
    });
    fireEvent.change(screen.getByTestId("input-right"), {
      target: { value: JSON.stringify(termNotes.right) },
    });
    const add = (l: string, r: string) => {
      fireEvent.change(screen.getByTestId("term-input-left"), {
        target: { value: l },
      });
      fireEvent.change(screen.getByTestId("term-input-right"), {
        target: { value: r },
      });
      fireEvent.click(screen.getByTestId("term-add"));
    };
    add("人工智能", "AI");
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("total-cost").textContent).toBe("300");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Adding a conflicting (duplicate left_text) pair after a valid timeline
    // is shown must NOT replace the timeline: it stays on screen while the
    // single conflict is flagged in the banner and beside the offending row.
    add("人工智能", "机器学习");
    expect(screen.getByTestId("result-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("timeline-row")).toHaveLength(2);
    expect(screen.getByTestId("total-cost").textContent).toBe("300");
    expect(screen.getByTestId("error-path").textContent).toContain(
      "term_pairs[1].left_text",
    );
    expect(screen.getAllByTestId("term-item")[1]).toHaveClass("invalid");

    // Submitting while the conflict is present is blocked locally: no new
    // request, and the previous timeline is still displayed.
    fireEvent.click(screen.getByTestId("submit"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("result-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("timeline-row")).toHaveLength(2);

    // Removing the offending pair clears the conflict while the (last valid)
    // timeline remains on screen for the lead to read.
    fireEvent.click(screen.getByTestId("term-remove-1"));
    expect(screen.queryByTestId("error-banner")).toBeNull();
    expect(screen.getByTestId("result-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("timeline-row")).toHaveLength(2);
    expect(screen.getAllByTestId("term-item")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("adding a valid term pair before resubmitting also keeps the prior timeline", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(termBody));
    render(<App />);
    fireEvent.change(screen.getByTestId("input-left"), {
      target: { value: JSON.stringify(termNotes.left) },
    });
    fireEvent.change(screen.getByTestId("input-right"), {
      target: { value: JSON.stringify(termNotes.right) },
    });
    // A first run without any term pair shows a (mocked) timeline.
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() =>
      expect(screen.getByTestId("result-panel")).toBeInTheDocument(),
    );
    // Declaring an additional, non-conflicting correspondence is a
    // pre-submission edit: it must not discard the displayed timeline.
    fireEvent.change(screen.getByTestId("term-input-left"), {
      target: { value: "机器学习" },
    });
    fireEvent.change(screen.getByTestId("term-input-right"), {
      target: { value: "ML" },
    });
    fireEvent.click(screen.getByTestId("term-add"));
    expect(screen.queryByTestId("error-banner")).toBeNull();
    expect(screen.getByTestId("result-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("term-item")).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
