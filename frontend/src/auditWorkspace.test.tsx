import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

const auditOkBody = {
  ok: true,
  total_cost: 4250,
  counts: { match: 2, left_gap: 1, right_gap: 1 },
  consumed: { left: 3, right: 3 },
  steps: [
    {
      index: 0,
      action: "match",
      expected_cost: 150,
      actual_cost: 150,
      expected_cumulative_cost: 150,
      actual_cumulative_cost: 150,
      consumed: { left: 0, right: 0 },
      basis: "相同文本：|0 − 150| = 150",
      origin: null,
      expected_term_pair: null,
    },
    {
      index: 1,
      action: "match",
      expected_cost: 100,
      actual_cost: 100,
      expected_cumulative_cost: 250,
      actual_cumulative_cost: 250,
      consumed: { left: 1, right: 1 },
      basis: "相同文本：|4200 − 4100| = 100",
      origin: null,
      expected_term_pair: null,
    },
    {
      index: 2,
      action: "right_gap",
      expected_cost: 2000,
      actual_cost: 2000,
      expected_cumulative_cost: 2250,
      actual_cumulative_cost: 2250,
      consumed: { left: 2, right: null },
      basis: "单侧留空 = 2000",
      origin: null,
      expected_term_pair: null,
    },
    {
      index: 3,
      action: "left_gap",
      expected_cost: 2000,
      actual_cost: 2000,
      expected_cumulative_cost: 4250,
      actual_cumulative_cost: 4250,
      consumed: { left: null, right: 2 },
      basis: "单侧留空 = 2000",
      origin: null,
      expected_term_pair: null,
    },
  ],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function routeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request to ${url}`);
    return routes[key](init);
  }) as unknown as typeof fetch;
}

async function alignAndFill(routes: Record<string, (init?: RequestInit) => Response>) {
  vi.stubGlobal("fetch", routeFetch(routes));
  render(<App />);
  fireEvent.click(screen.getByTestId("submit"));
  await waitFor(() => expect(screen.getByTestId("result-panel")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("audit-fill"));
  await waitFor(() =>
    expect((screen.getByTestId("audit-input") as HTMLTextAreaElement).value).toContain(
      '"steps"',
    ),
  );
}

describe("audit workspace", () => {
  it("is present with its own paste box and controls", () => {
    render(<App />);
    expect(screen.getByTestId("audit-panel")).toBeInTheDocument();
    expect(screen.getByTestId("audit-input")).toBeInTheDocument();
    expect(screen.getByTestId("audit-submit")).toBeInTheDocument();
    // Nothing to fill from before the first alignment.
    expect(screen.getByTestId("audit-fill")).toBeDisabled();
  });

  it("passes a legal candidate and shows the conclusion plus row details", async () => {
    await alignAndFill({
      "/api/align": () => json(okBody),
      "/api/audit": () => json(auditOkBody),
    });
    fireEvent.click(screen.getByTestId("audit-submit"));

    const pass = await screen.findByTestId("audit-pass");
    expect(pass).toBeInTheDocument();
    expect(screen.getByTestId("audit-pass-summary").textContent).toContain(
      "完整、按序且只使用一次",
    );
    expect(screen.getByTestId("audit-total-cost")).toHaveTextContent("4250");
    const rows = screen.getAllByTestId("audit-detail-row");
    expect(rows).toHaveLength(4);
    expect(screen.getAllByTestId("audit-detail-cost").map((e) => e.textContent)).toEqual([
      "150",
      "100",
      "2000",
      "2000",
    ]);
    expect(
      screen.getAllByTestId("audit-detail-cumulative").map((e) => e.textContent),
    ).toEqual(["150", "250", "2250", "4250"]);
    expect(screen.getAllByTestId("audit-detail-basis")[2]).toHaveTextContent(
      "单侧留空 = 2000",
    );
    // No failure banner on a pass.
    expect(screen.queryByTestId("audit-error-banner")).toBeNull();
  });

  it("fills the candidate box from the current optimal timeline", async () => {
    await alignAndFill({
      "/api/align": () => json(okBody),
      "/api/audit": () => json(auditOkBody),
    });
    const text = (screen.getByTestId("audit-input") as HTMLTextAreaElement).value;
    const parsed = JSON.parse(text);
    expect(parsed.steps).toHaveLength(4);
    expect(parsed.total_cost).toBe(4250);
    expect(parsed.steps[2]).toMatchObject({
      action: "right_gap",
      right: null,
      cost: 2000,
    });
  });

  it("localizes a wrong single-step cost, keeps the paste and the last passing report", async () => {
    await alignAndFill({
      "/api/align": () => json(okBody),
      "/api/audit": (init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        // Pass on the first (filled) candidate, reject the edited one.
        if (body.candidate.steps[2].cost === 9999) {
          return json(
            {
              error: "单步代价与按当前规则复算的结果不一致。",
              path: "candidate.steps[2].cost",
              expected: 2000,
              actual: 9999,
            },
            422,
          );
        }
        return json(auditOkBody);
      },
    });
    fireEvent.click(screen.getByTestId("audit-submit"));
    await screen.findByTestId("audit-pass");

    // Edit the pasted candidate: row 3 (index 2) gets a wrong cost.
    const before = (screen.getByTestId("audit-input") as HTMLTextAreaElement).value;
    const edited = before.replace('"cost":2000', '"cost":9999');
    expect(edited).not.toBe(before);
    fireEvent.change(screen.getByTestId("audit-input"), { target: { value: edited } });
    fireEvent.click(screen.getByTestId("audit-submit"));

    const banner = await screen.findByTestId("audit-error-banner");
    expect(banner).toBeInTheDocument();
    expect(screen.getByTestId("audit-error-path").textContent).toContain(
      "candidate.steps[2].cost",
    );
    expect(screen.getByTestId("audit-expected")).toHaveTextContent("2000");
    expect(screen.getByTestId("audit-actual")).toHaveTextContent("9999");

    // The pasted text is retained verbatim.
    expect((screen.getByTestId("audit-input") as HTMLTextAreaElement).value).toBe(
      edited,
    );
    // The corresponding candidate row (#3, index 2) is flagged and scrolled to.
    const flagged = screen
      .getAllByTestId("audit-candidate-row")
      .find((r) => r.getAttribute("data-row") === "2");
    expect(flagged).toHaveClass(/invalid/);
    expect(flagged!).toContainElement(screen.getByTestId("audit-row-flag"));
    // The last PASSING report is NOT replaced by the failed verification.
    expect(screen.getByTestId("audit-pass")).toBeInTheDocument();
  });

  it("localizes a missing original note (path past the last candidate row)", async () => {
    await alignAndFill({
      "/api/align": () => json(okBody),
      "/api/audit": () => json(auditOkBody),
    });
    // Drop the trailing left_gap row from the pasted candidate.
    const full = JSON.parse(
      (screen.getByTestId("audit-input") as HTMLTextAreaElement).value,
    );
    full.steps.pop();
    fireEvent.change(screen.getByTestId("audit-input"), {
      target: { value: JSON.stringify(full) },
    });

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/api/align": () => json(okBody),
        "/api/audit": () =>
          json(
            {
              error: "原始右侧笔记 right[2] 未出现在候选时间轴中（原始笔记遗漏）。",
              path: "candidate.steps[3]",
              expected: { time: 12000, text: "交接后的补充记录" },
              actual: null,
            },
            422,
          ),
      }),
    );

    fireEvent.click(screen.getByTestId("audit-submit"));
    await screen.findByTestId("audit-error-banner");
    expect(screen.getByTestId("audit-error-path").textContent).toContain(
      "candidate.steps[3]",
    );
    expect(screen.getByTestId("audit-expected")).toHaveTextContent("交接后的补充记录");
    // Three preview rows, none corresponding to index 3, so no row is flagged.
    const rows = screen.getAllByTestId("audit-candidate-row");
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.className.includes("invalid"))).toBe(false);
  });

  it("blocks malformed candidate JSON locally without calling the server", async () => {
    const fetchMock = vi.fn(async () => json(auditOkBody));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<App />);
    fireEvent.change(screen.getByTestId("audit-input"), {
      target: { value: '{"steps": [,]}' },
    });
    fireEvent.click(screen.getByTestId("audit-submit"));
    const banner = await screen.findByTestId("audit-error-banner");
    expect(banner).toHaveTextContent("无法解析");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a structurally invalid candidate locally", async () => {
    const fetchMock = vi.fn(async () => json(auditOkBody));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    render(<App />);
    fireEvent.change(screen.getByTestId("audit-input"), {
      target: {
        value: JSON.stringify({
          steps: [
            {
              action: "match",
              left: { time: 0, text: "a" },
              right: { time: 1, text: "a" },
              cost: 1,
              cumulative_cost: 1,
            },
            {
              action: "delete",
              left: null,
              right: null,
              cost: 0,
              cumulative_cost: 1,
            },
          ],
          total_cost: 1,
        }),
      },
    });
    fireEvent.click(screen.getByTestId("audit-submit"));
    await screen.findByTestId("audit-error-banner");
    expect(screen.getByTestId("audit-error-path").textContent).toContain(
      "candidate.steps[1].action",
    );
    // The bad candidate row is the one flagged in the preview.
    const flagged = screen
      .getAllByTestId("audit-candidate-row")
      .find((r) => r.getAttribute("data-row") === "1");
    expect(flagged).toHaveClass(/invalid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the current anchors with the audit request", async () => {
    const bodies: string[] = [];
    const anchored = {
      ...okBody,
      steps: okBody.steps.map((s, k) => ({ ...s, origin: k === 0 ? "anchor" : "auto" })),
      anchors: [{ left: 0, right: 0 }],
    };
    await alignAndFill({
      "/api/align": (init?: RequestInit) => {
        bodies.push(init!.body as string);
        return json(anchored);
      },
      "/api/audit": (init?: RequestInit) => {
        bodies.push(init!.body as string);
        return json({ ...auditOkBody, anchors: [{ left: 0, right: 0 }] });
      },
    });
    // alignAndFill did not select anchors itself; mark one now and re-align.
    fireEvent.click(screen.getByTestId("pick-left-0"));
    fireEvent.click(screen.getByTestId("pick-right-0"));
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() => expect(screen.getByTestId("anchor-item")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("audit-fill"));
    fireEvent.click(screen.getByTestId("audit-submit"));
    await screen.findByTestId("audit-pass");
    const auditBody = bodies.find((b) => b.includes("/api/audit") || b.includes('"candidate"'))!;
    expect(auditBody).toContain('"anchors":[{"left":0,"right":0}]');
    expect(auditBody).toContain('"candidate"');
  });

  it("retires the passing report when the notes change after verification", async () => {
    await alignAndFill({
      "/api/align": () => json(okBody),
      "/api/audit": () => json(auditOkBody),
    });
    fireEvent.click(screen.getByTestId("audit-submit"));
    await screen.findByTestId("audit-pass");

    fireEvent.change(screen.getByTestId("input-left"), {
      target: { value: JSON.stringify([{ time: 1, text: "改了笔记" }]) },
    });
    await waitFor(() => expect(screen.queryByTestId("audit-pass")).toBeNull());
    // The pasted candidate itself is retained.
    expect((screen.getByTestId("audit-input") as HTMLTextAreaElement).value).toContain(
      '"steps"',
    );
  });
});
