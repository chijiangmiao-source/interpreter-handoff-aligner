import { describe, expect, it, vi } from "vitest";
import { alignNotes, auditNotes, AlignRequestError, rootRawText } from "./api";

const alignedBody = {
  steps: [
    {
      action: "match",
      left: { time: 1, text: "a" },
      right: { time: 2, text: "a" },
      cost: 1,
      cumulative_cost: 1,
    },
  ],
  total_cost: 1,
  counts: { match: 1, left_gap: 0, right_gap: 0 },
  costs: { gap: 2000, mismatch_penalty: 3000 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("rootRawText", () => {
  it("extracts the root value without surrounding whitespace", () => {
    expect(rootRawText(`  [1, 2]  `)).toBe("[1, 2]");
  });

  it("keeps large integer digits verbatim", () => {
    const raw = `[{"time": 9007199254740993, "text": "a"}]`;
    expect(rootRawText(raw)).toContain("9007199254740993");
  });
});

describe("alignNotes", () => {
  it("posts the raw array texts and returns the parsed result", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => jsonResponse(alignedBody),
    );
    const result = await alignNotes(
      `[{"time":1,"text":"a"}]`,
      `[{"time":2,"text":"a"}]`,
      fetchMock as unknown as typeof fetch,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/align");
    expect(init!.method).toBe("POST");
    // Body embeds the exact raw digits (no re-serialization/rounding).
    expect(init!.body).toBe(
      `{"left":[{"time":1,"text":"a"}],"right":[{"time":2,"text":"a"}]}`,
    );
    expect(result.total_cost).toBe(1n);
    expect(result.steps[0].cumulative_cost).toBe(1n);
  });

  it("forwards huge integer literals without rounding", async () => {
    let sentBody = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = init!.body as string;
      return jsonResponse({
        steps: [
          {
            action: "match",
            left: { time: 9007199254740993, text: "a" },
            right: { time: 9007199254740995, text: "a" },
            cost: 2,
            cumulative_cost: 2,
          },
        ],
        total_cost: 2,
        counts: { match: 1, left_gap: 0, right_gap: 0 },
        costs: { gap: 2000, mismatch_penalty: 3000 },
      });
    });
    await alignNotes(
      rootRawText(`[{"time": 9007199254740993, "text": "a"}]`),
      rootRawText(`[{"time": 9007199254740995, "text": "a"}]`),
      fetchMock as unknown as typeof fetch,
    );
    expect(sentBody).toContain("9007199254740993");
    expect(sentBody).toContain("9007199254740995");
  });

  it("omits anchors entirely when none are given (legacy request body)", async () => {
    let sentBody = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = init!.body as string;
      return jsonResponse(alignedBody);
    });
    await alignNotes("[]", "[]", fetchMock as unknown as typeof fetch);
    expect(sentBody).toBe(`{"left":[],"right":[]}`);
    expect(sentBody).not.toContain("anchors");

    // Explicit undefined behaves the same.
    await alignNotes("[]", "[]", fetchMock as unknown as typeof fetch, undefined);
    expect(sentBody).toBe(`{"left":[],"right":[]}`);
  });

  it("sends the anchors array when provided, including an empty list", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init!.body as string);
      return jsonResponse({ ...alignedBody, anchors: [{ left: 0, right: 1 }] });
    });
    await alignNotes(
      `[{"time":1,"text":"a"}]`,
      `[{"time":2,"text":"a"}]`,
      fetchMock as unknown as typeof fetch,
      [{ left: 0, right: 1 }],
    );
    expect(bodies[0]).toBe(
      `{"left":[{"time":1,"text":"a"}],"right":[{"time":2,"text":"a"}],"anchors":[{"left":0,"right":1}]}`,
    );

    // An empty (but present) list is forwarded and still switches on anchors.
    await alignNotes("[]", "[]", fetchMock as unknown as typeof fetch, []);
    expect(bodies[1]).toBe(`{"left":[],"right":[],"anchors":[]}`);
  });

  it("omits compare_alternative unless the option is true (legacy bytes)", async () => {    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init!.body as string);
      return jsonResponse(alignedBody);
    });
    const f = fetchMock as unknown as typeof fetch;
    await alignNotes("[]", "[]", f, undefined, false);
    expect(bodies[0]).toBe(`{"left":[],"right":[]}`);
    expect(bodies[0]).not.toContain("compare_alternative");
    // Default argument behaves like false.
    await alignNotes("[]", "[]", f);
    expect(bodies[1]).toBe(`{"left":[],"right":[]}`);
    // With anchors + compare: both fragments, anchors first, compare last.
    await alignNotes("[]", "[]", f, [{ left: 0, right: 0 }], true);
    expect(bodies[2]).toBe(
      `{"left":[],"right":[],"anchors":[{"left":0,"right":0}],"compare_alternative":true}`,
    );
    // Compare on without anchors.
    await alignNotes(`[{"time":1,"text":"a"}]`, "[]", f, undefined, true);
    expect(bodies[3]).toBe(
      `{"left":[{"time":1,"text":"a"}],"right":[],"compare_alternative":true}`,
    );
  });

  it("parses and normalizes the alternative payload (incl. bigint indices)", async () => {
    const body = {
      steps: [
        {
          action: "right_gap",
          left: { time: 1, text: "a" },
          right: null,
          cost: 2000,
          cumulative_cost: 2000,
        },
      ],
      total_cost: 4000,
      counts: { match: 0, left_gap: 1, right_gap: 1 },
      costs: { gap: 2000, mismatch_penalty: 3000 },
      alternative: {
        steps: [
          {
            action: "match",
            left: { time: 1, text: "a" },
            right: { time: 2, text: "b" },
            cost: 3001,
            cumulative_cost: 3001,
          },
        ],
        total_cost: 3001,
        cost_diff: 0,
        first_divergence: { left: 0, right: null },
      },
    };
    const result = await alignNotes(
      "[]",
      "[]",
      vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch,
      undefined,
      true,
    );
    expect(result.alternative).not.toBeNull();
    // Numeric literals arrive as bigint through the located parser; the
    // divergence indices are normalized back to plain numbers (null kept).
    expect(result.alternative!.first_divergence).toEqual({
      left: 0,
      right: null,
    });
    expect(typeof result.alternative!.first_divergence.left).toBe("number");
    expect(result.alternative!.total_cost).toBe(3001n);
    expect(result.alternative!.cost_diff).toBe(0n);
  });

  it("keeps a null alternative as null (unique legal path)", async () => {
    const body = {
      steps: [],
      total_cost: 0,
      counts: { match: 0, left_gap: 0, right_gap: 0 },
      costs: { gap: 2000, mismatch_penalty: 3000 },
      alternative: null,
    };
    const result = await alignNotes(
      "[]",
      "[]",
      vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch,
      undefined,
      true,
    );
    expect(result.alternative).toBeNull();
  });

  it("returns the echoed anchors and per-row origin", async () => {
    const body = {
      steps: [
        {
          action: "match",
          left: { time: 1, text: "a" },
          right: { time: 2, text: "a" },
          cost: 1,
          cumulative_cost: 1,
          origin: "anchor",
        },
      ],
      total_cost: 1,
      counts: { match: 1, left_gap: 0, right_gap: 0 },
      anchors: [{ left: 0, right: 0 }],
      costs: { gap: 2000, mismatch_penalty: 3000 },
    };
    const result = await alignNotes(
      "[]",
      "[]",
      vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch,
      [{ left: 0, right: 0 }],
    );
    expect(result.anchors).toEqual([{ left: 0, right: 0 }]);
    expect(result.steps[0].origin).toBe("anchor");
  });

  it("surfaces a single anchor error path on 422", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "锚点交叉", path: "anchors[1].left" }, 422),
    );
    await expect(
      alignNotes(
        "[]",
        "[]",
        fetchMock as unknown as typeof fetch,
        [
          { left: 0, right: 0 },
          { left: 0, right: 1 },
        ],
      ),
    ).rejects.toMatchObject({ path: "anchors[1].left", status: 422 });
  });

  it("surfaces a single error path on 422", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "未严格递增", path: "left[2].time" }, 422),
    );
    await expect(
      alignNotes("[]", "[]", fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({
      name: "AlignRequestError",
      path: "left[2].time",
      status: 422,
    });
  });

  it("turns network failure into an empty-path error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    try {
      await alignNotes("[]", "[]", fetchMock as unknown as typeof fetch);
      throw new Error("should reject");
    } catch (e) {
      expect(e).toBeInstanceOf(AlignRequestError);
      expect((e as AlignRequestError).path).toBe("");
    }
  });

  it("wraps non-JSON responses", async () => {
    const fetchMock = vi.fn(
      async () => new Response("oops", { status: 502 }),
    );
    await expect(
      alignNotes("[]", "[]", fetchMock as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AlignRequestError);
  });

  it("omits term_pairs entirely when none are given (legacy body)", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init!.body as string);
      return jsonResponse(alignedBody);
    });
    const f = fetchMock as unknown as typeof fetch;
    await alignNotes("[]", "[]", f);
    expect(bodies[0]).toBe(`{"left":[],"right":[]}`);
    expect(bodies[0]).not.toContain("term_pairs");
    // Explicit undefined (with compare on) still adds no term_pairs.
    await alignNotes("[]", "[]", f, undefined, true, undefined);
    expect(bodies[1]).toBe(
      `{"left":[],"right":[],"compare_alternative":true}`,
    );
  });

  it("sends term_pairs between anchors and the compare flag", async () => {
    let sentBody = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = init!.body as string;
      return jsonResponse({
        ...alignedBody,
        term_pairs: [{ left_text: "a", right_text: "b" }],
      });
    });
    await alignNotes(
      `[{"time":1,"text":"a"}]`,
      `[{"time":2,"text":"b"}]`,
      fetchMock as unknown as typeof fetch,
      [{ left: 0, right: 0 }],
      true,
      [{ left_text: "a", right_text: "b" }],
    );
    expect(sentBody).toBe(
      `{"left":[{"time":1,"text":"a"}],"right":[{"time":2,"text":"b"}],` +
        `"anchors":[{"left":0,"right":0}],` +
        `"term_pairs":[{"left_text":"a","right_text":"b"}],` +
        `"compare_alternative":true}`,
    );
  });

  it("parses echoed term_pairs and per-row term_pair markers", async () => {
    const body = {
      steps: [
        {
          action: "match",
          left: { time: 0, text: "人工智能" },
          right: { time: 100, text: "AI" },
          cost: 100,
          cumulative_cost: 100,
          term_pair: { left_text: "人工智能", right_text: "AI" },
        },
      ],
      total_cost: 100,
      counts: { match: 1, left_gap: 0, right_gap: 0 },
      costs: { gap: 2000, mismatch_penalty: 3000 },
      term_pairs: [{ left_text: "人工智能", right_text: "AI" }],
    };
    const result = await alignNotes(
      "[]",
      "[]",
      vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch,
      undefined,
      false,
      [{ left_text: "人工智能", right_text: "AI" }],
    );
    expect(result.term_pairs).toEqual([
      { left_text: "人工智能", right_text: "AI" },
    ]);
    expect(result.steps[0].term_pair).toEqual({
      left_text: "人工智能",
      right_text: "AI",
    });
    expect(result.steps[0].cost).toBe(100n);
  });

  it("surfaces a single term-pair conflict path on 422", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: "同一侧术语不可重复对应。",
          path: "term_pairs[1].left_text",
        },
        422,
      ),
    );
    await expect(
      alignNotes(
        "[]",
        "[]",
        fetchMock as unknown as typeof fetch,
        undefined,
        false,
        [
          { left_text: "a", right_text: "x" },
          { left_text: "a", right_text: "y" },
        ],
      ),
    ).rejects.toMatchObject({
      path: "term_pairs[1].left_text",
      status: 422,
    });
  });
});

