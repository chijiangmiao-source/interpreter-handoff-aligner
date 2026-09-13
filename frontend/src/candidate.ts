/**
 * Client-side mirror of the candidate rules in backend/app/audit.py.
 *
 * A candidate is the externally adjusted timeline the lead asks the server to
 * verify: `{ steps: Step[], total_cost: Int }`. Every step must be an object
 * carrying only:
 *
 *   - action: "match" | "left_gap" | "right_gap";
 *   - left/right: null (the side is blank) or a single `{ time, text }` note;
 *   - cost / cumulative_cost: non-negative integers;
 *   - optional origin: "anchor" | "auto";
 *   - optional term_pair: null or `{ left_text, right_text }` non-empty strings.
 *
 * Exactly one failure is returned — the first definite one in document order —
 * carrying a server-style path (`candidate.steps[2].cost`), a human message and
 * the step index (so the workspace can mark that candidate row). The server
 * stays the authority for costs and for note conservation/order; this only
 * reproduces the structural decisions locally.
 */

import type { Action, RowOrigin, TermPair } from "./types";

export interface CandidateIssue {
  /** full server-style path, e.g. `candidate.steps[2].cost` */
  path: string;
  message: string;
  /** index into candidate.steps, or -1 for the candidate root */
  stepIndex: number;
}

const ACTIONS: ReadonlySet<string> = new Set(["match", "left_gap", "right_gap"]);
const STEP_KEYS = new Set([
  "action",
  "left",
  "right",
  "cost",
  "cumulative_cost",
  "origin",
  "term_pair",
]);

function isNonNegIntToken(v: unknown): v is number | bigint {
  if (typeof v === "bigint") return v >= 0n;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && !Number.isNaN(v);
}

