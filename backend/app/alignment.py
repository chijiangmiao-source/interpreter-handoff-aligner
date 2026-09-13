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

When ``compare_alternative`` is true the response additionally carries an
``alternative`` object describing the strictly second-best *complete* path
under exactly the same costs and tie rules (``None`` when the legal path is
unique, which empty input or a fully pinning anchor set can force).

Optional ``term_pairs`` are lead-confirmed ``(left_text, right_text)`` term
correspondences.  Only a pairing whose two note texts are an EXACT hit of a
declared pair is treated as synonymous: the mismatch penalty is waived and
the pair costs the plain time difference.  Time-difference costs, gap costs,
anchor constraints, the tie-break order and the alternative-path ranking are
all unchanged.  Hit match rows (including a hit on a pair whose two declared
texts are themselves equal, forced anchor matches and the alternative's
matches) carry the ``term_pair`` they hit as their source, and a non-empty
request echoes ``term_pairs``; absent or empty, request computation and the
response shape stay byte-for-byte identical to before.

Complete paths are totally ordered first by total cost.  Two equal-cost
paths are compared at their LAST differing step — the grid cell where they
rejoin while tracing back is precisely the cell at which the forward DP
resolves the tie — preferring match, then left gap, then right gap.  An
action sequence determines a path uniquely, so this is a strict total order.
The runner-up is found with a 2-best DP: each cell keeps the two cheapest
distinct prefixes under that order (merging at most the two best prefixes of
each of its three predecessors), which is enough because a global runner-up
can only ever use a predecessor's best or second-best prefix.  With anchors
the grid segments chain through the forced matches, so the anchors constrain
both paths identically; the global runner-up downgrades exactly one segment
to its own second-best (smallest extra cost, earliest segment on a tie).

When the flag is false/absent no analysis field is added and the response is
byte-for-byte the historical shape.

When no anchors are supplied the response carries no ``origin``/``anchors``
fields either, so old clients stay byte-for-byte compatible.

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


class TermSynonyms:
    """Lead-confirmed term correspondences consulted only on exact hits.

    A match edge waives the mismatch penalty iff its two note texts are a
    declared ``(left_text, right_text)`` pair compared verbatim; anything
    else keeps the ordinary different-text cost.  Validation already
    guarantees each side text is mapped once, but the membership lookups
    stay set-based so the algorithm itself makes no uniqueness assumptions.
    """

    __slots__ = ("_by_left",)

    def __init__(self, pairs: list[tuple[str, str]]):
        self._by_left: dict[str, set[str]] = {}
        for left_text, right_text in pairs:
            self._by_left.setdefault(left_text, set()).add(right_text)

    def hit(
        self, left_text: str, right_text: str
    ) -> tuple[str, str] | None:
        """Return the declared pair on an exact hit, else None."""
        if right_text in self._by_left.get(left_text, ()):
            return (left_text, right_text)
        return None


def term_hit(
    left_item: dict[str, Any],
    right_item: dict[str, Any],
    terms: TermSynonyms | None,
) -> tuple[str, str] | None:
    """The term pair an exact pairing of these notes hits, if any."""
    if terms is None:
        return None
    return terms.hit(left_item["text"], right_item["text"])


def hit_term_pair(
    left_item: dict[str, Any],
    right_item: dict[str, Any],
    terms: TermSynonyms | None,
) -> tuple[str, str] | None:
    """Declared pair an exact pairing of these notes hits, if any.

    Provenance is reported on every match row that is an exact declared hit,
    including a pair whose two declared texts are themselves equal: the lead
    declared the correspondence for this review, so the row's source is the
    term pair rather than an incidental same-text match.  An equal-text
    pairing without a declaration still returns None and keeps the ordinary
    same-text presentation.
    """
    return term_hit(left_item, right_item, terms)


