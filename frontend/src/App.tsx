import { useEffect, useMemo, useRef, useState } from "react";
import AnchorPanel, { type PickerNote } from "./AnchorPanel";
import TermPairPanel from "./TermPairPanel";
import HighlightedTextarea from "./HighlightedTextarea";
import ResultTimeline from "./ResultTimeline";
import AuditPanel, { type AuditPanelError } from "./AuditPanel";
import { alignNotes, auditNotes, rootRawText, AlignRequestError } from "./api";
import { validateAnchors, type AnchorIssue } from "./anchors";
import { validateTermPairs, type TermPairIssue } from "./termPairs";
import {
  stepIndexFromPath,
  toCandidateRows,
  validateCandidate,
} from "./candidate";
import {
  JsonSourceError,
  locateOffset,
  parseLocated,
  type Range,
} from "./jsonLocations";
import { validateSequence } from "./validation";
import type {
  AlignResponse,
  Anchor,
  AuditResponse,
  TermPair,
  Int,
} from "./types";

type Side = "left" | "right";

interface MarkedError {
  message: string;
  /** full API-style path such as `left[2].time` or `anchors[1].left` */
  path: string;
  side: Side | null;
  /** index into the anchors array when this failure concerns an anchor */
  anchorIndex?: number;
  /** index into the term_pairs array when this failure concerns a term pair */
  termIndex?: number;
  /** character offset inside the offending textarea (malformed JSON) */
  offset?: number;
}

const SAMPLE_LEFT = `[
  {"time": 0, "text": "各位媒体朋友下午好"},
  {"time": 4200, "text": "新产品将于下月上市"},
  {"time": 9000, "text": "感谢各位的提问"}
]`;

const SAMPLE_RIGHT = `[
  {"time": 150, "text": "各位媒体朋友下午好"},
  {"time": 4100, "text": "新产品将于下月上市"},
  {"time": 12000, "text": "交接后的补充记录"}
]`;

/** Pull a best-effort index/time/text list out of a parsed (or bad) array. */
function toPickerNotes(value: unknown): PickerNote[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const obj = item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {};
    return { index, time: obj.time, text: obj.text };
  });
}

/** Extract the anchor index from a path like `anchors[2].left`, else -1. */
function anchorIndexFromPath(path: string): number {
  const match = /^anchors\[(\d+)\]/.exec(path);
  return match ? Number(match[1]) : -1;
}

/** Extract the term-pair index from `term_pairs[2].left_text`, else -1. */
function termIndexFromPath(path: string): number {
  const match = /^term_pairs\[(\d+)\]/.exec(path);
  return match ? Number(match[1]) : -1;
}

/** JSON serialization that keeps bigint integers as raw numeric literals. */
function stringifyBigJson(value: unknown): string {
  // JSON.stringify's replacer cannot emit raw numbers for bigints, so swap
  // each bigint for a unique object marker and splice its exact digits back
  // in afterwards. The marker key cannot collide: in the serialized candidate
  // it appears as an object, while the only user-controlled content lives in
  // string values (whose embedded quotes are escaped as \").
  const text = JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? { __bigint_literal__: v.toString() } : v,
  );
  return text.replace(/\{"__bigint_literal__":"(-?\d+)"\}/g, "$1");
}