function isIntToken(v: unknown): v is number | bigint {
  if (typeof v === "bigint") return true;
  return typeof v === "number" && Number.isInteger(v) && !Number.isNaN(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stepPath(k: number, field?: string): string {
  const base = `candidate.steps[${k}]`;
  return field ? `${base}.${field}` : base;
}

/** Validate one side slot: null or a note carrying only integer time/text. */
function validateNoteSlot(
  value: unknown,
  path: string,
): CandidateIssue | null {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    return { path, message: "必须是 null 或仅含 time 与 text 的笔记对象。", stepIndex: -1 };
  }
  const extra = Object.keys(value).find((key) => key !== "time" && key !== "text");
  if (extra !== undefined) {
    return {
      path: `${path}.${extra}`,
      message: `${path}.${extra} 是多余字段，笔记仅允许 time 与 text。`,
      stepIndex: -1,
    };
  }
  if (!("time" in value)) {
    return { path: `${path}.time`, message: `${path} 缺少整数字段 time。`, stepIndex: -1 };
  }
  if (typeof value.time === "boolean" || !isIntToken(value.time)) {
    return {
      path: `${path}.time`,
      message: `${path}.time 必须是整数毫秒时间戳。`,
      stepIndex: -1,
    };
  }
  if (!("text" in value)) {
    return {
      path: `${path}.text`,
      message: `${path} 缺少非空字符串字段 text。`,
      stepIndex: -1,
    };
  }
  if (typeof value.text !== "string" || value.text.length === 0) {
    return {
      path: `${path}.text`,
      message: `${path}.text 必须是非空字符串。`,
      stepIndex: -1,
    };
  }
  return null;
}

export function validateCandidate(candidate: unknown): CandidateIssue | null {
  if (!isPlainObject(candidate)) {
    return {
      path: "candidate",
      message: "candidate 必须是包含 steps 与 total_cost 的对象。",
      stepIndex: -1,
    };
  }

  if (!("steps" in candidate)) {
    return {
      path: "candidate.steps",
      message: "candidate 缺少 steps 数组。",
      stepIndex: -1,
    };
  }
  if (!Array.isArray(candidate.steps)) {
    return {
      path: "candidate.steps",
      message: "candidate.steps 必须是数组。",
      stepIndex: -1,
    };
  }

  for (let k = 0; k < candidate.steps.length; k++) {
    const step = candidate.steps[k] as unknown;
    const fail = (path: string, message: string): CandidateIssue => ({
      path,
      message,
      stepIndex: k,
    });

    if (!isPlainObject(step)) {
      return fail(stepPath(k), `${stepPath(k)} 必须是表示一行对齐步骤的对象。`);
    }

    const extra = Object.keys(step).find((key) => !STEP_KEYS.has(key));
    if (extra !== undefined) {
      return fail(stepPath(k, extra), `${stepPath(k)}.${extra} 是多余字段。`);
    }

    if (!("action" in step)) {
      return fail(stepPath(k, "action"), `${stepPath(k)} 缺少动作字段 action。`);
    }
    if (typeof step.action !== "string" || !ACTIONS.has(step.action)) {
      return fail(
        stepPath(k, "action"),
        `${stepPath(k)}.action 必须是 match、left_gap 或 right_gap 之一。`,
      );
    }

    for (const side of ["left", "right"] as const) {
      const path = stepPath(k, side);
      if (!(side in step)) {
        return fail(path, `${stepPath(k)} 缺少 ${side} 字段（留空必须显式写 null）。`);
      }
      const noteIssue = validateNoteSlot(step[side], path);
      if (noteIssue) return fail(noteIssue.path, noteIssue.message);
    }

    for (const field of ["cost", "cumulative_cost"] as const) {
      const path = stepPath(k, field);
      if (!(field in step)) {
        return fail(path, `${stepPath(k)} 缺少整数字段 ${field}。`);
      }
      if (typeof step[field] === "boolean" || !isNonNegIntToken(step[field])) {
        return fail(path, `${stepPath(k)}.${field} 必须是非负整数。`);
      }
    }

    if ("origin" in step && step.origin !== "anchor" && step.origin !== "auto") {
      return fail(stepPath(k, "origin"), `${stepPath(k)}.origin 必须是 anchor 或 auto。`);
    }

    if ("term_pair" in step && step.term_pair !== null) {
      const tp = step.term_pair;
      const tpPath = stepPath(k, "term_pair");
      if (!isPlainObject(tp)) {
        return fail(tpPath, `${tpPath} 必须是 null 或术语对对象。`);
      }
      const tpExtra = Object.keys(tp).find(
        (key) => key !== "left_text" && key !== "right_text",
      );
      if (tpExtra !== undefined) {
        return fail(
          `${tpPath}.${tpExtra}`,
          `${tpPath}.${tpExtra} 是多余字段。`,
        );
      }
      for (const field of ["left_text", "right_text"] as const) {
        if (!(field in tp)) {
          return fail(`${tpPath}.${field}`, `${tpPath} 缺少非空字符串字段 ${field}。`);
        }
        if (typeof tp[field] !== "string" || (tp[field] as string).length === 0) {
          return fail(`${tpPath}.${field}`, `${tpPath}.${field} 必须是非空字符串。`);
        }
      }
    }
  }

  if (!("total_cost" in candidate)) {
    return {
      path: "candidate.total_cost",
      message: "candidate 缺少整数字段 total_cost。",
      stepIndex: -1,
    };
  }
  if (
    typeof candidate.total_cost === "boolean" ||
    !isNonNegIntToken(candidate.total_cost)
  ) {
    return {
      path: "candidate.total_cost",
      message: "candidate.total_cost 必须是非负整数。",
      stepIndex: -1,
    };
  }

  return null;
}

/** Pull the candidate step index out of a path like `candidate.steps[2].cost`. */
export function stepIndexFromPath(path: string): number {
  const match = /^candidate\.steps\[(\d+)\]/.exec(path);
  return match ? Number(match[1]) : -1;
}

/** A parsed candidate step for the workspace's row list (structure assumed). */
export interface CandidateRow {
  action: Action;
  left: { time: number | bigint; text: string } | null;
  right: { time: number | bigint; text: string } | null;
  cost: number | bigint;
  cumulative_cost: number | bigint;
  origin?: RowOrigin;
  term_pair?: TermPair | null;
}

/** Best-effort row extraction from a parsed (or partly malformed) candidate. */
export function toCandidateRows(value: unknown): CandidateRow[] {
  if (!isPlainObject(value) || !Array.isArray(value.steps)) return [];
  return value.steps.map((raw) => {
    const s = (isPlainObject(raw) ? raw : {}) as Record<string, unknown>;
    const note = (v: unknown) =>
      isPlainObject(v) &&
      (typeof v.time === "number" || typeof v.time === "bigint") &&
      typeof v.text === "string"
        ? { time: v.time as number | bigint, text: v.text as string }
        : null;
    return {
      action: ACTIONS.has(s.action as string) ? (s.action as Action) : ("match" as Action),
      left: note(s.left),
      right: note(s.right),
      cost: typeof s.cost === "number" || typeof s.cost === "bigint" ? s.cost : 0,
      cumulative_cost:
        typeof s.cumulative_cost === "number" || typeof s.cumulative_cost === "bigint"
          ? s.cumulative_cost
          : 0,
      origin: s.origin === "anchor" || s.origin === "auto" ? s.origin : undefined,
      term_pair: isPlainObject(s.term_pair)
        ? (s.term_pair as unknown as TermPair)
        : (s.term_pair === null ? null : undefined),
    };
  });
}
