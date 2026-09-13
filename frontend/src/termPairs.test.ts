import { describe, expect, it } from "vitest";
import { validateTermPairs } from "./termPairs";

describe("validateTermPairs", () => {
  it("accepts an empty list", () => {
    expect(validateTermPairs([])).toBeNull();
  });

  it("accepts non-empty strings on both sides", () => {
    expect(
      validateTermPairs([
        { left_text: "人工智能", right_text: "AI" },
        { left_text: "机器学习", right_text: "ML" },
      ]),
    ).toBeNull();
  });

  it("accepts whitespace-only strings as non-empty", () => {
    expect(validateTermPairs([{ left_text: " ", right_text: "b" }])).toBeNull();
  });

  it("rejects a non-array value", () => {
    const issue = validateTermPairs("nope");
    expect(issue?.path).toBe("term_pairs");
  });

  it("rejects entries that are not plain objects", () => {
    expect(validateTermPairs([5])?.path).toBe("term_pairs[0]");
    expect(validateTermPairs([["a", "b"]])?.path).toBe("term_pairs[0]");
    expect(validateTermPairs([null])?.path).toBe("term_pairs[0]");
  });

  it("rejects unknown and missing fields with precise paths", () => {
    expect(
      validateTermPairs([{ left_text: "a", right_text: "b", who: 1 }])?.path,
    ).toBe("term_pairs[0].who");
    expect(validateTermPairs([{ left_text: "a" }])?.path).toBe(
      "term_pairs[0].right_text",
    );
    expect(validateTermPairs([{ right_text: "b" }])?.path).toBe(
      "term_pairs[0].left_text",
    );
  });

  it("rejects non-string and empty fields", () => {
    for (const bad of [1, true, null, ["a"], {}]) {
      expect(
        validateTermPairs([{ left_text: bad as unknown, right_text: "b" }])
          ?.path,
      ).toBe("term_pairs[0].left_text");
      expect(
        validateTermPairs([{ left_text: "a", right_text: bad as unknown }])
          ?.path,
      ).toBe("term_pairs[0].right_text");
    }
    expect(
      validateTermPairs([{ left_text: "", right_text: "b" }])?.path,
    ).toBe("term_pairs[0].left_text");
    expect(
      validateTermPairs([{ left_text: "a", right_text: "" }])?.path,
    ).toBe("term_pairs[0].right_text");
  });

  it("flags the first same-side duplicate mapping once", () => {
    const leftClash = validateTermPairs([
      { left_text: "人工智能", right_text: "AI" },
      { left_text: "人工智能", right_text: "ML" },
    ]);
    expect(leftClash?.path).toBe("term_pairs[1].left_text");
    expect(leftClash?.index).toBe(1);
    expect(leftClash?.field).toBe("left_text");

    const rightClash = validateTermPairs([
      { left_text: "人工智能", right_text: "AI" },
      { left_text: "机器学习", right_text: "AI" },
    ]);
    expect(rightClash?.path).toBe("term_pairs[1].right_text");
    expect(rightClash?.field).toBe("right_text");
  });

  it("reports only the left field when both sides clash (fixed check order)", () => {
    const issue = validateTermPairs([
      { left_text: "a", right_text: "x" },
      { left_text: "a", right_text: "x" },
    ]);
    expect(issue?.path).toBe("term_pairs[1].left_text");
    expect(issue?.message).toContain("a");
  });

  it("allows cross-side reuse (per-side uniqueness only)", () => {
    expect(
      validateTermPairs([
        { left_text: "a", right_text: "b" },
        { left_text: "b", right_text: "c" },
      ]),
    ).toBeNull();
  });

  it("reports the first conflict among several", () => {
    const issue = validateTermPairs([
      { left_text: "a", right_text: "x" },
      { left_text: "b", right_text: "y" },
      { left_text: "c", right_text: "x" },
      { left_text: "a", right_text: "z" },
    ]);
    expect(issue?.path).toBe("term_pairs[2].right_text");
  });
});