export default function App() {
  const [leftText, setLeftText] = useState(SAMPLE_LEFT);
  const [rightText, setRightText] = useState(SAMPLE_RIGHT);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  // Half-made pair selection lives here (not in the panel) so loading the
  // sample or clearing the inputs always starts from no pending pick.
  const [selLeft, setSelLeft] = useState<number | null>(null);
  const [selRight, setSelRight] = useState<number | null>(null);
  // Half-typed term drafts live here too (not in the panel), so loading the
  // sample or clearing the page discards even a one-sided draft and the next
  // pair starts from two blank fields.
  const [termLeftDraft, setTermLeftDraft] = useState("");
  const [termRightDraft, setTermRightDraft] = useState("");
  const [error, setError] = useState<MarkedError | null>(null);
  const [result, setResult] = useState<AlignResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState(0);
  // Optional switch for the strictly second-best complete path. It only
  // changes what is computed alongside the optimum; it never alters the
  // optimal timeline itself.
  const [compareAlt, setCompareAlt] = useState(false);
  // Optional lead-declared term correspondences. A pair is always kept when
  // added; a same-side duplicate mapping is flagged on the first conflict
  // instead of silently dropped, mirroring the anchor crossing UX.
  const [termPairs, setTermPairs] = useState<TermPair[]>([]);
  // Independent "核验时间轴" workspace: the pasted candidate text is ALWAYS
  // retained; auditResult holds only the LAST PASSING report, so a failed
  // verification surfaces the first difference without replacing it.
  const [auditText, setAuditText] = useState("");
  const [auditError, setAuditError] = useState<AuditPanelError | null>(null);
  const [auditResult, setAuditResult] = useState<AuditResponse | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  // Bumped by every audit submission so a late response for a superseded
  // candidate never overwrites the current workspace state.
  const auditSeq = useRef(0);
  // Bumped by every input/anchor mutation. A submission captures the current
  // generation and only applies its response while no mutation has happened
  // since, so a late response never resurrects a timeline computed from
  // inputs the user has already changed.
  const submitSeq = useRef(0);

  const located = useMemo(() => {
    const parse = (text: string) => {
      try {
        return parseLocated(text);
      } catch {
        return null;
      }
    };
    return { left: parse(leftText), right: parse(rightText) };
  }, [leftText, rightText]);

  // The pasted candidate: parse keeps source ranges (to highlight the first
  // structural-error path in the textarea) and the rows for the preview list.
  const auditLocated = useMemo(() => {
    if (auditText.trim().length === 0) return null;
    try {
      return parseLocated(auditText);
    } catch {
      return null;
    }
  }, [auditText]);
  const auditRows = useMemo(
    () => (auditLocated ? toCandidateRows(auditLocated.value) : []),
    [auditLocated],
  );

  // Picker lists follow whatever currently parses; malformed items still get
  // a row (with “—” placeholders) so their index is visible.
  const leftNotes = useMemo(
    () => toPickerNotes(located.left?.value),
    [located.left],
  );
  const rightNotes = useMemo(
    () => toPickerNotes(located.right?.value),
    [located.right],
  );

  /**
   * Map a relative path ("", "[200]", "[2]", "[2].time") onto the source
   * range inside that textarea, whose own JSON root is the array.
   */
  function rangeForRelative(side: Side, rel: string): Range | null {
    const doc = located[side];
    if (!doc) return null;
    if (rel === "") return doc.ranges.get("") ?? null;
    return doc.memberRanges.get(rel) ?? doc.ranges.get(rel) ?? null;
  }

  function markerFor(side: Side): Range | null {
    if (!error || error.side !== side) return null;
    if (error.offset !== undefined) {
      const len = (side === "left" ? leftText : rightText).length;
      return { start: error.offset, end: Math.min(error.offset + 1, len) };
    }
    const prefix = side === "left" ? "left" : "right";
    if (!error.path.startsWith(prefix)) return null;
    return rangeForRelative(side, error.path.slice(prefix.length));
  }

  /**
   * Surface the first anchor rule violation (if any) exactly like a server
   * 422 would: one banner plus the offending anchor row flagged in place.
   */
  function applyAnchorIssue(issue: AnchorIssue | null) {
    if (issue) {
      setError({
        message: issue.message,
        path: issue.path,
        side: null,
        anchorIndex: issue.index >= 0 ? issue.index : undefined,
      });
    } else {
      setError(null);
    }
  }

  /**
   * Surface the first same-side term conflict (if any) exactly like a server
   * 422 would: one banner plus the offending term row flagged in place.
   */
  function applyTermIssue(issue: TermPairIssue | null) {
    if (issue) {
      setError({
        message: issue.message,
        path: issue.path,
        side: null,
        termIndex: issue.index >= 0 ? issue.index : undefined,
      });
    } else {
      setError(null);
    }
  }

  /**
   * Pin a pair. The candidate is always kept in the list; when it breaks a
   * rule (at pick time the only reachable case is a crossing pair) the first
   * offending anchor is flagged instead of silently dropping one side's mark.
   */
  function addAnchor(candidate: Anchor) {
    submitSeq.current += 1;
    const tentative = [...anchors, candidate];
    setAnchors(tentative);
    applyAnchorIssue(
      validateAnchors(tentative, leftNotes.length, rightNotes.length),
    );
    setResult(null);
  }

  function removeAnchor(index: number) {
    submitSeq.current += 1;
    const remaining = anchors.filter((_, k) => k !== index);
    setAnchors(remaining);
    // Re-flag the first remaining violation, if any; otherwise clear it.
    applyAnchorIssue(
      validateAnchors(remaining, leftNotes.length, rightNotes.length),
    );
    setResult(null);
  }

  /**
   * Declare a term pair. The candidate is always kept in the list; when it
   * maps a side term already mapped (same-side duplicate), the first
   * conflicting pair is flagged in place instead of silently dropping it.
   *
   * Declaring terms is a pre-submission edit, like typing in the term panel:
   * it never replaces an already displayed timeline. A conflict only blocks
   * the next submission (with a banner); the last valid timeline stays on
   * screen until a successful realignment replaces it. The generation counter
   * still bumps, so a response in flight is recognized as computed from the
   * pre-edit declarations and never applied on top of them.
   */
  function addTermPair(candidate: TermPair) {
    submitSeq.current += 1;
    const tentative = [...termPairs, candidate];
    setTermPairs(tentative);
    applyTermIssue(validateTermPairs(tentative));
    // The candidate is always appended (a conflict stays listed and flagged
    // in place), so the verbatim drafts start a fresh blank pair.
    setTermLeftDraft("");
    setTermRightDraft("");
  }

  function removeTermPair(index: number) {
    submitSeq.current += 1;
    const remaining = termPairs.filter((_, k) => k !== index);
    setTermPairs(remaining);
    // Re-flag the first remaining conflict, if any; otherwise clear it. The
    // displayed timeline is left untouched (pre-submission edit).
    applyTermIssue(validateTermPairs(remaining));
  }

  /** Anchor-picker click: complete a pair, toggle a pending pick, or unpin. */
  function handlePick(side: Side, idx: number) {
    // Clicking a record already pinned to an anchor unpins that whole anchor.
    const existing = anchors.findIndex((a) => a[side] === idx);
    if (existing >= 0) {
      removeAnchor(existing);
      setSelLeft(null);
      setSelRight(null);
      return;
    }

    if (side === "left") {
      if (selLeft === idx) {
        setSelLeft(null);
        return;
      }
      if (selRight !== null) {
        addAnchor({ left: idx, right: selRight });
        setSelLeft(null);
        setSelRight(null);
        return;
      }
      setSelLeft(idx);
    } else {
      if (selRight === idx) {
        setSelRight(null);
        return;
      }
      if (selLeft !== null) {
        addAnchor({ left: selLeft, right: idx });
        setSelLeft(null);
        setSelRight(null);
        return;
      }
      setSelRight(idx);
    }
  }

  async function handleSubmit() {
    setError(null);
    setLoading(true);
    // Generation this submission belongs to. Any edit to the inputs, anchors
    // or term pairs before the response returns bumps the counter, marking
    // this in-flight request stale: its late response must not be displayed.
    // The previous timeline is NOT cleared here: a submission blocked by a
    // local problem (bad JSON, a crossing anchor, a term conflict) leaves
    // the last valid timeline on screen and only surfaces the one error. It
    // is replaced once a recomputation is actually launched below.
    const generation = ++submitSeq.current;
    const isCurrent = () => generation === submitSeq.current;
    try {
      // --- Phase 1: each textarea must itself parse as JSON (left first) ---
      let leftParsed: ReturnType<typeof parseLocated>;
      let rightParsed: ReturnType<typeof parseLocated>;
      try {
        leftParsed = parseLocated(leftText);
      } catch (e) {
        failJson("left", leftText, e);
        return;
      }
      try {
        rightParsed = parseLocated(rightText);
      } catch (e) {
        failJson("right", rightText, e);
        return;
      }

      // --- Phase 2: client-side structural validation (single failure) ----
      // This mirrors the server and still yields one precise failure when
      // the API is unreachable; the server remains the authority for cost.
      const localLeft = validateSequence(leftParsed.value);
      if (localLeft) {
        setError({
          message: localLeft.message,
          path: `left${localLeft.path}`,
          side: "left",
        });
        return;
      }
      const localRight = validateSequence(rightParsed.value);
      if (localRight) {
        setError({
          message: localRight.message,
          path: `right${localRight.path}`,
          side: "right",
        });
        return;
      }

      // --- Phase 2b: anchors must exist, never repeat and stay ordered ----
      const m = (leftParsed.value as unknown[]).length;
      const n = (rightParsed.value as unknown[]).length;
      const anchorIssue = validateAnchors(anchors, m, n);
      if (anchorIssue) {
        setError({
          message: anchorIssue.message,
          path: anchorIssue.path,
          side: null,
          anchorIndex: anchorIssue.index >= 0 ? anchorIssue.index : undefined,
        });
        return;
      }

      // --- Phase 2c: term pairs need non-empty texts and unique per-side ---
      const termIssue = validateTermPairs(termPairs);
      if (termIssue) {
        setError({
          message: termIssue.message,
          path: termIssue.path,
          side: null,
          termIndex: termIssue.index >= 0 ? termIssue.index : undefined,
        });
        return;
      }

      // --- Phase 3: the server performs the DP alignment ------------------
      // Every local check passed, so this is a genuine recomputation: the
      // previous timeline is cleared now (a blocked submission above keeps
      // it on screen). The raw array source is forwarded verbatim so
      // integer literals beyond Number.MAX_SAFE_INTEGER keep their exact
      // digits. Anchors/term pairs are only sent when non-empty, keeping
      // anchor/term-free requests byte-for-byte identical to the legacy API.
      setResult(null);
      // Remember the last valid timeline so a term conflict reported by the
      // server (normally already caught by the mirrored local check) can
      // restore it rather than leaving the page without any timeline.
      const lastResult = result;
      const leftRaw = rootRawText(leftText);
      const rightRaw = rootRawText(rightText);
      const anchorsToSend = anchors.length > 0 ? anchors : undefined;
      // Term pairs are only sent when at least one correspondence is
      // declared, keeping term-free requests byte-for-byte identical to the
      // legacy API.
      const termsToSend = termPairs.length > 0 ? termPairs : undefined;
      try {
        const aligned = await alignNotes(
          leftRaw,
          rightRaw,
          fetch,
          anchorsToSend,
          compareAlt,
          termsToSend,
        );
        // The user edited the notes or anchors while the request was in
        // flight: this timeline was computed from superseded input, so it
        // must not reappear under the current input.
        if (!isCurrent()) return;
        setResult(aligned);
        setRevealed(aligned.steps.length);
      } catch (e) {
        // A stale failure refers to input that is no longer on screen.
        if (!isCurrent()) return;
        if (e instanceof AlignRequestError && e.path) {
          const anchorIndex = anchorIndexFromPath(e.path);
          const termIndex = termIndexFromPath(e.path);
          if (anchorIndex >= 0 || e.path === "anchors") {
            // Anchor failure: keep both inputs and every selected marker,
            // flag the single offending anchor, and show no new timeline.
            setError({
              message: e.message,
              path: e.path,
              side: null,
              anchorIndex: anchorIndex >= 0 ? anchorIndex : undefined,
            });
          } else if (termIndex >= 0 || e.path === "term_pairs") {
            // Term-pair failure: keep notes, anchors and every declared
            // term, flag the single conflicting pair, and keep the last
            // valid timeline on screen (a term conflict is a declaration
            // problem, not a reason to discard the previously computed one).
            if (lastResult) setResult(lastResult);
            setError({
              message: e.message,
              path: e.path,
              side: null,
              termIndex: termIndex >= 0 ? termIndex : undefined,
            });
          } else {
            const side: Side = e.path.startsWith("right") ? "right" : "left";
            setError({ message: e.message, path: e.path, side });
          }
        } else if (e instanceof AlignRequestError) {
          setError({ message: e.message, path: "", side: null });
        } else {
          setError({
            message: "发生未知错误，请稍后重试。",
            path: "",
            side: null,
          });
        }
      }
    } finally {
      setLoading(false);
    }
  }

  function failJson(side: Side, text: string, e: unknown) {
    const pos = e instanceof JsonSourceError ? e.pos : 0;
    const { line, column } = locateOffset(text, pos);
    const reason = e instanceof Error ? e.message : "非法 JSON。";
    setError({
      message: `第 ${line} 行第 ${column} 列无法解析：${reason}`,
      path: "",
      side,
      offset: pos,
    });
  }

  // A passing audit report is only valid for the inputs it verified: any
  // change to the notes, anchors or term pairs retires it (the pasted
  // candidate itself is always retained). The in-flight generation is bumped
  // too, so a late audit response for superseded inputs is ignored.
  const anchorsKey = JSON.stringify(anchors);
  const termsKey = JSON.stringify(termPairs);
  useEffect(() => {
    auditSeq.current += 1;
    setAuditResult(null);
    setAuditError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftText, rightText, anchorsKey, termsKey]);

  /** Source range of the audited candidate's first error, for highlighting. */
  function auditMarker(): Range | null {
    if (!auditError) return null;
    if (auditError.offset !== undefined) {
      const len = auditText.length;
      return { start: auditError.offset, end: Math.min(auditError.offset + 1, len) };
    }
    if (!auditLocated || !auditError.path.startsWith("candidate")) return null;
    const rel = auditError.path.slice("candidate".length);
    if (rel === "") return auditLocated.ranges.get("") ?? null;
    // Try the member (key:value), then the value range, then progressively
    // strip the trailing field so a step-level path highlights its whole row.
    let cur = rel;
    while (cur.length > 0) {
      const found =
        auditLocated.memberRanges.get(cur) ?? auditLocated.ranges.get(cur);
      if (found) return found;
      const dot = cur.lastIndexOf(".");
      const bracket = cur.lastIndexOf("[");
      const cut = Math.max(dot, bracket);
      if (cut <= 0) break;
      cur = cur.slice(0, cut);
    }
    return auditLocated.ranges.get("") ?? null;
  }

  function failAuditJson(e: unknown) {
    const pos = e instanceof JsonSourceError ? e.pos : 0;
    const { line, column } = locateOffset(auditText, pos);
    const reason = e instanceof Error ? e.message : "非法 JSON。";
    setAuditError({
      message: `第 ${line} 行第 ${column} 列无法解析：${reason}`,
      path: "",
      stepIndex: -1,
      offset: pos,
    });
  }

  /**
   * Verify the pasted candidate against the CURRENT notes, anchors and term
   * pairs. The pasted text is never cleared or replaced: on failure the first
   * differing candidate row is localized (source highlight + preview row) and
   * the last PASSING report is intentionally left untouched.
   */
  async function handleAuditSubmit() {
    setAuditError(null);
    setAuditLoading(true);
    const generation = ++auditSeq.current;
    const isCurrent = () => generation === auditSeq.current;
    try {
      // Phase 1: the pasted candidate must itself parse as JSON.
      let auditParsed: ReturnType<typeof parseLocated>;
      try {
        auditParsed = parseLocated(auditText);
      } catch (e) {
        failAuditJson(e);
        return;
      }

      // Phase 2: the notes/anchors/terms the candidate is verified against
      // must be valid (mirrors the align flow; the server stays authoritative).
      if (!located.left) {
        setAuditError({
          message: "左侧笔记不是合法 JSON，请先在上方修正后再核验。",
          path: "left",
          stepIndex: -1,
        });
        return;
      }
      if (!located.right) {
        setAuditError({
          message: "右侧笔记不是合法 JSON，请先在上方修正后再核验。",
          path: "right",
          stepIndex: -1,
        });
        return;
      }
      const localLeft = validateSequence(located.left.value);
      if (localLeft) {
        setAuditError({
          message: localLeft.message,
          path: `left${localLeft.path}`,
          stepIndex: -1,
        });
        return;
      }
      const localRight = validateSequence(located.right.value);
      if (localRight) {
        setAuditError({
          message: localRight.message,
          path: `right${localRight.path}`,
          stepIndex: -1,
        });
        return;
      }
      const m = (located.left.value as unknown[]).length;
      const n = (located.right.value as unknown[]).length;
      const anchorIssue = validateAnchors(anchors, m, n);
      if (anchorIssue) {
        setAuditError({
          message: anchorIssue.message,
          path: anchorIssue.path,
          stepIndex: -1,
        });
        return;
      }
      const termIssue = validateTermPairs(termPairs);
      if (termIssue) {
        setAuditError({
          message: termIssue.message,
          path: termIssue.path,
          stepIndex: -1,
        });
        return;
      }

      // Phase 2b: the candidate structure (actions, slots, costs, provenance).
      const candidateIssue = validateCandidate(auditParsed.value);
      if (candidateIssue) {
        setAuditError({
          message: candidateIssue.message,
          path: candidateIssue.path,
          stepIndex: candidateIssue.stepIndex,
        });
        return;
      }

      // Phase 3: the server replays the candidate under the current rules.
      const candidateRaw = rootRawText(auditText);
      const anchorsToSend = anchors.length > 0 ? anchors : undefined;
      const termsToSend = termPairs.length > 0 ? termPairs : undefined;
      try {
        const outcome = await auditNotes(
          rootRawText(leftText),
          rootRawText(rightText),
          candidateRaw,
          fetch,
          anchorsToSend,
          termsToSend,
        );
        if (!isCurrent()) return;
        setAuditResult(outcome);
      } catch (e) {
        if (!isCurrent()) return;
        if (e instanceof AlignRequestError) {
          setAuditError({
            message: e.message,
            path: e.path,
            stepIndex: stepIndexFromPath(e.path),
            expected: e.expected,
            actual: e.actual,
          });
        } else {
          setAuditError({
            message: "发生未知错误，请稍后重试。",
            path: "",
            stepIndex: -1,
          });
        }
      }
    } finally {
      setAuditLoading(false);
    }
  }

  /** Prefill the candidate box from the current optimal timeline. */
  function fillAuditFromResult() {
    if (!result) return;
    auditSeq.current += 1;
    const candidate = {
      steps: result.steps.map((s) => {
        const row: Record<string, unknown> = {
          action: s.action,
          left: s.left,
          right: s.right,
          cost: s.cost,
          cumulative_cost: s.cumulative_cost,
        };
        if (s.origin) row.origin = s.origin;
        if (s.term_pair) row.term_pair = s.term_pair;
        return row;
      }),
      total_cost: result.total_cost,
    };
    setAuditText(stringifyBigJson(candidate));
    setAuditError(null);
  }

  function loadSample() {
    submitSeq.current += 1;
    setLeftText(SAMPLE_LEFT);
    setRightText(SAMPLE_RIGHT);
    setAnchors([]);
    setSelLeft(null);
    setSelRight(null);
    setTermPairs([]);
    setTermLeftDraft("");
    setTermRightDraft("");
    setError(null);
    setResult(null);
    setRevealed(0);
  }

  function clearAll() {
    submitSeq.current += 1;
    setLeftText("[]");
    setRightText("[]");
    setAnchors([]);
    setSelLeft(null);
    setSelRight(null);
    setTermPairs([]);
    setTermLeftDraft("");
    setTermRightDraft("");
    setError(null);
    setResult(null);
    setRevealed(0);
  }

  // Step-by-step replay: only the first `revealed` rows (and their running
  // total) are shown, letting the user re-add costs one action at a time.
  const visibleResult: AlignResponse | null = useMemo(() => {
    if (!result) return null;
    if (revealed >= result.steps.length) return result;
    return { ...result, steps: result.steps.slice(0, revealed) };
  }, [result, revealed]);

  const runningTotal: Int =
    visibleResult && visibleResult.steps.length > 0
      ? visibleResult.steps[visibleResult.steps.length - 1].cumulative_cost
      : 0;

  const flaggedAnchorIndex =
    error && error.path.startsWith("anchors") ? error.anchorIndex ?? -1 : -1;
  const flaggedTermIndex =
    error && error.path.startsWith("term_pairs") ? error.termIndex ?? -1 : -1;

  return (
    <main className="page">
      <header>
        <h1>口译交接时间轴对齐</h1>
        <p className="subtitle">
          两组递增毫秒笔记的全局最优对齐 · 动态规划实现，未使用任何外部匹配库
        </p>
      </header>

      <section className="inputs">
        <HighlightedTextarea
          value={leftText}
          onChange={(v) => {
            submitSeq.current += 1;
            setLeftText(v);
            setError(null);
            setResult(null);
          }}
          label="左侧口译员笔记（JSON 数组，最多 200 项）"
          marker={markerFor("left")}
          testId="input-left"
          invalid={error?.side === "left"}
        />
        <HighlightedTextarea
          value={rightText}
          onChange={(v) => {
            submitSeq.current += 1;
            setRightText(v);
            setError(null);
            setResult(null);
          }}
          label="右侧口译员笔记（JSON 数组，最多 200 项）"
          marker={markerFor("right")}
          testId="input-right"
          invalid={error?.side === "right"}
        />
      </section>

      <AnchorPanel
        leftNotes={leftNotes}
        rightNotes={rightNotes}
        anchors={anchors}
        errorIndex={flaggedAnchorIndex}
        selLeft={selLeft}
        selRight={selRight}
        onPick={handlePick}
        onRemove={removeAnchor}
      />

      <TermPairPanel
        termPairs={termPairs}
        errorIndex={flaggedTermIndex}
        leftDraft={termLeftDraft}
        rightDraft={termRightDraft}
        onDraftLeft={setTermLeftDraft}
        onDraftRight={setTermRightDraft}
        onAdd={addTermPair}
        onRemove={removeTermPair}
      />

      <section className="controls">
        <button
          type="button"
          className="primary"
          data-testid="submit"
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? "对齐中…" : "生成对齐"}
        </button>
        <button type="button" onClick={loadSample} data-testid="sample">
          载入示例
        </button>
        <button type="button" onClick={clearAll} data-testid="clear">
          清空为 []
        </button>
        <label className="compare-toggle" data-testid="compare-toggle">
          <input
            type="checkbox"
            data-testid="compare-alternative"
            checked={compareAlt}
            onChange={(e) => {
              submitSeq.current += 1;
              setCompareAlt(e.target.checked);
              setError(null);
              setResult(null);
            }}
          />
          <span>比较备选对齐</span>
        </label>
        {result && (
          <span className="replay">
            <button
              type="button"
              data-testid="step-back"
              onClick={() => setRevealed((n) => Math.max(0, n - 1))}
              disabled={revealed === 0}
            >
              ◀ 上一步
            </button>
            <span data-testid="replay-count">
              复算 {revealed} / {result.steps.length} 步 · 当前累计 {String(runningTotal)}
            </span>
            <button
              type="button"
              data-testid="step-next"
              onClick={() =>
                setRevealed((n) => Math.min(result.steps.length, n + 1))
              }
              disabled={revealed >= result.steps.length}
            >
              下一步 ▶
            </button>
          </span>
        )}
      </section>

      {error && (
        <div className="error-banner" role="alert" data-testid="error-banner">
          <strong>仅有一处失败：</strong>
          {error.path && (
            <code data-testid="error-path">{error.path} </code>
          )}
          <span>{error.message}</span>
        </div>
      )}

      {visibleResult && (
        <ResultTimeline result={visibleResult} runningTotal={runningTotal} />
      )}

      <AuditPanel
        value={auditText}
        onChange={(v) => {
          auditSeq.current += 1;
          setAuditText(v);
          setAuditError(null);
        }}
        marker={auditMarker()}
        invalid={!!auditError}
        rows={auditRows}
        error={auditError}
        loading={auditLoading}
        result={auditResult}
        onSubmit={handleAuditSubmit}
        onFillFromResult={fillAuditFromResult}
        canFillFromResult={!!result}
      />
    </main>
  );
}
