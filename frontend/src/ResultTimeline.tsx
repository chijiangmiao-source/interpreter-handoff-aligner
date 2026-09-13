import { Fragment } from "react";
import type { AlignResponse, AlignStep, AlternativeAlignment, Int } from "./types";

const ACTION_LABEL: Record<AlignStep["action"], string> = {
  match: "配对",
  left_gap: "左侧留空",
  right_gap: "右侧留空",
};

const ORIGIN_LABEL: Record<NonNullable<AlignStep["origin"]>, string> = {
  anchor: "人工锚点",
  auto: "算法生成",
};

function n(v: Int): string {
  return typeof v === "bigint" ? v.toString() : String(v);
}

function absDiff(a: Int, b: Int): string {
  if (typeof a === "bigint" || typeof b === "bigint") {
    const x = BigInt(a);
    const y = BigInt(b);
    return n(x > y ? x - y : y - x);
  }
  return String(Math.abs(a - b));
}

function fmtTime(t: Int | null | undefined): string {
  return t === null || t === undefined ? "—" : `${n(t)} ms`;
}

/** Content identity of a row, to locate where the two timelines split. */
function stepKey(step: AlignStep): string {
  const l = step.left ? `${step.left.time}|${step.left.text}` : "∅";
  const r = step.right ? `${step.right.time}|${step.right.text}` : "∅";
  return `${step.action}|${l}|${r}`;
}

/** First primary row whose pairing differs from the alternative path (-1 never). */
function divergenceRowIndex(
  primary: AlignStep[],
  alternative: AlternativeAlignment,
): number {
  for (let k = 0; k < primary.length && k < alternative.steps.length; k++) {
    if (stepKey(primary[k]) !== stepKey(alternative.steps[k])) return k;
  }
  return -1;
}

/** Human-readable recomputation of the single-step cost, row by row. */
function costExplanation(step: AlignStep): string {
  if (step.action === "left_gap" || step.action === "right_gap") {
    return "单侧留空 = 2000";
  }
  const lt = step.left!.time;
  const rt = step.right!.time;
  const diff = absDiff(lt, rt);
  const same = step.left!.text === step.right!.text;
  if (same) {
    return `相同文本：|${n(lt)} − ${n(rt)}| = ${diff}`;
  }
  return `不同文本：|${n(lt)} − ${n(rt)}| + 3000 = ${diff} + 3000 = ${n(step.cost)}`;
}

