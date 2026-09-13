import type { Anchor } from "./types";

/** A parsed record as presented for anchor picking (may be malformed). */
export interface PickerNote {
  index: number;
  time: unknown;
  text: unknown;
}

interface Props {
  leftNotes: PickerNote[];
  rightNotes: PickerNote[];
  anchors: Anchor[];
  /** Index of the anchor the server/client flagged, -1 when none. */
  errorIndex: number;
  /** Half-made pair selection, owned by the parent so it can be reset. */
  selLeft: number | null;
  selRight: number | null;
  onPick: (side: "left" | "right", idx: number) => void;
  onRemove: (index: number) => void;
}

function asTime(v: unknown): string {
  if (typeof v === "bigint" || typeof v === "number") return String(v);
  return "—";
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : "—";
}

/**
 * Lets the lead reviewer mark/remove human-confirmed pair anchors. Click one
 * left record and one right record to pin a pair; click a pinned record again
 * to unpin it. Anchors are the only rows that can later be styled as
 * human-confirmed in the result timeline; everything else stays DP-generated.
 *
 * The component is purely presentational: the pending selection and the
 * pairing rules live in the parent, so resetting the inputs always resets
 * the picker too, and a rule-violating pair stays listed and flagged instead
 * of vanishing from one side.
 */
export default function AnchorPanel({
  leftNotes,
  rightNotes,
  anchors,
  errorIndex,
  selLeft,
  selRight,
  onPick,
  onRemove,
}: Props) {
  const anchorUsing = (side: "left" | "right", idx: number): number =>
    anchors.findIndex((a) => a[side] === idx);

  const renderColumn = (
    side: "left" | "right",
    notes: PickerNote[],
    selected: number | null,
    testId: string,
  ) => (
    <div className="anchor-col">
      <h3>{side === "left" ? "左侧记录" : "右侧记录"}</h3>
      {notes.length === 0 && <p className="anchor-empty">暂无可选记录</p>}
      <ul className="note-picker" data-testid={testId}>
        {notes.map((note) => {
          const used = anchorUsing(side, note.index);
          const isSel = selected === note.index;
          const classes = [
            "pick-row",
            used >= 0 ? "used" : "",
            isSel ? "selected" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={note.index}>
              <button
                type="button"
                className={classes}
                data-testid={`pick-${side}-${note.index}`}
                data-used={used >= 0}
                data-selected={isSel}
                onClick={() => onPick(side, note.index)}
              >
                <span className="pick-idx">{side}[{note.index}]</span>
                <span className="pick-time">{asTime(note.time)} ms</span>
                <span className="pick-text">{asText(note.text)}</span>
                {used >= 0 && <span className="pick-flag">已锚定 · 点击取消</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <section className="anchors" data-testid="anchor-panel">
      <h2>人工确认锚点</h2>
      <p className="anchor-hint" data-testid="anchor-hint">
        各点选一条左右记录即可固定一对锚点；提交后系统沿用原始两组输入，以锚点切分区间
        运行同一套动态规划，锚点行计入原有配对代价。再次点击已锚定记录可取消配对。
      </p>
      <div className="anchor-columns">
        {renderColumn("left", leftNotes, selLeft, "picker-left")}
        {renderColumn("right", rightNotes, selRight, "picker-right")}
      </div>

      <h3>已确认锚点（{anchors.length}）</h3>
      {anchors.length === 0 ? (
        <p className="anchor-empty" data-testid="anchor-empty">
          尚未标记锚点，将生成完全无约束的最优时间轴。
        </p>
      ) : (
        <ul className="anchor-list" data-testid="anchor-list">
          {anchors.map((a, k) => {
            const flagged = k === errorIndex;
            return (
              <li
                key={`${a.left}-${a.right}`}
                className={`anchor-item${flagged ? " invalid" : ""}`}
                data-testid="anchor-item"
                data-anchor-index={k}
              >
                <span className="anchor-pair">
                  <strong>#{k + 1}</strong>
                  <code>left[{a.left}]</code>
                  <span className="anchor-link">↔</span>
                  <code>right[{a.right}]</code>
                </span>
                <button
                  type="button"
                  className="anchor-remove"
                  data-testid={`anchor-remove-${k}`}
                  onClick={() => onRemove(k)}
                >
                  取消配对
                </button>
                {flagged && (
                  <span className="anchor-error" data-testid="anchor-error">
                    ↑ 首个确定错误
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
