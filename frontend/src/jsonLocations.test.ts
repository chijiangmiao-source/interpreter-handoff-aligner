import { describe, expect, it } from "vitest";
import { locateOffset, parseLocated, JsonSourceError } from "./jsonLocations";

describe("parseLocated", () => {
  it("parses all JSON value types and matches JSON.parse", () => {
    const samples = [
      `[]`,
      `{}`,
      `[1, 2.5, -3, 1e2, true, false, null, "s\\n\\"\\\\"]`,
      `{"a": {"b": [10, {"c": 20}]}}`,
      `  [ 1 , { "k" : "v" } ]  `,
    ];
    for (const s of samples) {
      const { value } = parseLocated(s);
      expect(value).toEqual(JSON.parse(s));
    }
  });

  it("records array element ranges", () => {
    const src = `[10, 20]`;
    const doc = parseLocated(src);
    expect(src.slice(doc.ranges.get("[0]")!.start, doc.ranges.get("[0]")!.end)).toBe("10");
    expect(src.slice(doc.ranges.get("[1]")!.start, doc.ranges.get("[1]")!.end)).toBe("20");
  });

  it("records nested member ranges including the key", () => {
    const src = `[
  {"time": 5, "text": "a"}
]`;
    const doc = parseLocated(src);
    const r = doc.memberRanges.get("[0].time")!;
    const slice = src.slice(r.start, r.end);
    expect(slice).toContain('"time"');
    expect(slice.trimEnd().endsWith("5")).toBe(true);
  });

  it("records the root range", () => {
    const src = ` [1,2] `;
    const doc = parseLocated(src);
    expect(src.slice(doc.ranges.get("")!.start, doc.ranges.get("")!.end)).toBe("[1,2]");
  });

  it("points at malformed JSON positions", () => {
    expect(() => parseLocated(`[1, ]`)).toThrow(JsonSourceError);
    try {
      parseLocated(`[1, ]`);
    } catch (e) {
      expect((e as JsonSourceError).pos).toBe(4);
    }
    expect(() => parseLocated(`{"a": }`)).toThrow(JsonSourceError);
    expect(() => parseLocated(`[1 2]`)).toThrow(JsonSourceError);
    expect(() => parseLocated(`{"a":1},`)).toThrow(JsonSourceError);
    expect(() => parseLocated(`[1,]`)).toThrow(JsonSourceError);
  });

  it("rejects trailing garbage", () => {
    try {
      parseLocated(`[] x`);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JsonSourceError);
      expect((e as JsonSourceError).pos).toBe(3);
    }
  });
});

describe("locateOffset", () => {
  it("computes 1-based lines and columns", () => {
    // "[1,\n 2,\n 3]" — offsets: 0 -> (1,1), the second-line '2' at 4 ->
    // (2,1), the third-line '3' at index 8 -> (3,2)
    const src = "[1,\n2,\n3]";
    expect(locateOffset(src, 0)).toEqual({ line: 1, column: 1 });
    expect(locateOffset(src, 3)).toEqual({ line: 2, column: 1 }); // on '\n'
    expect(locateOffset(src, 4)).toEqual({ line: 2, column: 1 }); // '2'
    expect(locateOffset(src, 5)).toEqual({ line: 2, column: 2 }); // ','
    expect(locateOffset(src, 6)).toEqual({ line: 3, column: 1 }); // on '\n'
    expect(locateOffset(src, 7)).toEqual({ line: 3, column: 1 }); // '3'
    expect(locateOffset(src, 8)).toEqual({ line: 3, column: 2 }); // ']'
  });
});
