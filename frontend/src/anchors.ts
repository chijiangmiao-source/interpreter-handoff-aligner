/**
 * Client-side mirror of the anchor rules in backend/app/validation.py.
 *
 * An anchor is a human-confirmed `{ left, right }` pair of 0-based record
 * indices.  After both note arrays parse and validate, the anchors must be:
 *
 *   1. objects carrying only integer `left` and `right` indices;
 *   2. in range on both sides (the referenced records must exist);
 *   3. never reuse an index already used by another anchor;
 *   4. strictly increasing on BOTH sides (no crossing pairs).
 *
 * Exactly one failure is returned — the first definite one, examining anchors
 * in the order the user listed them — carrying the 0-based anchor index (and
 * offending side) so the UI can mark that single row. The server stays the
 * authority; this only reproduces its decisions locally.
 */

export interface AnchorIssue {
  /** index into the anchors array */
  index: number;
  field: "left" | "right" | null;
  /** API-style path, e.g. `anchors[1].left` or `anchors[0]` */
  path: string;
  message: string;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

export function validateAnchors(
  anchors: unknown,
  m: number,
  n: number,
): AnchorIssue | null {
  if (!Array.isArray(anchors)) {
    return { index: -1, field: null, path: "anchors", message: "anchors 必须是数组。" };
  }

  const seenLeft = new Set<number>();
  const seenRight = new Set<number>();
  let prevLeft: number | null = null;
  let prevRight: number | null = null;

  for (let k = 0; k < anchors.length; k++) {
    const anchor = anchors[k] as unknown;
    const base = `anchors[${k}]`;
    const fail = (
      field: AnchorIssue["field"],
      message: string,
    ): AnchorIssue => ({
      index: k,
      field,
      path: field ? `${base}.${field}` : base,
      message,
    });

    if (typeof anchor !== "object" || anchor === null || Array.isArray(anchor)) {
      return fail(null, `${base} 必须是包含 left 与 right 索引的对象。`);
    }
    const obj = anchor as Record<string, unknown>;

    const extra = Object.keys(obj).find((key) => key !== "left" && key !== "right");
    if (extra !== undefined) {
      return fail(null, `${base}.${extra} 是多余字段。`);
    }

    const sides: Array<{
      side: "left" | "right";
      length: number;
      seen: Set<number>;
    }> = [
      { side: "left", length: m, seen: seenLeft },
      { side: "right", length: n, seen: seenRight },
    ];

    for (const { side, length, seen } of sides) {
      if (!(side in obj)) {
        return fail(side, `${base} 缺少整数记录索引 ${side}。`);
      }
      const value = obj[side];
      if (typeof value === "boolean" || !isNonNegInt(value)) {
        return fail(side, `${base}.${side} 必须是非负整数记录索引。`);
      }
      if (value >= length) {
        const range = length ? `，合法范围 0..${length - 1}` : "，该侧没有任何记录";
        return fail(
          side,
          `${base}.${side} 索引 ${value} 越界（${side} 共 ${length} 项${range}）。`,
        );
      }
      if (seen.has(value)) {
        return fail(
          side,
          `${base}.${side} 索引 ${value} 已被其他锚点配对，不可复用。`,
        );
      }
    }

    const li = obj.left as number;
    const ri = obj.right as number;
    if (prevLeft !== null && prevRight !== null && (li <= prevLeft || ri <= prevRight)) {
      const field: "left" | "right" = li <= prevLeft ? "left" : "right";
      return fail(
        field,
        `${base} 与锚点顺序交叉：(${li}, ${ri}) 未同时晚于上一锚点 ` +
          `(${prevLeft}, ${prevRight})，左右索引都必须严格递增。`,
      );
    }

    seenLeft.add(li);
    seenRight.add(ri);
    prevLeft = li;
    prevRight = ri;
  }

  return null;
}
