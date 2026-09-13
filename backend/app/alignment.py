"""Global sequence alignment by dynamic programming.

Given two interpreter note sequences::

    left:  [{"time": int, "text": str}, ...]   (m items)
    right: [{"time": int, "text": str}, ...]   (n items)

the three edit operations are:

* ``match``     pair left i-1 with right j-1.
                cost = |tL - tR|               when texts are equal
                cost = |tL - tR| + MISMATCH    when texts differ
* ``left_gap``  the LEFT side is blank at this row: left contributes
                nothing and right j-1 is kept (cost GAP)
* ``right_gap`` the RIGHT side is blank at this row: right contributes
                nothing and left i-1 is kept (cost GAP)

``align`` returns the unique, tie-broken minimum-cost path.  Where two or
more predecessors share the optimum they are ranked

    1. match      2. left_gap (left blank)      3. right_gap (right blank)

and if actions themselves tie (impossible between distinct actions, but kept
explicit) the predecessor coordinate that is lexicographically smallest
(``(i, j)``) wins.  Because every cell resolves ties deterministically, the
returned timeline is unique for any valid input.

Optional ``anchors`` are human-confirmed ``(left_index, right_index)`` pairs
(0-based into the two input arrays).  Grid point ``(i, j)`` means "first i
left / j right notes consumed", so anchor ``(a, b)`` is the forced match step
``(a, b) -> (a+1, b+1)``.  Anchors split the grid into independent rectangles;
the same DP fills each rectangle and every anchor is placed at its ordinary
match cost.  Because the segment boundaries are fixed, the constrained optimum
is the sum of the per-segment optima plus the anchor costs.

Anchors must already be validated (``app.validation.validate_anchors``):
in-range, never reused and strictly monotonic on both sides (no crossing).

When no anchors are supplied the response is exactly the historical shape
(no ``origin``/``anchors`` fields), so old clients stay byte-for-byte
compatible.

No third-party matching/alignment library is used: this is plain DP over an
``(m+1) x (n+1)`` cost matrix with O(m*n) time and memory (m, n <= 200).
"""

from __future__ import annotations

from typing import Any

GAP_COST = 2000
MISMATCH_PENALTY = 3000

ACTION_MATCH = "match"
ACTION_LEFT_GAP = "left_gap"
ACTION_RIGHT_GAP = "right_gap"

# Per-row provenance, present only on anchored runs, so the UI can separate a
# human-confirmed row from an algorithm-generated row.
ORIGIN_ANCHOR = "anchor"
ORIGIN_AUTO = "auto"

# Tie-break priority among the three actions (lower wins).
ACTION_PRIORITY = {
    ACTION_MATCH: 0,
    ACTION_LEFT_GAP: 1,
    ACTION_RIGHT_GAP: 2,
}


def match_cost(left_item: dict[str, Any], right_item: dict[str, Any]) -> int:
    """Cost of pairing two notes: |tL - tR| (+ MISMATCH when texts differ)."""
    return abs(left_item["time"] - right_item["time"]) + (
        0 if left_item["text"] == right_item["text"] else MISMATCH_PENALTY
    )


def _candidate_rank(total: int, action: str, pi: int, pj: int) -> tuple:
    """Sort key for predecessor candidates.

    Smaller total first, then the action priority (match, left gap, right
    gap), and finally the lexicographically smaller predecessor coordinate.
    """
    return (total, ACTION_PRIORITY[action], pi, pj)


def _fill_dp(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    i0: int,
    j0: int,
    i1: int,
    j1: int,
    dp: list[list[int]],
    chosen: list[list[str | None]],
) -> None:
    """Fill the rectangle from entry corner ``(i0, j0)`` to ``(i1, j1)``.

    ``dp[i0][j0]`` already holds the absolute cost of reaching the entry
    corner (0 for a fresh run, or the accumulated cost when chaining behind a
    forced anchor).  Both borders are grown from that corner, so gap prefixes
    are priced exactly as in the original whole-grid DP.
    """
    for i in range(i0 + 1, i1 + 1):
        # Right side is empty along this border -> right_gap.
        dp[i][j0] = dp[i0][j0] + (i - i0) * GAP_COST
        chosen[i][j0] = ACTION_RIGHT_GAP
    for j in range(j0 + 1, j1 + 1):
        # Left side is empty along this border -> left_gap.
        dp[i0][j] = dp[i0][j0] + (j - j0) * GAP_COST
        chosen[i0][j] = ACTION_LEFT_GAP

    for i in range(i0 + 1, i1 + 1):
        li = left[i - 1]
        for j in range(j0 + 1, j1 + 1):
            rj = right[j - 1]
            mc = match_cost(li, rj)

            # Predecessors, already in tie-break priority order
            # (match, left-side gap, right-side gap). A move from (i, j-1)
            # consumes a right note, so the LEFT side is blank there.
            candidates = [
                (dp[i - 1][j - 1] + mc, ACTION_MATCH, i - 1, j - 1),
                (dp[i][j - 1] + GAP_COST, ACTION_LEFT_GAP, i, j - 1),
                (dp[i - 1][j] + GAP_COST, ACTION_RIGHT_GAP, i - 1, j),
            ]
            best = min(
                candidates, key=lambda c: _candidate_rank(c[0], c[1], c[2], c[3])
            )
            dp[i][j] = best[0]
            chosen[i][j] = best[1]


