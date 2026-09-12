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
      left: null,
      right: { time: 12000, text: "交接后的补充记录" },
      cost: 2000,
      cumulative_cost: 2250,
    },
    {
      action: "left_gap",
      left: { time: 9000, text: "感谢各位的提问" },
      right: null,
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
});
