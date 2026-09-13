import { describe, expect, it, vi } from "vitest";
import { alignNotes, AlignRequestError, rootRawText } from "./api";

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
});