def _trace_segment(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    i0: int,
    j0: int,
    i1: int,
    j1: int,
    chosen: list[list[str | None]],
) -> list[dict[str, Any]]:
    """Trace one rectangle back from ``(i1, j1)`` to its entry ``(i0, j0)``.

    The entry corner is not emitted (it is the start cell or a forced anchor
    owned by the caller).  Steps are returned in reverse (traceback) order and
    tagged ``auto``; anchor rows are added by :func:`align`.
    """
    out: list[dict[str, Any]] = []
    i, j = i1, j1
    while i > i0 or j > j0:
        action = chosen[i][j]
        if action == ACTION_MATCH:
            l, r = left[i - 1], right[j - 1]
            out.append(
                {
                    "action": ACTION_MATCH,
                    "left": {"time": l["time"], "text": l["text"]},
                    "right": {"time": r["time"], "text": r["text"]},
                    "cost": match_cost(l, r),
                    "origin": ORIGIN_AUTO,
                }
            )
            i, j = i - 1, j - 1
        elif action == ACTION_LEFT_GAP:
            # Left side blank: the row carries the right-side note.
            r = right[j - 1]
            out.append(
                {
                    "action": ACTION_LEFT_GAP,
                    "left": None,
                    "right": {"time": r["time"], "text": r["text"]},
                    "cost": GAP_COST,
                    "origin": ORIGIN_AUTO,
                }
            )
            j -= 1
        else:  # ACTION_RIGHT_GAP — right side blank, row carries left note
            l = left[i - 1]
            out.append(
                {
                    "action": ACTION_RIGHT_GAP,
                    "left": {"time": l["time"], "text": l["text"]},
                    "right": None,
                    "cost": GAP_COST,
                    "origin": ORIGIN_AUTO,
                }
            )
            i -= 1
    return out


def align(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    anchors: list[tuple[int, int]] | None = None,
) -> dict[str, Any]:
    m, n = len(left), len(right)
    anchor_pairs: list[tuple[int, int]] = list(anchors or [])

    # dp[i][j] = minimum total cost aligning the first i left / j right notes.
    dp: list[list[int]] = [[0] * (n + 1) for _ in range(m + 1)]
    # The action chosen to arrive at each cell (None for the start cell).
    chosen: list[list[str | None]] = [[None] * (n + 1) for _ in range(m + 1)]

    # Forward-chronological steps: each segment's traceback is reversed on
    # its own and the confirmed anchor row is appended right after it.
    steps: list[dict[str, Any]] = []

    # Entry corner of the current segment: (0, 0) initially, or the grid point
    # just after the previous forced anchor match.
    i0 = j0 = 0
    for ai, aj in anchor_pairs:
        # 1) Best alignment of the notes strictly before this anchor, i.e.
        #    from the entry corner to grid point (ai, aj).
        _fill_dp(left, right, i0, j0, ai, aj, dp, chosen)
        steps.extend(reversed(_trace_segment(left, right, i0, j0, ai, aj, chosen)))

        # 2) The anchor itself: forced diagonal match (ai, aj) -> (ai+1, aj+1)
        #    charged at its ordinary match cost.
        l, r = left[ai], right[aj]
        anchor_cost = match_cost(l, r)
        steps.append(
            {
                "action": ACTION_MATCH,
                "left": {"time": l["time"], "text": l["text"]},
                "right": {"time": r["time"], "text": r["text"]},
                "cost": anchor_cost,
                "origin": ORIGIN_ANCHOR,
            }
        )

        # 3) Seed the next segment's entry corner with the accumulated cost.
        dp[ai + 1][aj + 1] = dp[ai][aj] + anchor_cost
        i0, j0 = ai + 1, aj + 1

    # Trailing segment after the last anchor (or the whole grid with none).
    _fill_dp(left, right, i0, j0, m, n, dp, chosen)
    steps.extend(reversed(_trace_segment(left, right, i0, j0, m, n, chosen)))

    # Cumulative cost lets the UI replay the computation row by row.
    cumulative = 0
    for step in steps:
        cumulative += step["cost"]
        step["cumulative_cost"] = cumulative

    result: dict[str, Any] = {
        "steps": steps,
        "total_cost": cumulative,
        "counts": {
            "match": sum(1 for s in steps if s["action"] == ACTION_MATCH),
            "left_gap": sum(1 for s in steps if s["action"] == ACTION_LEFT_GAP),
            "right_gap": sum(1 for s in steps if s["action"] == ACTION_RIGHT_GAP),
        },
        "costs": {
            "gap": GAP_COST,
            "mismatch_penalty": MISMATCH_PENALTY,
        },
    }

    if anchor_pairs:
        # Anchored run: keep the provenance on every row and echo the anchors
        # so the UI can pin the human-confirmed rows.
        result["anchors"] = [{"left": li, "right": ri} for li, ri in anchor_pairs]
    else:
        # Historical contract: an unanchored response carries no extra fields.
        for step in steps:
            step.pop("origin", None)

    return result
