import { describe, expect, it } from "vitest";
import { validateAnchors } from "./anchors";

const a = (left: number, right: number) => ({ left, right });

describe("validateAnchors", () => {
  it("accepts an empty list and valid monotonic anchors", () => {
    expect(validateAnchors([], 3, 3)).toBeNull();
    expect(validateAnchors([a(0, 0)], 3, 3)).toBeNull();
    expect(validateAnchors([a(0, 0), a(1, 2), a(2, 5)], 3, 6)).toBeNull();
    // Boundary indices are in range.
    expect(validateAnchors([a(199, 199)], 200, 200)).toBeNull();
  });

  it("rejects a non-array anchors value", () => {
    const issue = validateAnchors("x", 3, 3);
    expect(issue?.path).toBe("anchors");
    expect(issue?.index).toBe(-1);
  });

  it("rejects non-object entries and wrong field shapes", () => {
    expect(validateAnchors([5], 3, 3)?.path).toBe("anchors[0]");
    expect(validateAnchors([{}], 3, 3)?.path).toBe("anchors[0].left");
    expect(validateAnchors([a(0, undefined as unknown as number)], 3, 3)?.path).toBe(
      "anchors[0].right",
    );
    expect(validateAnchors([{ left: 0, right: 0, who: 1 }], 3, 3)?.path).toBe(
      "anchors[0]",
    );
  });

  it("requires non-negative integer indices", () => {
    for (const bad of [1.5, -1, true, "0", null, [0]]) {
      expect(validateAnchors([{ left: bad, right: 0 }], 3, 3)?.path).toBe(
        "anchors[0].left",
      );
    }
  });

  it("flags out-of-range indices on either side", () => {
    expect(validateAnchors([a(3, 0)], 3, 3)?.path).toBe("anchors[0].left");
    expect(validateAnchors([a(0, 3)], 3, 3)?.path).toBe("anchors[0].right");
    // Empty side: even index 0 is out of range.
    expect(validateAnchors([a(0, 0)], 0, 0)?.path).toBe("anchors[0].left");
    expect(validateAnchors([a(0, 0)], 1, 0)?.path).toBe("anchors[0].right");
  });

  it("flags reused indices with the offending anchor + side", () => {
    const issue = validateAnchors([a(0, 0), a(0, 1)], 3, 3);
    expect(issue?.path).toBe("anchors[1].left");
    expect(validateAnchors([a(0, 0), a(1, 0)], 3, 3)?.path).toBe(
      "anchors[1].right",
    );
  });

  it("flags crossing (non-monotonic) anchors once at the first offender", () => {
    expect(validateAnchors([a(0, 2), a(1, 1)], 3, 3)?.path).toBe(
      "anchors[1].right",
    );
    expect(validateAnchors([a(2, 0), a(1, 1)], 3, 3)?.path).toBe(
      "anchors[1].left",
    );
    const many = validateAnchors(
      // right indices 0,2,3 are all distinct; the last (1) is not a reuse but
      // is smaller than 3, so it is a pure ordering cross.
      [a(0, 0), a(1, 2), a(2, 3), a(3, 1)],
      5,
      5,
    );
    expect(many?.path).toBe("anchors[3].right");
    expect(many?.message).toContain("交叉");
  });

  it("reports exactly one, the earliest, error", () => {
    // The second anchor is both a reuse on the right and a cross; the first
    // encountered failure for that anchor is still a single issue.
    const issue = validateAnchors([a(0, 0), a(1, 0), a(9, 9)], 3, 3);
    expect(issue?.path).toBe("anchors[1].right");
  });
});
