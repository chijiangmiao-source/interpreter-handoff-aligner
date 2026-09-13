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
  /** Present only for compare_alternative requests; null when unique. */
  alternative?: AlternativeAlignment | null;
}

export interface ApiError {
  error: string;
  path: string;
}
