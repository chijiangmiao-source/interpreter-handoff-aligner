/** Numeric values may be exact BigInts (large integer literals) or numbers. */
export type Int = number | bigint;

export interface Note {
  time: Int;
  text: string;
}

export type Action = "match" | "left_gap" | "right_gap";

/** A human-confirmed pair of 0-based record indices. */
export interface Anchor {
  left: number;
  right: number;
}

/**
 * A lead-declared term correspondence: a pairing whose two note texts equal
 * these strings verbatim is treated as synonymous (mismatch penalty waived).
 */
export interface TermPair {
  left_text: string;
  right_text: string;
}

/**
 * Provenance of a result row, present only when the request carried anchors:
 * "anchor" marks a row the human confirmed, "auto" a DP-generated row.
 */
export type RowOrigin = "anchor" | "auto";

export interface AlignStep {
  action: Action;
  left: Note | null;
  right: Note | null;
  cost: Int;
  cumulative_cost: Int;
  origin?: RowOrigin;
  /**
   * Present only on match rows whose two (different) texts are an exact hit
   * of a declared term pair; carries the pair that waived the penalty.
   */
  term_pair?: TermPair;
}

/**
 * Note indices involved at the two paths' first disagreement. An index is
 * null when the alternative's row at the divergence leaves that side blank.
 */
export interface FirstDivergence {
  left: number | null;
  right: number | null;
}

/**
 * The strictly second-best complete timeline, computed under exactly the
 * same costs and tie rules as the optimum. Present only when the request
 * carried `compare_alternative: true`; null then means the legal path is
 * unique (empty input or anchors pinning every pairing).
 */
export interface AlternativeAlignment {
  steps: AlignStep[];
  total_cost: Int;
  /** Always >= 0; zero means an equal-cost alternative resolved by ties. */
  cost_diff: Int;
  first_divergence: FirstDivergence;
}

export interface AlignResponse {
  steps: AlignStep[];
  total_cost: Int;
  counts: { match: number; left_gap: number; right_gap: number };
  costs: { gap: number; mismatch_penalty: number };
  /** Echoed back only for anchored requests. */
  anchors?: Anchor[];
  /** Echoed back only for requests carrying a non-empty term_pairs list. */
  term_pairs?: TermPair[];
  /** Present only for compare_alternative requests; null when unique. */
  alternative?: AlternativeAlignment | null;
}

export interface ApiError {
  error: string;
  path: string;
}

/**
 * One row of the server's row-by-row audit recomputation. The candidate passed
 * verification, so every actual value equals the value recomputed under the
 * current rules; `consumed` carries the original-note indices the row uses
 * (null on the side that is blank).
 */
export interface AuditStepDetail {
  index: number;
  action: Action;
  expected_cost: Int;
  actual_cost: Int;
  expected_cumulative_cost: Int;
  actual_cumulative_cost: Int;
  consumed: { left: number | null; right: number | null };
  basis: string;
  origin?: RowOrigin | null;
  expected_term_pair?: TermPair | null;
}

export interface AuditResponse {
  ok: true;
  total_cost: Int;
  counts: { match: number; left_gap: number; right_gap: number };
  consumed: { left: number; right: number };
  anchors?: Anchor[];
  steps: AuditStepDetail[];
}
