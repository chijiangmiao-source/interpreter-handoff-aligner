import { useState } from "react";
import type { TermPair } from "./types";

interface Props {
  termPairs: TermPair[];
  /** Index of the term pair the server/client flagged, -1 when none. */
  errorIndex: number;
  /** Append a candidate pair; the parent flags same-side conflicts. */
  onAdd: (pair: TermPair) => void;
  onRemove: (index: number) => void;
}

/**
 * Lets the lead reviewer declare the terminology correspondences accepted for
 * this review before aligning: enter the left interpreter's wording and the
 * right interpreter's wording, then add the pair. Only an exact hit of a
 * declared pair waives the different-text mismatch penalty during pairing;
 * everything else (time difference, gaps, anchors, ties, alternative ranking)
 * keeps using the current rules.
 *
 * The pair list and the conflict flag live in the parent (mirrored server
 * validation): like a crossing anchor, a same-side duplicate mapping is kept
 * and flagged in place exactly once instead of being silently dropped, and
 * submissions preserve the notes, anchors and the declared terms without
 * replacing an existing result.
 */
export default function TermPairPanel({
  termPairs,
  errorIndex,
  onAdd,
  onRemove,
}: Props) {
  const [leftDraft, setLeftDraft] = useState("");
  const [rightDraft, setRightDraft] = useState("");

  function submitPair() {
    const left = leftDraft.trim();
    const right = rightDraft.trim();
    if (!left || !right) return;
    onAdd({ left_text: left, right_text: right });
    // The candidate is always appended (a conflict stays listed and flagged
    // in place), so the drafts can start a fresh pair.
    setLeftDraft("");
    setRightDraft("");
  }

  return (
    <section className="terms" data-testid="term-panel">
      <h2>复盘认可的术语对应</h2>
      <p className="term-hint" data-testid="term-hint">
        录入两名口译员对同一专名的不同译法：仅当配对的两条文本与某条术语对
        <strong>完全一致</strong>时视为同义，免除「文本不一致」的 3000 罚分；
        时间差、留空代价、锚点约束、平局顺序与备选路径排序均不变。
      </p>
      <div className="term-entry">
        <input
          type="text"
          className="term-input"
          data-testid="term-input-left"
          value={leftDraft}
          placeholder="左侧译法，如 人工智能"
          onChange={(e) => setLeftDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitPair();
          }}
        />
        <span className="term-link">↔</span>
        <input
          type="text"
          className="term-input"
          data-testid="term-input-right"
          value={rightDraft}
          placeholder="右侧译法，如 AI"
          onChange={(e) => setRightDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitPair();
          }}
        />
        <button
          type="button"
          className="term-add"
          data-testid="term-add"
          onClick={submitPair}
          disabled={!leftDraft.trim() || !rightDraft.trim()}
        >
          添加对应
        </button>
      </div>

      <h3>已认可术语对（{termPairs.length}）</h3>
      {termPairs.length === 0 ? (
        <p className="term-empty" data-testid="term-empty">
          尚未录入术语对应，文本不同的配对仍按原规则计 3000 罚分。
        </p>
      ) : (
        <ul className="term-list" data-testid="term-list">
          {termPairs.map((p, k) => {
            const flagged = k === errorIndex;
            return (
              <li
                key={`${p.left_text}-${p.right_text}-${k}`}
                className={`term-item${flagged ? " invalid" : ""}`}
                data-testid="term-item"
                data-term-index={k}
              >
                <span className="term-pair">
                  <strong>#{k + 1}</strong>
                  <code data-testid="term-item-left">{p.left_text}</code>
                  <span className="term-link">↔</span>
                  <code data-testid="term-item-right">{p.right_text}</code>
                </span>
                <button
                  type="button"
                  className="term-remove"
                  data-testid={`term-remove-${k}`}
                  onClick={() => onRemove(k)}
                >
                  删除对应
                </button>
                {flagged && (
                  <span className="term-error" data-testid="term-error">
                    ↑ 首个冲突项
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
