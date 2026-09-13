import type { AlignResponse, AlignStep, Int } from "./types";

const ACTION_LABEL: Record<AlignStep["action"], string> = {
  match: "配对",
  left_gap: "左侧留空",
  right_gap: "右侧留空",
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

  return (
    <section className="result" data-testid="result-panel">
      <h2>唯一最优时间轴</h2>
      <p className="legend" data-testid="legend">
        代价规则：相同文本配对 = 时间差绝对值；不同文本配对 = 时间差 + 3000；
        任一侧留空 = 2000。平局时优先配对，其次左侧留空，再次右侧留空。
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

      <div className="table-scroll">
        <table className="timeline">
          <thead>
            <tr>
              <th>#</th>
              <th>左侧口译员</th>
              <th>动作</th>
              <th>右侧口译员</th>
              <th>单步代价</th>
              <th>累计代价</th>
              <th>复算</th>
            </tr>
          </thead>
          <tbody>
            {result.steps.map((step, idx) => (
              <tr
                key={idx}
                className={`row-${step.action}`}
                data-testid="timeline-row"
                data-action={step.action}
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
                <td className="cost" data-testid="step-cost">
                  {n(step.cost)}
                </td>
                <td className="cumulative" data-testid="step-cumulative">
                  {n(step.cumulative_cost)}
                </td>
                <td className="explain">{costExplanation(step)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="total-label">
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
