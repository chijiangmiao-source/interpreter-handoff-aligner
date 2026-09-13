import { useEffect, useRef } from "react";
import HighlightedTextarea from "./HighlightedTextarea";
import type { Range } from "./jsonLocations";
import type { AuditResponse, Int } from "./types";
import type { CandidateRow } from "./candidate";

/** A single audit failure (structural, malformed JSON or semantic mismatch). */
export interface AuditPanelError {
  message: string;
  /** full server-style path such as `candidate.steps[2].cost` */
  path: string;
  /** index into candidate.steps, or -1 for the root/malformed JSON */
  stepIndex: number;
  /** character offset inside the candidate textarea (malformed JSON) */
  offset?: number;
  /** semantic mismatch values (present on server 422 audit failures) */
  expected?: unknown;
  actual?: unknown;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  marker: Range | null;
  invalid: boolean;
  rows: CandidateRow[];
  error: AuditPanelError | null;
  loading: boolean;
  result: AuditResponse | null;
  onSubmit: () => void;
  onFillFromResult: () => void;
  canFillFromResult: boolean;
}

function n(v: Int): string {
  return typeof v === "bigint" ? v.toString() : String(v);
}

/** Render an expected/actual value (may be a note object, index string…). */
function fmtValue(v: unknown): string {
  if (v === undefined) return "—";
  return JSON.stringify(v, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

const ACTION_LABEL: Record<CandidateRow["action"], string> = {
  match: "配对",
  left_gap: "左侧留空",
  right_gap: "右侧留空",
};

/**
 * Independent "核验时间轴" workspace: the lead pastes a candidate an external
 * collaborator hand-adjusted and verifies it against the CURRENT left/right
 * notes, anchors and term pairs. The pasted text is always retained: a failed
 * verification localizes the first offending candidate row (source highlight
 * plus the flagged preview row) and never replaces the last passing report.
 */
export default function AuditPanel({
  value,
  onChange,
  marker,
  invalid,
  rows,
  error,
  loading,
  result,
  onSubmit,
  onFillFromResult,
  canFillFromResult,
}: Props) {
  const flaggedRef = useRef<HTMLLIElement | null>(null);

  // Bring the first offending candidate row into view when flagged (jsdom has
  // no scrollIntoView, so call it only when the browser provides it).
  useEffect(() => {
    if (error && error.stepIndex >= 0) {
      flaggedRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    }
  }, [error]);

  const flaggedIndex = error?.stepIndex ?? -1;

  return (
    <section className="audit" data-testid="audit-panel">
      <h2>核验时间轴</h2>
      <p className="audit-hint" data-testid="audit-hint">
        外部协作方人工调整后，把候选结果粘贴到此处。核验沿用当前左右笔记、锚点与术语对，
        逐行检查动作与空侧一致性、原始笔记是否<strong>完整、按序且只使用一次</strong>、
        锚点固定关系、术语命中代价、累计代价与总代价。粘贴内容始终保留：失败时仅定位首个
        确定差异的候选行，不会用无效报告替换上次通过的结论。
      </p>

      <HighlightedTextarea
        value={value}
        onChange={onChange}
        label="候选时间轴（JSON 对象，须包含 steps 与 total_cost）"
        marker={marker}
        testId="audit-input"
        invalid={invalid}
      />

      <div className="audit-controls">
        <button
          type="button"
          className="primary"
          data-testid="audit-submit"
          onClick={onSubmit}
          disabled={loading}
        >
          {loading ? "核验中…" : "核验候选时间轴"}
        </button>
        <button
          type="button"
          data-testid="audit-fill"
          onClick={onFillFromResult}
          disabled={!canFillFromResult}
          title="把当前最优时间轴整理为候选格式，便于在协作方调整版的基础上核对"
        >
          用当前对齐结果填入
        </button>
      </div>

      {error && (
        <div className="audit-banner" role="alert" data-testid="audit-error-banner">
          <div>
            <strong>核验未通过，首个确定差异：</strong>
            {error.path && (
              <code data-testid="audit-error-path">{error.path} </code>
            )}
            <span>{error.message}</span>
          </div>
          {(error.expected !== undefined || error.actual !== undefined) && (
            <div className="audit-diff" data-testid="audit-error-diff">
              <span>
                <strong>预期值：</strong>
                <code data-testid="audit-expected">{fmtValue(error.expected)}</code>
              </span>
              <span>
                <strong>实际值：</strong>
                <code data-testid="audit-actual">{fmtValue(error.actual)}</code>
              </span>
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="audit-preview" data-testid="audit-preview">
          <h3>候选行（{rows.length}）</h3>
          <ul className="audit-row-list">
            {rows.map((row, k) => {
              const flagged = k === flaggedIndex;
              return (
                <li
                  key={k}
                  ref={flagged ? flaggedRef : undefined}
                  className={`audit-row${flagged ? " invalid" : ""}`}
                  data-testid="audit-candidate-row"
                  data-row={k}
                >
                  <span className="audit-row-idx">#{k + 1}</span>
                  <span className={`action-tag tag-${row.action}`}>
                    {ACTION_LABEL[row.action]}
                  </span>
                  <span className="audit-row-note">
                    {row.left ? (
                      <>
                        <em>left</em> {n(row.left.time)} ms · {row.left.text}
                      </>
                    ) : (
                      <span className="empty">左 ∅</span>
                    )}
                  </span>
                  <span className="audit-row-link">↔</span>
                  <span className="audit-row-note">
                    {row.right ? (
                      <>
                        <em>right</em> {n(row.right.time)} ms · {row.right.text}
                      </>
                    ) : (
                      <span className="empty">右 ∅</span>
                    )}
                  </span>
                  <span className="audit-row-cost">
                    单步 {n(row.cost)} · 累计 {n(row.cumulative_cost)}
                  </span>
                  {row.origin && (
                    <span className={`origin-tag tag-origin-${row.origin}`}>
                      {row.origin === "anchor" ? "人工锚点" : "算法生成"}
                    </span>
                  )}
                  {flagged && (
                    <span className="audit-row-flag" data-testid="audit-row-flag">
                      ↑ 首个差异行
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {result && <AuditPass result={result} />}
    </section>
  );
}

/** The pass conclusion plus the row-by-row recomputation details. */
function AuditPass({ result }: { result: AuditResponse }) {
  return (
    <div className="audit-pass" data-testid="audit-pass">
      <h3>✓ 核验通过</h3>
      <p className="audit-pass-summary" data-testid="audit-pass-summary">
        候选时间轴的 {result.consumed.left} 条左侧笔记与 {result.consumed.right} 条右侧笔记
        均<strong>完整、按序且只使用一次</strong>；动作与空侧一致
        {result.anchors && result.anchors.length > 0
          ? `，${result.anchors.length} 个人工锚点全部固定入列`
          : ""}
        ；术语命中、单步代价、累计代价与总代价均可按当前规则逐行复算。
      </p>
      <div className="summary">
        <span className="badge match">配对 {result.counts.match}</span>
        <span className="badge left-gap">左侧留空 {result.counts.left_gap}</span>
        <span className="badge right-gap">右侧留空 {result.counts.right_gap}</span>
        <span className="badge total">
          复算总代价 <strong data-testid="audit-total-cost">{n(result.total_cost)}</strong>
        </span>
      </div>

      <div className="table-scroll">
        <table className="timeline audit-detail">
          <thead>
            <tr>
              <th>#</th>
              <th>动作</th>
              <th>使用的原始笔记</th>
              <th>来源</th>
              <th>逐行复算</th>
              <th>单步代价</th>
              <th>累计代价</th>
            </tr>
          </thead>
          <tbody>
            {result.steps.map((d) => (
              <tr
                key={d.index}
                className={`row-${d.action}`}
                data-testid="audit-detail-row"
                data-row={d.index}
              >
                <td className="idx">{d.index + 1}</td>
                <td>
                  <span className={`action-tag tag-${d.action}`}>
                    {ACTION_LABEL[d.action]}
                  </span>
                </td>
                <td>
                  <code>
                    {d.consumed.left === null ? "左 ∅" : `left[${d.consumed.left}]`}
                  </code>
                  <span className="audit-row-link"> ↔ </span>
                  <code>
                    {d.consumed.right === null ? "右 ∅" : `right[${d.consumed.right}]`}
                  </code>
                </td>
                <td>
                  {d.origin === "anchor" && (
                    <span className="origin-tag tag-origin-anchor">人工锚点</span>
                  )}
                  {d.expected_term_pair && (
                    <span
                      className="origin-tag tag-origin-term"
                      data-testid="audit-detail-term"
                      title={`${d.expected_term_pair.left_text} ≡ ${d.expected_term_pair.right_text}`}
                    >
                      术语等价
                    </span>
                  )}
                  {!d.origin && !d.expected_term_pair && (
                    <span className="origin-tag origin-none">—</span>
                  )}
                </td>
                <td className="explain" data-testid="audit-detail-basis">
                  {d.basis}
                </td>
                <td className="cost" data-testid="audit-detail-cost">
                  {n(d.expected_cost)}
                  {n(d.expected_cost) === n(d.actual_cost) ? "" : `（候选 ${n(d.actual_cost)}）`}
                </td>
                <td className="cumulative" data-testid="audit-detail-cumulative">
                  {n(d.expected_cumulative_cost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