def match_cost(
    left_item: dict[str, Any],
    right_item: dict[str, Any],
    terms: TermSynonyms | None = None,
) -> int:
    """Cost of pairing two notes: |tL - tR| (+ MISMATCH on different text).

    An exact term-pair hit makes two otherwise different texts synonymous:
    the mismatch penalty is waived and only the time difference remains.
    """
    synonymous = term_hit(left_item, right_item, terms) is not None
    return abs(left_item["time"] - right_item["time"]) + (
        0 if (left_item["text"] == right_item["text"] or synonymous)
        else MISMATCH_PENALTY
    )


def _candidate_rank(total: int, action: str, pi: int, pj: int) -> tuple:
    """Sort key for predecessor candidates.

    Smaller total first, then the action priority (match, left gap, right
    gap), and finally the lexicographically smaller predecessor coordinate.
    """
    return (total, ACTION_PRIORITY[action], pi, pj)


def _make_step(
    action: str,
    left_item: dict[str, Any] | None,
    right_item: dict[str, Any] | None,
    cost: int,
    origin: str | None = None,
    term_pair: tuple[str, str] | None = None,
) -> dict[str, Any]:
    """Build one serializable timeline row (note copies, no index leakage)."""
    step: dict[str, Any] = {
        "action": action,
        "left": (
            None
            if left_item is None
            else {"time": left_item["time"], "text": left_item["text"]}
        ),
        "right": (
            None
            if right_item is None
            else {"time": right_item["time"], "text": right_item["text"]}
        ),
        "cost": cost,
    }
    if origin is not None:
        step["origin"] = origin
    if term_pair is not None:
        # Provenance of a penalty-waived pairing: the exact term pair hit.
        step["term_pair"] = {
            "left_text": term_pair[0],
            "right_text": term_pair[1],
        }
    return step


def _fill_dp(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    i0: int,
    j0: int,
    i1: int,
    j1: int,
    dp: list[list[int]],
    chosen: list[list[str | None]],
    terms: TermSynonyms | None = None,
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
            mc = match_cost(li, rj, terms)

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
    terms: TermSynonyms | None = None,
) -> list[dict[str, Any]]:
    """Trace one rectangle back from ``(i1, j1)`` to its entry ``(i0, j0)``.

    The entry corner is not emitted (it is the start cell or a forced anchor
    owned by the caller).  Steps are returned in reverse (traceback) order and
    tagged ``auto``; anchor rows are added by :func:`_compute_primary`.
    """
    out: list[dict[str, Any]] = []
    i, j = i1, j1
    while i > i0 or j > j0:
        action = chosen[i][j]
        if action == ACTION_MATCH:
            l, r = left[i - 1], right[j - 1]
            out.append(
                _make_step(
                    ACTION_MATCH, l, r, match_cost(l, r, terms),
                    origin=ORIGIN_AUTO, term_pair=hit_term_pair(l, r, terms),
                )
            )
            i, j = i - 1, j - 1
        elif action == ACTION_LEFT_GAP:
            # Left side blank: the row carries the right-side note.
            out.append(
                _make_step(
                    ACTION_LEFT_GAP,
                    None,
                    right[j - 1],
                    GAP_COST,
                    origin=ORIGIN_AUTO,
                )
            )
            j -= 1
        else:  # ACTION_RIGHT_GAP — right side blank, row carries left note
            out.append(
                _make_step(
                    ACTION_RIGHT_GAP,
                    left[i - 1],
                    None,
                    GAP_COST,
                    origin=ORIGIN_AUTO,
                )
            )
            i -= 1
    return out


