/**
 * Client-side mirror of the term-pair rules in backend/app/validation.py.
 *
 * A term pair is a lead-declared `{ left_text, right_text }` correspondence.
 * Each entry must:
 *
 *   1. be an object carrying only non-empty string `left_text`/`right_text`;
 *   2. map a term at most once per side — reusing an already mapped
 *      left_text (or right_text) is a conflict reported on the later entry.
 *
 * Exactly one failure is returned — the first definite one, examining pairs
 * in the order the user listed them — carrying the 0-based pair index (and
 * offending field) so the UI can flag that single row. The server stays the
 * authority; this only reproduces its decisions locally (also when the API
 * is unreachable).
 */

export interface TermPairIssue {
  /** index into the term_pairs array */
  index: number;
  field: "left_text" | "right_text" | null;
  /** API-style path, e.g. `term_pairs[1].right_text` or `term_pairs[0]` */
  path: string;
  message: string;
}

export function validateTermPairs(pairs: unknown): TermPairIssue | null {
  if (!Array.isArray(pairs)) {
    return {
      index: -1,
      field: null,
      path: "term_pairs",
      message: "term_pairs 必须是数组。",
    };
  }

  const seenLeft = new Set<string>();
  const seenRight = new Set<string>();

  for (let k = 0; k < pairs.length; k++) {
    const pair = pairs[k] as unknown;
    const base = `term_pairs[${k}]`;
    const fail = (
      field: TermPairIssue["field"],
      message: string,
    ): TermPairIssue => ({
      index: k,
      field,
      path: field ? `${base}.${field}` : base,
      message,
    });

    if (typeof pair !== "object" || pair === null || Array.isArray(pair)) {
      return fail(null, `${base} 必须是包含 left_text 与 right_text 的对象。`);
    }
    const obj = pair as Record<string, unknown>;

    const extra = Object.keys(obj).find(
      (key) => key !== "left_text" && key !== "right_text",
    );
    if (extra !== undefined) {
      return {
        index: k,
        field: null,
        path: `${base}.${extra}`,
        message: `${base}.${extra} 是多余字段。`,
      };
    }

    const fields: Array<{
      field: "left_text" | "right_text";
      seen: Set<string>;
    }> = [
      { field: "left_text", seen: seenLeft },
      { field: "right_text", seen: seenRight },
    ];

    for (const { field, seen } of fields) {
      if (!(field in obj)) {
        return fail(field, `${base} 缺少非空字符串字段 ${field}。`);
      }
      const value = obj[field];
      if (typeof value !== "string") {
        return fail(field, `${base}.${field} 必须是非空字符串。`);
      }
      if (value.length === 0) {
        return fail(field, `${base}.${field} 不可为空字符串。`);
      }
      if (seen.has(value)) {
        return fail(
          field,
          `${base}.${field} 「${value}」已映射过，同一侧术语不可重复对应。`,
        );
      }
    }

    seenLeft.add(obj.left_text as string);
    seenRight.add(obj.right_text as string);
  }

  return null;
}
