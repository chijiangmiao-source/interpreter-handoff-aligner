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

export interface AlignResponse {
  steps: AlignStep[];
  total_cost: Int;
  counts: { match: number; left_gap: number; right_gap: number };
  costs: { gap: number; mismatch_penalty: number };
  /** Echoed back only for anchored requests. */
  anchors?: Anchor[];
}

export interface ApiError {
  error: string;
  path: string;
}
