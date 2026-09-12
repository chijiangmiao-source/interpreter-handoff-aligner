"""Global sequence alignment by dynamic programming.

Given two interpreter note sequences::

    left:  [{"time": int, "text": str}, ...]   (m items)
    right: [{"time": int, "text": str}, ...]   (n items)

the three edit operations are:

* ``match``     pair left i-1 with right j-1.
                cost = |tL - tR|               when texts are equal
                cost = |tL - tR| + MISMATCH    when texts differ
* ``left_gap``  left i-1 is kept, right contributes nothing (cost GAP)
* ``right_gap`` right j-1 is kept, left contributes nothing (cost GAP)

``align`` returns the unique, tie-broken minimum-cost path.  Where two or
more predecessors share the optimum they are ranked

    1. match      2. left_gap      3. right_gap

and if actions themselves tie (impossible between distinct actions, but kept
explicit) the predecessor coordinate that is lexicographically smallest
(``(i, j)``) wins.  Because every cell resolves ties deterministically, the
returned timeline is unique for any valid input.

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

# Tie-break priority among the three actions (lower wins).
ACTION_PRIORITY = {
    ACTION_MATCH: 0,
    ACTION_LEFT_GAP: 1,
    ACTION_RIGHT_GAP: 2,
}


def _candidate_rank(total: int, action: str, pi: int, pj: int) -> tuple:
    """Sort key for predecessor candidates.

    Smaller total first, then the action priority (match, left gap, right
    gap), and finally the lexicographically smaller predecessor coordinate.
    """
    return (total, ACTION_PRIORITY[action], pi, pj)


def align(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> dict[str, Any]:
    m, n = len(left), len(right)

    # dp[i][j] = minimum total cost aligning the first i left / j right notes.
    dp: list[list[int]] = [[0] * (n + 1) for _ in range(m + 1)]
    # The action chosen to arrive at each cell (None for the start cell).
    chosen: list[list[str | None]] = [[None] * (n + 1) for _ in range(m + 1)]

    dp[0][0] = 0
    for i in range(1, m + 1):
        dp[i][0] = dp[i - 1][0] + GAP_COST
        chosen[i][0] = ACTION_LEFT_GAP
    for j in range(1, n + 1):
        dp[0][j] = dp[0][j - 1] + GAP_COST
        chosen[0][j] = ACTION_RIGHT_GAP

    for i in range(1, m + 1):
        li = left[i - 1]
        for j in range(1, n + 1):
            rj = right[j - 1]
            time_diff = abs(li["time"] - rj["time"])
            match_cost = time_diff + (
                0 if li["text"] == rj["text"] else MISMATCH_PENALTY
            )

            # Predecessors, already in action-priority order.
            candidates = [
                (dp[i - 1][j - 1] + match_cost, ACTION_MATCH, i - 1, j - 1),
                (dp[i - 1][j] + GAP_COST, ACTION_LEFT_GAP, i - 1, j),
                (dp[i][j - 1] + GAP_COST, ACTION_RIGHT_GAP, i, j - 1),
            ]
            best = min(candidates, key=lambda c: _candidate_rank(c[0], c[1], c[2], c[3]))
            dp[i][j] = best[0]
            chosen[i][j] = best[1]

    # Trace back from (m, n) to (0, 0), then reverse to chronological order.
    steps_rev: list[dict[str, Any]] = []
    i, j = m, n
    while i > 0 or j > 0:
        action = chosen[i][j]
        if action == ACTION_MATCH:
            l, r = left[i - 1], right[j - 1]
            cost = abs(l["time"] - r["time"]) + (
                0 if l["text"] == r["text"] else MISMATCH_PENALTY
            )
            steps_rev.append(
                {
                    "action": ACTION_MATCH,
                    "left": {"time": l["time"], "text": l["text"]},
                    "right": {"time": r["time"], "text": r["text"]},
                    "cost": cost,
                }
            )
            i, j = i - 1, j - 1
        elif action == ACTION_LEFT_GAP:
            l = left[i - 1]
            steps_rev.append(
                {
                    "action": ACTION_LEFT_GAP,
                    "left": {"time": l["time"], "text": l["text"]},
                    "right": None,
                    "cost": GAP_COST,
                }
            )
            i -= 1
        else:  # ACTION_RIGHT_GAP
            r = right[j - 1]
            steps_rev.append(
                {
                    "action": ACTION_RIGHT_GAP,
                    "left": None,
                    "right": {"time": r["time"], "text": r["text"]},
                    "cost": GAP_COST,
                }
            )
            j -= 1

    steps = list(reversed(steps_rev))

    # Cumulative cost lets the UI replay the computation row by row.
    cumulative = 0
    for step in steps:
        cumulative += step["cost"]
        step["cumulative_cost"] = cumulative

    return {
        "steps": steps,
        "total_cost": dp[m][n],
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