export default function ResultTimeline({
  result,
  runningTotal,
}: {
  result: AlignResponse;
  runningTotal?: Int;
}) {
  const shownTotal: Int = runningTotal ?? result.total_cost;
  const sumOfStepCosts = result.steps.reduce<Int>(
    (acc, s) => (typeof acc === "bigint" || typeof s.cost === "bigint"
      ? BigInt(acc) + BigInt(s.cost)
      : acc + (s.cost as number)),
    0,
  );

  // `compare_alternative: true` responses carry the field as an object (an
  // alternative exists) or null (unique legal path); absent means the flag
  // was off and the legacy response deliberately says nothing about it.
  const compareRequested = "alternative" in result;
  const alternative = result.alternative ?? null;
  const divergence = alternative
    ? divergenceRowIndex(result.steps, alternative)
    : -1;
  const divergenceVisible = divergence >= 0 && divergence < result.steps.length;

  return (
    <section className="result" data-testid="result-panel">
      <h2>唯一最优时间轴</h2>
      <p className="legend" data-testid="legend">
        代价规则：相同文本配对 = 时间差绝对值；不同文本配对 = 时间差 + 3000；
        任一侧留空 = 2000。平局时优先配对，其次左侧留空，再次右侧留空。
        {result.anchors && result.anchors.length > 0 && (
          <span className="legend-anchors" data-testid="legend-anchors">
            {" "}本次含 {result.anchors.length} 个人工锚点，标记为「人工锚点」的行固定入列，
            其余行为各区间内动态规划生成，逐步复算仍汇总到同一总代价。
          </span>
        )}
      </p>
      <div className="summary" data-testid="summary">
        <span className="badge match">配对 {result.counts.match}</span>
        <span className="badge left-gap">左侧留空 {result.counts.left_gap}</span>
        <span className="badge right-gap">右侧留空 {result.counts.right_gap}</span>
        <span className="badge total">
          {runningTotal !== undefined &&
          n(runningTotal) !== n(result.total_cost)
            ? "复算累计 "
            : "总代价 "}
          <strong data-testid="total-cost">{n(shownTotal)}</strong>
          {runningTotal !== undefined && n(runningTotal) !== n(result.total_cost)
            ? `（最终 ${n(result.total_cost)}）`
            : ""}
        </span>
      </div>

      {compareRequested && alternative && (
        <p className="alt-summary" data-testid="alternative-summary">
          已按同一代价与平局规则选出严格次优完整路径：备选总代价
          <strong data-testid="alternative-total"> {n(alternative.total_cost)}</strong>
          ，与最优路径的成本差
          <strong data-testid="alternative-diff"> {n(alternative.cost_diff)}</strong>
          {n(alternative.cost_diff) === "0"
            ? "（同代价，按平局规则确定顺序）"
            : ""}
          ；双方首处分歧涉及笔记索引
          <code data-testid="alternative-divergence">
            {" "}left[{alternative.first_divergence.left ?? "∅"}] ↔
            right[{alternative.first_divergence.right ?? "∅"}]
          </code>
          {divergenceVisible
            ? "，备选配对已在该分歧行旁展开。"
            : "（逐步复算展开到该分歧行时显示备选配对）。"}
        </p>
      )}
      {compareRequested && !alternative && (
        <p className="alt-empty" data-testid="alternative-empty">
          当前锚点约束（或空输入）下合法路径唯一，不存在代价接近但配对方式不同的
          备选路径；上方即为唯一最优时间轴。
        </p>
      )}

      <div className="table-scroll">
        <table className="timeline">
          <thead>
            <tr>
              <th>#</th>
              <th>左侧口译员</th>
              <th>动作</th>
              <th>右侧口译员</th>
              <th>来源</th>
              <th>单步代价</th>
              <th>累计代价</th>
              <th>复算</th>
            </tr>
          </thead>
          <tbody>
            {result.steps.map((step, idx) => (
              <Fragment key={idx}>
                <tr
                  className={[
                    `row-${step.action}`,
                    step.origin === "anchor" ? "row-anchor" : "",
                    divergenceVisible && idx === divergence ? "row-divergence" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-testid="timeline-row"
                  data-action={step.action}
                  data-origin={step.origin ?? ""}
                >
                  <td className="idx">{idx + 1}</td>
                  <td className="note-cell">
                    {step.left ? (
                      <>
                        <span className="time">{fmtTime(step.left.time)}</span>
                        <span className="text">{step.left.text}</span>
                      </>
                    ) : (
                      <span className="empty">∅</span>
                    )}
                  </td>
                  <td className="action-cell">
                    <span className={`action-tag tag-${step.action}`}>
                      {ACTION_LABEL[step.action]}
                    </span>
                  </td>
                  <td className="note-cell">
                    {step.right ? (
                      <>
                        <span className="time">{fmtTime(step.right.time)}</span>
                        <span className="text">{step.right.text}</span>
                      </>
                    ) : (
                      <span className="empty">∅</span>
                    )}
                  </td>
                  <td className="origin-cell">
                    {step.origin ? (
                      <span
                        className={`origin-tag tag-origin-${step.origin}`}
                        data-testid="step-origin"
                      >
                        {ORIGIN_LABEL[step.origin]}
                      </span>
                    ) : (
                      <span className="origin-tag origin-none">—</span>
                    )}
                  </td>
                  <td className="cost" data-testid="step-cost">
                    {n(step.cost)}
                  </td>
                  <td className="cumulative" data-testid="step-cumulative">
                    {n(step.cumulative_cost)}
                  </td>
                  <td className="explain">{costExplanation(step)}</td>
                </tr>
                {divergenceVisible && idx === divergence && (
                  <AlternativeRow alternative={alternative!} index={idx} />
                )}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="total-label">
                总成本最小
              </td>
              <td className="total-step">{n(sumOfStepCosts)}</td>
              <td className="total-final" data-testid="total-cost-foot">
                {n(result.total_cost)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/**
 * The single expansion row shown directly under the primary row where the
 * two timelines first diverge. It carries the alternative's pairing at that
 * row plus the cost gap; the rest of the runner-up timeline stays out of
 * the way so the primary timeline remains the focus.
 */
function AlternativeRow({
  alternative,
  index,
}: {
  alternative: AlternativeAlignment;
  index: number;
}) {
  const step = alternative.steps[index];
  return (
    <tr className="alt-row" data-testid="alternative-row" data-row={index}>
      <td className="idx alt-flag">
        备选
      </td>
      <td className="note-cell alt-cell">
        {step.left ? (
          <>
            <span className="time">{fmtTime(step.left.time)}</span>
            <span className="text">{step.left.text}</span>
          </>
        ) : (
          <span className="empty">∅</span>
        )}
      </td>
      <td className="action-cell alt-cell">
        <span className={`action-tag tag-${step.action}`}>
          {ACTION_LABEL[step.action]}
        </span>
      </td>
      <td className="note-cell alt-cell">
        {step.right ? (
          <>
            <span className="time">{fmtTime(step.right.time)}</span>
            <span className="text">{step.right.text}</span>
          </>
        ) : (
          <span className="empty">∅</span>
        )}
      </td>
      <td className="origin-cell alt-cell" colSpan={1}>
        <span className="alt-label">严格次优</span>
      </td>
      <td className="cost alt-cell" data-testid="alternative-step-cost">
        {n(step.cost)}
      </td>
      <td className="cumulative alt-cell" colSpan={2}>
        <span className="alt-gap" data-testid="alternative-row-gap">
          备选总代价 {n(alternative.total_cost)} · 成本差 +
          {n(alternative.cost_diff)}
        </span>
      </td>
    </tr>
  );
}