def _segments(
    m: int, n: int, anchor_pairs: list[tuple[int, int]]
) -> list[tuple[int, int, int, int, tuple[int, int] | None]]:
    """Cut the grid into (entry corner, exit corner, forced anchor) pieces.

    The forced anchor ``(a, b)`` (when not None) is the diagonal edge taken
    immediately after reaching the exit corner; the next segment's entry is
    ``(a + 1, b + 1)``.  The trailing segment has no forced anchor.
    """
    pieces: list[tuple[int, int, int, int, tuple[int, int] | None]] = []
    i0 = j0 = 0
    for ai, aj in anchor_pairs:
        pieces.append((i0, j0, ai, aj, (ai, aj)))
        i0, j0 = ai + 1, aj + 1
    pieces.append((i0, j0, m, n, None))
    return pieces


def _compute_primary(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    anchor_pairs: list[tuple[int, int]],
    terms: TermSynonyms | None = None,
    term_pairs: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    """The unique, tie-broken minimum-cost timeline (the existing DP)."""
    m, n = len(left), len(right)

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
        _fill_dp(left, right, i0, j0, ai, aj, dp, chosen, terms)
        steps.extend(
            reversed(
                _trace_segment(
                    left, right, i0, j0, ai, aj, chosen, terms
                )
            )
        )

        # 2) The anchor itself: forced diagonal match (ai, aj) -> (ai+1, aj+1)
        #    charged at its ordinary match cost (an exact term-pair hit waives
        #    the mismatch penalty just like a generated pairing).
        l, r = left[ai], right[aj]
        anchor_cost = match_cost(l, r, terms)
        steps.append(
            _make_step(
                ACTION_MATCH, l, r, anchor_cost, origin=ORIGIN_ANCHOR,
                term_pair=hit_term_pair(l, r, terms),
            )
        )

        # 3) Seed the next segment's entry corner with the accumulated cost.
        dp[ai + 1][aj + 1] = dp[ai][aj] + anchor_cost
        i0, j0 = ai + 1, aj + 1

    # Trailing segment after the last anchor (or the whole grid with none).
    _fill_dp(left, right, i0, j0, m, n, dp, chosen, terms)
    steps.extend(
        reversed(_trace_segment(left, right, i0, j0, m, n, chosen, terms))
    )

    return _finalize(steps, anchor_pairs, term_pairs or [])


def _finalize(
    steps: list[dict[str, Any]],
    anchor_pairs: list[tuple[int, int]],
    term_pairs: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    """Attach cumulative costs and wrap the rows in the response object."""
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

    if term_pairs:
        # Term-aware run: echo the declared correspondences so the UI keeps
        # the panel and can attribute each exact-hit row to its pair.
        result["term_pairs"] = [
            {"left_text": lt, "right_text": rt} for lt, rt in term_pairs
        ]
    else:
        # Historical contract: without declared pairs no term fields appear.
        for step in steps:
            step.pop("term_pair", None)

    return result


# --------------------------------------------------------------------------- #
# Strictly second-best ("alternative") complete path: a two-best DP.
# --------------------------------------------------------------------------- #
#
# Every prefix ending at grid cell (i, j) has exactly i+j steps (each move
# advances i+j by one), so prefixes of one cell only differ in content, never
# in length.  They are ordered as the complete paths are:
#
#   1. smaller total cost;
#   2. equal cost -> compare the codes of their LAST differing step, walking
#      backward from the cell, preferring match (1), then left gap (2), then
#      right gap (3).  Equal action sequences at one cell are the same path,
#      so distinct prefixes always differ somewhere.
#
# Each cell keeps only its best two prefixes: a path ranked third or worse at
# a predecessor can never become the global runner-up after one more edge,
# because the predecessor's better prefixes extend through that same edge.
# Merging at most two prefixes from each of the three predecessors (six
# candidates) therefore preserves exactly the best two prefixes at every
# cell.  With anchors the same fill runs per segment and the forced matches
# chain the segments; the global runner-up downgrades exactly one segment to
# its own second-best prefix.

# A prefix is (total_cost, action_code, prev_prefix, step_row).  Action code
# 0 only marks a segment's empty entry prefix, where the backward walk stops.
_PREFIX_EMPTY_CODE = 0

# Backward-walk action preference at an equal-cost rejoin cell: match first,
# then left gap, then right gap — the forward DP tie-break, applied at the
# last differing step.
_ACTION_CODE = {
    ACTION_MATCH: 1,
    ACTION_LEFT_GAP: 2,
    ACTION_RIGHT_GAP: 3,
}


def _prefix_less(a: tuple, b: tuple, sentinel: tuple) -> bool:
    """Order two prefixes ending at the same cell of one segment.

    Total cost first; on a tie the last differing step decides (its action
    code), exactly the forward DP's tie-break at the cell where the paths
    rejoin.  The backward walk is short in practice (the final actions
    usually differ) and never longer than the path (m + n <= 400).
    """
    if a[0] != b[0]:
        return a[0] < b[0]
    pa, pb = a, b
    while pa is not sentinel and pb is not sentinel:
        if pa[1] != pb[1]:
            return pa[1] < pb[1]
        pa, pb = pa[2], pb[2]
    return False  # identical action sequence at one cell == the same prefix


class _CmpPrefix:
    """Sort key wrapper so ``sorted`` can use :func:`_prefix_less`."""

    __slots__ = ("value", "sentinel")

    def __init__(self, value: tuple, sentinel: tuple):
        self.value = value
        self.sentinel = sentinel

    def __lt__(self, other: "_CmpPrefix") -> bool:
        return _prefix_less(self.value, other.value, self.sentinel)


def _edge_step(
    action: str,
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    i: int,
    j: int,
    anchored: bool,
    terms: TermSynonyms | None = None,
) -> dict[str, Any]:
    """The row added by ``action`` arriving at local cell (i, j)."""
    origin = ORIGIN_AUTO if anchored else None
    if action == ACTION_MATCH:
        l, r = left[i - 1], right[j - 1]
        return _make_step(
            ACTION_MATCH, l, r, match_cost(l, r, terms), origin=origin,
            term_pair=hit_term_pair(l, r, terms),
        )
    if action == ACTION_LEFT_GAP:
        return _make_step(
            ACTION_LEFT_GAP, None, right[j - 1], GAP_COST, origin=origin
        )
    return _make_step(
        ACTION_RIGHT_GAP, left[i - 1], None, GAP_COST, origin=origin
    )


def _fill_segment_two_best(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    i0: int,
    j0: int,
    i1: int,
    j1: int,
    base_cost: int,
    anchored: bool,
    terms: TermSynonyms | None = None,
) -> tuple[list[list[tuple | None]], tuple]:
    """Best two prefixes for every cell in one anchor-bounded rectangle.

    ``base_cost`` is the absolute cost already paid on the forced best chain
    before this segment's entry corner.  Returns the local table and the
    segment's entry sentinel; ``table[u][v]`` holds
    ``(best_prefix, second_prefix_or_None)`` in local coordinates
    (``u = i - i0``, ``v = j - j0``).
    """
    h, w = i1 - i0, j1 - j0
    sentinel = (base_cost, _PREFIX_EMPTY_CODE, None, None)
    table: list[list[tuple | None]] = [
        [None] * (w + 1) for _ in range(h + 1)
    ]
    table[0][0] = (sentinel, None)

    def keep(u: int, v: int, candidates: list[tuple]) -> None:
        # Distinct (predecessor, edge) pairs never describe the same path
        # (each action has a unique predecessor cell, and one predecessor's
        # two stored prefixes are distinct), so object identity is enough:
        # sort the candidates and retain the leading two.
        ranked = sorted(
            candidates,
            key=lambda p: _CmpPrefix(p, sentinel),
        )
        table[u][v] = (
            ranked[0],
            ranked[1] if len(ranked) > 1 else None,
        )

    # Borders: a single edge kind is legal there, as in _fill_dp.
    for u in range(1, h + 1):
        pred = table[u - 1][0][0]
        i = i0 + u
        step = _edge_step(ACTION_RIGHT_GAP, left, right, i, j0, anchored, terms)
        keep(u, 0, [(pred[0] + GAP_COST,
                     _ACTION_CODE[ACTION_RIGHT_GAP], pred, step)])
    for v in range(1, w + 1):
        pred = table[0][v - 1][0]
        j = j0 + v
        step = _edge_step(ACTION_LEFT_GAP, left, right, i0, j, anchored, terms)
        keep(0, v, [(pred[0] + GAP_COST,
                     _ACTION_CODE[ACTION_LEFT_GAP], pred, step)])

    for u in range(1, h + 1):
        i = i0 + u
        for v in range(1, w + 1):
            j = j0 + v
            candidates: list[tuple] = []
            diag_best, diag_second = table[u - 1][v - 1]
            up_best, up_second = table[u - 1][v]      # -> right_gap edge
            left_best, left_second = table[u][v - 1]  # -> left_gap edge

            mc = match_cost(left[i - 1], right[j - 1], terms)
            for pred in (diag_best, diag_second):
                if pred is not None:
                    candidates.append(
                        (pred[0] + mc,
                         _ACTION_CODE[ACTION_MATCH], pred,
                         _edge_step(ACTION_MATCH, left, right, i, j, anchored, terms))
                    )
            for pred in (up_best, up_second):
                if pred is not None:
                    candidates.append(
                        (pred[0] + GAP_COST,
                         _ACTION_CODE[ACTION_RIGHT_GAP], pred,
                         _edge_step(ACTION_RIGHT_GAP, left, right, i, j, anchored, terms))
                    )
            for pred in (left_best, left_second):
                if pred is not None:
                    candidates.append(
                        (pred[0] + GAP_COST,
                         _ACTION_CODE[ACTION_LEFT_GAP], pred,
                         _edge_step(ACTION_LEFT_GAP, left, right, i, j, anchored, terms))
                    )
            keep(u, v, candidates)

    return table, sentinel


def _trace_ref(ref: tuple, sentinel: tuple) -> list[dict[str, Any]]:
    """Recover a segment's forward-chronological rows from a prefix ref."""
    rows: list[dict[str, Any]] = []
    p = ref
    while p is not sentinel:
        rows.append(p[3])
        p = p[2]
    rows.reverse()
    return rows


def _step_signature(step: dict[str, Any]) -> tuple:
    """Content identity used to locate the first differing row."""
    def note_key(item: dict[str, Any] | None) -> tuple[Any, Any] | None:
        return None if item is None else (item["time"], item["text"])

    return (
        step["action"],
        note_key(step["left"]),
        note_key(step["right"]),
        step["cost"],
    )


def _find_alternative(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    anchor_pairs: list[tuple[int, int]],
    primary_steps: list[dict[str, Any]],
    primary_total: int,
    terms: TermSynonyms | None = None,
) -> dict[str, Any] | None:
    """The strictly second-ranked distinct complete path, or None.

    Each segment contributes a best and (sometimes) second-best prefix.  The
    global runner-up keeps every segment at its best except exactly one,
    downgraded to its second-best; the downgrade with the smallest extra
    cost wins (the earliest such segment on a tie, since then the last
    differing step is resolved in that segment's favour).  Forced anchors
    are identical rows in both paths and simply chain the segments.  The
    same term correspondences apply to every segment and every forced
    anchor, so the term rule constrains both paths identically.
    """
    m, n = len(left), len(right)
    anchored = bool(anchor_pairs)
    pieces = _segments(m, n, anchor_pairs)

    # Per segment: exit refs (best, second), the entry sentinel, and the
    # forced anchor following the segment (if any).
    exits: list[tuple[tuple, tuple | None]] = []
    sentinels: list[tuple] = []
    base = 0
    for i0, j0, i1, j1, _forced in pieces:
        table, sentinel = _fill_segment_two_best(
            left, right, i0, j0, i1, j1, base, anchored, terms
        )
        best_ref, second_ref = table[i1 - i0][j1 - j0]
        exits.append((best_ref, second_ref))
        sentinels.append(sentinel)
        if (i1, j1) != (m, n):
            # Forced anchor edge seeds the next segment's entry cost.
            base = best_ref[0] + match_cost(left[i1], right[j1], terms)

    # Sanity: the chained segment bests are exactly the DP primary total.
    if exits[-1][0][0] != primary_total:
        raise RuntimeError("two-best DP disagrees with the primary DP cost")

    # Smallest downgrade cost, earliest segment first on a tie.
    downgrades = [
        (second[0] - best[0], k)
        for k, (best, second) in enumerate(exits)
        if second is not None
    ]
    if not downgrades:
        return None
    extra, alt_segment = min(downgrades)

    # Assemble the alternative forward rows: segment bests everywhere except
    # the chosen segment's second-best, with the identical anchors between.
    alt_steps: list[dict[str, Any]] = []
    for k, (i0, j0, i1, j1, forced) in enumerate(pieces):
        best_ref, second_ref = exits[k]
        ref = second_ref if k == alt_segment else best_ref
        alt_steps.extend(_trace_ref(ref, sentinels[k]))
        if forced is not None:
            ai, aj = forced
            l, r = left[ai], right[aj]
            alt_steps.append(
                _make_step(
                    ACTION_MATCH, l, r, match_cost(l, r, terms),
                    origin=ORIGIN_ANCHOR, term_pair=hit_term_pair(l, r, terms),
                )
            )

    if not anchored:
        for step in alt_steps:
            step.pop("origin", None)

    total = sum(s["cost"] for s in alt_steps)
    if total != primary_total + extra:
        raise RuntimeError("alternative cost does not match its downgrade")

    cumulative = 0
    for step in alt_steps:
        cumulative += step["cost"]
        step["cumulative_cost"] = cumulative

    # First row (forward order) at which the two timelines differ; its index
    # pair is how many notes each side consumed during the shared prefix,
    # with a null side when the alternative's row leaves that side blank.
    primary_sigs = [_step_signature(s) for s in primary_steps]
    alt_sigs = [_step_signature(s) for s in alt_steps]
    d = 0
    while (
        d < len(primary_sigs)
        and d < len(alt_sigs)
        and primary_sigs[d] == alt_sigs[d]
    ):
        d += 1

    if d >= len(alt_sigs) or d >= len(primary_sigs):
        # Defensive: distinct complete paths must differ before either ends.
        raise RuntimeError("alternative has no first divergence")

    left_consumed = sum(
        1 for s in primary_steps[:d] if s["left"] is not None
    )
    right_consumed = sum(
        1 for s in primary_steps[:d] if s["right"] is not None
    )
    alt_row = alt_steps[d]
    first_divergence = {
        "left": left_consumed if alt_row["left"] is not None else None,
        "right": right_consumed if alt_row["right"] is not None else None,
    }

    return {
        "total_cost": total,
        "cost_diff": extra,
        "first_divergence": first_divergence,
        "steps": alt_steps,
    }


def align(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    anchors: list[tuple[int, int]] | None = None,
    compare_alternative: bool = False,
    term_pairs: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    anchor_pairs: list[tuple[int, int]] = list(anchors or [])
    declared_pairs: list[tuple[str, str]] = list(term_pairs or [])
    # A non-empty declaration switches on the synonym model; an empty/absent
    # list leaves costs and the response shape exactly as before.
    terms = TermSynonyms(declared_pairs) if declared_pairs else None

    result = _compute_primary(
        left,
        right,
        anchor_pairs,
        terms,
        declared_pairs if declared_pairs else None,
    )

    if compare_alternative:
        result["alternative"] = _find_alternative(
            left,
            right,
            anchor_pairs,
            result["steps"],
            result["total_cost"],
            terms,
        )

    return result
