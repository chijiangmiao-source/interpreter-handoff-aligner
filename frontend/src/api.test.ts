import { describe, expect, it, vi } from "vitest";
import { alignNotes, AlignRequestError } from "./api";

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

describe("alignNotes", () => {
  it("posts both arrays and returns the parsed result", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => jsonResponse(alignedBody),
    );
    const result = await alignNotes(
      [{ time: 1, text: "a" }],
      [{ time: 2, text: "a" }],
      fetchMock as unknown as typeof fetch,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/align");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      left: [{ time: 1, text: "a" }],
      right: [{ time: 2, text: "a" }],
    });
    expect(result.total_cost).toBe(1);
    expect(result.steps[0].cumulative_cost).toBe(1);
  });

  it("surfaces a single error path on 422", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "未严格递增", path: "left[2].time" }, 422),
    );
    await expect(
      alignNotes([], [], fetchMock as unknown as typeof fetch),
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
      await alignNotes([], [], fetchMock as unknown as typeof fetch);
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
      alignNotes([], [], fetchMock as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AlignRequestError);
  });
});