describe("auditNotes", () => {
  const auditOk = {
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
    ],
  };

  it("posts left/right raw arrays and the candidate raw with /api/audit URL", async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      sentBody = init!.body as string;
      return jsonResponse(auditOk);
    });
    let sentBody = "";
    await auditNotes(
      `[{"time":1,"text":"a"}]`,
      `[{"time":2,"text":"a"}]`,
      `{"steps":[],"total_cost":0}`,
      fetchMock as unknown as typeof fetch,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/audit");
    expect(sentBody).toBe(
      `{"left":[{"time":1,"text":"a"}],"right":[{"time":2,"text":"a"}],"candidate":{"steps":[],"total_cost":0}}`,
    );
  });

  it("omits anchors/term_pairs when absent (legacy-shaped audit request)", async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      sentBody = init!.body as string;
      return jsonResponse(auditOk);
    });
    let sentBody = "";
    await auditNotes("[]", "[]", `{"steps":[],"total_cost":0}`, fetchMock as unknown as typeof fetch);
    expect(sentBody).toBe(`{"left":[],"right":[],"candidate":{"steps":[],"total_cost":0}}`);
    expect(sentBody).not.toContain("anchors");
    expect(sentBody).not.toContain("term_pairs");
  });

  it("sends anchors and term pairs between the arrays and candidate", async () => {
    let sentBody = "";
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      sentBody = init!.body as string;
      return jsonResponse(auditOk);
    });
    await auditNotes(
      "[]",
      "[]",
      `{"steps":[],"total_cost":0}`,
      fetchMock as unknown as typeof fetch,
      [{ left: 0, right: 0 }],
      [{ left_text: "a", right_text: "b" }],
    );
    expect(sentBody).toBe(
      `{"left":[],"right":[],"anchors":[{"left":0,"right":0}],` +
        `"term_pairs":[{"left_text":"a","right_text":"b"}],` +
        `"candidate":{"steps":[],"total_cost":0}}`,
    );
  });

  it("forwards huge integer digits verbatim in the candidate notes", async () => {
    let sentBody = "";
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      sentBody = init!.body as string;
      return jsonResponse(auditOk);
    });
    await auditNotes(
      "[]",
      "[]",
      `{"steps":[{"action":"right_gap","left":{"time":9007199254740993,"text":"a"},"right":null,"cost":2000,"cumulative_cost":2000}],"total_cost":2000}`,
      fetchMock as unknown as typeof fetch,
    );
    expect(sentBody).toContain("9007199254740993");
  });

  it("normalizes small indices back to plain numbers (bigint-aware parser)", async () => {
    const outcome = await auditNotes(
      "[]",
      "[]",
      `{"steps":[],"total_cost":0}`,
      vi.fn(async () => jsonResponse(auditOk)) as unknown as typeof fetch,
    );
    expect(outcome.steps[0].index).toBe(0);
    expect(outcome.steps[0].consumed.left).toBe(0);
    expect(typeof outcome.steps[0].index).toBe("number");
  });

  it("normalizes echoed anchors to plain numbers", async () => {
    const body = { ...auditOk, anchors: [{ left: 0, right: 1 }] };
    const outcome = await auditNotes(
      "[]",
      "[]",
      `{"steps":[],"total_cost":0}`,
      vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch,
      [{ left: 0, right: 1 }],
    );
    expect(outcome.anchors).toEqual([{ left: 0, right: 1 }]);
  });

  it("rejects with path/expected/actual on a semantic 422", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: "单步代价与按当前规则复算的结果不一致。",
          path: "candidate.steps[2].cost",
          expected: 2000,
          actual: 9999,
        },
        422,
      ),
    );
    await expect(
      auditNotes(
        "[]",
        "[]",
        `{"steps":[],"total_cost":0}`,
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({
      name: "AlignRequestError",
      path: "candidate.steps[2].cost",
      status: 422,
      expected: 2000n,
      actual: 9999n,
    });
  });

  it("rejects with the single structural-error envelope too", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: "candidate.steps 必须是数组。", path: "candidate.steps" },
        422,
      ),
    );
    await expect(
      auditNotes(
        "[]",
        "[]",
        `{"steps":[],"total_cost":0}`,
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ path: "candidate.steps", status: 422 });
    // No expected/actual keys on a structural error.
    try {
      await auditNotes(
        "[]",
        "[]",
        `{"steps":[],"total_cost":0}`,
        fetchMock as unknown as typeof fetch,
      );
      throw new Error("should reject");
    } catch (e) {
      expect(e).toBeInstanceOf(AlignRequestError);
      expect((e as AlignRequestError).expected).toBeUndefined();
    }
  });

  it("turns network failure into an empty-path error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    try {
      await auditNotes(
        "[]",
        "[]",
        `{"steps":[],"total_cost":0}`,
        fetchMock as unknown as typeof fetch,
      );
      throw new Error("should reject");
    } catch (e) {
      expect(e).toBeInstanceOf(AlignRequestError);
      expect((e as AlignRequestError).path).toBe("");
    }
  });
});
