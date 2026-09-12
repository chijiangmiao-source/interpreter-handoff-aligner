export interface Note {
  time: number;
  text: string;
}

export type Action = "match" | "left_gap" | "right_gap";

export interface AlignStep {
  action: Action;
  left: Note | null;
  right: Note | null;
  cost: number;
  cumulative_cost: number;
}

export interface AlignResponse {
  steps: AlignStep[];
  total_cost: number;
  counts: { match: number; left_gap: number; right_gap: number };
  costs: { gap: number; mismatch_penalty: number };
}

export interface ApiError {
  error: string;
  path: string;
}
