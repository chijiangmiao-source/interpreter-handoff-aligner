import { useMemo, useState } from "react";
import AnchorPanel, { type PickerNote } from "./AnchorPanel";
import HighlightedTextarea from "./HighlightedTextarea";
import ResultTimeline from "./ResultTimeline";
import { alignNotes, rootRawText, AlignRequestError } from "./api";
import { validateAnchors } from "./anchors";
import {
  JsonSourceError,
  locateOffset,
  parseLocated,
  type Range,
} from "./jsonLocations";
import { validateSequence } from "./validation";
import type { AlignResponse, Anchor, Int } from "./types";

type Side = "left" | "right";

interface MarkedError {
  message: string;
  /** full API-style path such as `left[2].time` or `anchors[1].left` */
  path: string;
  side: Side | null;
  /** index into the anchors array when this failure concerns an anchor */
  anchorIndex?: number;
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

export default function App() {
  const [leftText, setLeftText] = useState(SAMPLE_LEFT);
  const [rightText, setRightText] = useState(SAMPLE_RIGHT);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const [error, setError] = useState<MarkedError | null>(null);
  const [result, setResult] = useState<AlignResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealed, setRevealed] = useState(0);

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

  function addAnchor(candidate: Anchor): string | null {
    const tentative = [...anchors, candidate];
    // Local, single-failure check mirrors the server (range, reuse, order).
    const issue = validateAnchors(
      tentative,
      leftNotes.length,
      rightNotes.length,
    );
    if (issue) {
      setPickError(issue.message);
      return issue.message;
    }
    setAnchors(tentative);
    setPickError(null);
    setError(null);
    setResult(null);
    return null;
  }

  function removeAnchor(index: number) {
    setAnchors((prev) => prev.filter((_, k) => k !== index));
    setPickError(null);
    setError(null);
    setResult(null);
  }

  async function handleSubmit() {
    setError(null);
    setResult(null);
    setPickError(null);
    setLoading(true);
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

      // --- Phase 3: the server performs the DP alignment ------------------
      // The raw array source is forwarded verbatim so integer literals
      // beyond Number.MAX_SAFE_INTEGER keep their exact digits. Anchors are
      // only sent when at least one is confirmed, keeping anchor-free
      // requests and responses byte-for-byte identical to the legacy API.
      const leftRaw = rootRawText(leftText);
      const rightRaw = rootRawText(rightText);
      const anchorsToSend = anchors.length > 0 ? anchors : undefined;
      try {
        const aligned = await alignNotes(leftRaw, rightRaw, fetch, anchorsToSend);
        setResult(aligned);
        setRevealed(aligned.steps.length);
      } catch (e) {
        if (e instanceof AlignRequestError && e.path) {
          const anchorIndex = anchorIndexFromPath(e.path);
          if (anchorIndex >= 0 || e.path === "anchors") {
            // Anchor failure: keep both inputs and every selected marker,
            // flag the single offending anchor, and show no new timeline.
            setError({
              message: e.message,
              path: e.path,
              side: null,
              anchorIndex: anchorIndex >= 0 ? anchorIndex : undefined,
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

  function loadSample() {
    setLeftText(SAMPLE_LEFT);
    setRightText(SAMPLE_RIGHT);
    setAnchors([]);
    setPickError(null);
    setError(null);
    setResult(null);
    setRevealed(0);
  }

  function clearAll() {
    setLeftText("[]");
    setRightText("[]");
    setAnchors([]);
    setPickError(null);
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
        pickError={pickError}
        onAdd={addAnchor}
        onRemove={removeAnchor}
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
    </main>
  );
}
