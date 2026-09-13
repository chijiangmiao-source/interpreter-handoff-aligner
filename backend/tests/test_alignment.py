"""Unit tests for the DP alignment algorithm, tie-breaking and anchors."""

import itertools
import random
from functools import cmp_to_key, lru_cache

from app.alignment import (
    GAP_COST,
    MISMATCH_PENALTY,
    ORIGIN_ANCHOR,
    ORIGIN_AUTO,
    align,
)


def _synonymous(left_text: str, right_text: str, term_pairs) -> bool:
    return (left_text, right_text) in set(term_pairs or [])


def _term_pair_cost(a: dict, b: dict, term_pairs) -> int:
    """Independent reference for a pairing cost under declared term pairs."""
    waived = a["text"] == b["text"] or _synonymous(
        a["text"], b["text"], term_pairs
    )
    return abs(a["time"] - b["time"]) + (0 if waived else MISMATCH_PENALTY)


def note(time: int, text: str = "x"):
    return {"time": time, "text": text}


def test_empty_sequences_cost_zero():
    result = align([], [])
    assert result["total_cost"] == 0
    assert result["steps"] == []
    assert result["counts"] == {"match": 0, "left_gap": 0, "right_gap": 0}


def test_one_side_empty_all_gaps():
    # Only a left note: the RIGHT side is blank on that row -> right_gap.
    result = align([note(100, "a")], [])
    assert result["steps"][0]["action"] == "right_gap"
    assert result["steps"][0]["cost"] == GAP_COST
    assert result["steps"][0]["left"] == note(100, "a")
    assert result["steps"][0]["right"] is None
    assert result["total_cost"] == GAP_COST

    # Only a right note: the LEFT side is blank -> left_gap.
    result = align([], [note(100, "a")])
    assert result["steps"][0]["action"] == "left_gap"
    assert result["steps"][0]["left"] is None
    assert result["steps"][0]["right"] == note(100, "a")
    assert result["total_cost"] == GAP_COST


def test_identical_single_notes_match_with_time_diff():
    result = align([note(1000, "hello")], [note(1250, "hello")])
    assert result["steps"][0]["action"] == "match"
    assert result["steps"][0]["cost"] == 250
    assert result["total_cost"] == 250


def test_different_texts_add_penalty():
    result = align([note(1000, "hello")], [note(1000, "world")])
    step = result["steps"][0]
    assert step["action"] == "match"
    assert step["cost"] == MISMATCH_PENALTY
    assert result["total_cost"] == MISMATCH_PENALTY


def test_two_gaps_cheaper_than_big_time_difference():
    # |9000 - 0| = 9000 match > 2000 + 2000 = 4000 for a gap pair.
    result = align([note(0, "same")], [note(9000, "same")])
    actions = [s["action"] for s in result["steps"]]
    # The left note comes first chronologically; its row has the right side
    # blank (right_gap), then the right note sits on a left-blank row.
    assert actions == ["right_gap", "left_gap"]
    assert result["steps"][0]["left"] == note(0, "same")
    assert result["steps"][0]["right"] is None
    assert result["steps"][1]["left"] is None
    assert result["steps"][1]["right"] == note(9000, "same")
    assert result["total_cost"] == 2 * GAP_COST


def test_tie_match_vs_two_gaps_prefers_match():
    # Match 4000 ties with one left-gap + one right-gap (also 4000);
    # pairing wins the three-way tie.
    result = align([note(0, "same")], [note(4000, "same")])
    assert [s["action"] for s in result["steps"]] == ["match"]
    assert result["total_cost"] == 4000


def test_tie_left_gap_vs_right_gap_prefers_left_gap():
    # At cell (1,2) the left-blank and right-blank routes both cost 6000;
    # "left gap" wins per the tie-break order.
    left = [note(0, "a")]
    right = [note(4000, "a"), note(4100, "b")]
    result = align(left, right)
    # (1,1) is a triple tie at 4000 -> match; (1,2) is a gap tie at 6000
    # -> left_gap (left blank, carrying right note 4100).
    assert result["total_cost"] == 6000
    assert [s["action"] for s in result["steps"]] == ["match", "left_gap"]
    final = result["steps"][1]
    assert final["left"] is None
    assert final["right"] == note(4100, "b")


def test_gap_action_name_matches_actually_blank_side():
    # Invariant for every row: a left_gap row has no left note, and vice
    # versa, regardless of which side the whole sequence lives on.
    for lseq, rseq in [
        ([note(1, "a"), note(2, "b")], []),
        ([], [note(1, "a"), note(2, "b")]),
        ([note(0, "a"), note(9000, "b")], [note(100, "b"), note(8999, "a")]),
    ]:
        result = align(lseq, rseq)
        for step in result["steps"]:
            if step["action"] == "left_gap":
                assert step["left"] is None
                assert step["right"] is not None
            elif step["action"] == "right_gap":
                assert step["right"] is None
                assert step["left"] is not None
            else:
                assert step["left"] is not None and step["right"] is not None


def test_chronological_order_and_cumulative_cost():
    left = [note(0, "a"), note(5000, "b")]
    right = [note(100, "a"), note(6000, "b")]
    result = align(left, right)
    assert len(result["steps"]) == 2
    assert [s["left"]["time"] for s in result["steps"]] == [0, 5000]
    assert result["steps"][0]["cumulative_cost"] == 100
    assert result["steps"][1]["cumulative_cost"] == 1100
    assert result["total_cost"] == 1100


def test_steps_consume_each_note_once_without_crossing():
    left = [note(0, "a"), note(10000, "b")]
    right = [note(100, "b"), note(9999, "a")]
    result = align(left, right)

    matched_left = [s["left"]["time"] for s in result["steps"] if s["left"]]
    matched_right = [s["right"]["time"] for s in result["steps"] if s["right"]]
    assert matched_left == [0, 10000]  # every left note appears, in order
    assert matched_right == [100, 9999]
    # match + right_gap rows are exactly the rows that carry a left note;
    # match + left_gap rows are exactly those carrying a right note.
    assert result["counts"]["match"] + result["counts"]["right_gap"] == 2
    assert result["counts"]["match"] + result["counts"]["left_gap"] == 2
    assert sum(s["cost"] for s in result["steps"]) == result["total_cost"]


def test_large_inputs_200_items():
    left = [note(i * 1000, f"t{i}") for i in range(200)]
    right = [note(i * 1000 + 5, f"t{i}") for i in range(200)]
    result = align(left, right)
    assert result["counts"]["match"] == 200
    assert result["total_cost"] == 200 * 5


def test_constants():
    assert GAP_COST == 2000
    assert MISMATCH_PENALTY == 3000


def test_deterministic_unique_output():
    # Same input must always yield the same step sequence (uniqueness rule).
    left = [note(0, "a"), note(5000, "b"), note(9000, "c")]
    right = [note(10, "a"), note(4000, "x"), note(5200, "b")]
    first = align(left, right)
    for _ in range(5):
        again = align(left, right)
        assert again["steps"] == first["steps"]
        assert again["total_cost"] == first["total_cost"]


def test_optimal_cost_against_brute_force():
    """Exhaustive small-case comparison with an independent recursion."""

    def brute(left, right):
        m, n = len(left), len(right)

        @lru_cache(maxsize=None)
        def opt(i, j):
            if i == m and j == n:
                return 0
            best = float("inf")
            if i < m and j < n:
                l, r = left[i], right[j]
                c = abs(l["time"] - r["time"]) + (
                    0 if l["text"] == r["text"] else MISMATCH_PENALTY
                )
                best = min(best, c + opt(i + 1, j + 1))
            if i < m:
                best = min(best, GAP_COST + opt(i + 1, j))
            if j < n:
                best = min(best, GAP_COST + opt(i, j + 1))
            return best

        return opt(0, 0)

    cases = 0
    for m in range(0, 4):
        for n in range(0, 4):
            # Strictly increasing base spacing 5000; deltas in {0, 4000}
            # keep every side strictly increasing while creating ties.
            for dl in itertools.product((0, 4000), repeat=m):
                for dr in itertools.product((0, 4000), repeat=n):
                    for tl in itertools.product(("a", "b"), repeat=m):
                        for tr in itertools.product(("a", "b"), repeat=n):
                            left = [
                                note(i * 5000 + dl[i], tl[i]) for i in range(m)
                            ]
                            right = [
                                note(i * 5000 + dr[i], tr[i]) for i in range(n)
                            ]
                            result = align(left, right)
                            assert result["total_cost"] == brute(left, right)
                            cases += 1
    assert cases > 1000


# --------------------------------------------------------------------------- #
# Anchors: human-confirmed pairs that split the grid into independent DP runs.
# --------------------------------------------------------------------------- #


def _unanchored_segment_cost(
    left: list[dict], right: list[dict], lo: int, hi: int
) -> int:
    """Independent optimum for the open interval between two anchors.

    ``lo``/``hi`` are ``(left_index, right_index)`` pairs of the bounding
    anchors, using (-1, -1) before the first and (m, n) after the last; the
    bounding notes themselves are NOT included.  A plain recursion over the
    sub-arrays gives a check independent of the segment DP under test.
    """
    sub_l = left[lo[0] + 1 : hi[0]]
    sub_r = right[lo[1] + 1 : hi[1]]

    @lru_cache(maxsize=None)
    def opt(i: int, j: int) -> float:
        if i == len(sub_l) and j == len(sub_r):
            return 0
        best = float("inf")
        if i < len(sub_l) and j < len(sub_r):
            a, b = sub_l[i], sub_r[j]
            c = abs(a["time"] - b["time"]) + (
                0 if a["text"] == b["text"] else MISMATCH_PENALTY
            )
            best = min(best, c + opt(i + 1, j + 1))
        if i < len(sub_l):
            best = min(best, GAP_COST + opt(i + 1, j))
        if j < len(sub_r):
            best = min(best, GAP_COST + opt(i, j + 1))
        return best

    return int(opt(0, 0))


def constrained_brute(
    left: list[dict], right: list[dict], anchors: list[tuple[int, int]]
) -> int:
    """Minimum cost among paths forced through every anchor pair."""
    m, n = len(left), len(right)
    bounds = [(-1, -1), *sorted(anchors), (m, n)]
    total = 0
    for lo, hi in zip(bounds, bounds[1:]):
        total += _unanchored_segment_cost(left, right, lo, hi)
        if hi != (m, n):  # hi is a real anchor: add its forced match cost
            a, b = left[hi[0]], right[hi[1]]
            total += abs(a["time"] - b["time"]) + (
                0 if a["text"] == b["text"] else MISMATCH_PENALTY
            )
    return total


def _assert_valid_timeline(result, left, right, anchors: list[tuple[int, int]]):
    """Invariants every (anchored) timeline must satisfy."""
    m, n = len(left), len(right)
    steps = result["steps"]
    # Costs replay to the advertised total.
    assert sum(s["cost"] for s in steps) == result["total_cost"]
    cum = 0
    for s in steps:
        cum += s["cost"]
        assert s["cumulative_cost"] == cum
    # Every note is consumed exactly once, in order; blank-side naming holds.
    left_times = [s["left"]["time"] for s in steps if s["left"]]
    right_times = [s["right"]["time"] for s in steps if s["right"]]
    assert left_times == [item["time"] for item in left]
    assert right_times == [item["time"] for item in right]
    for s in steps:
        if s["action"] == "left_gap":
            assert s["left"] is None and s["right"] is not None
        elif s["action"] == "right_gap":
            assert s["right"] is None and s["left"] is not None
        else:
            assert s["left"] is not None and s["right"] is not None
    # Every anchor appears, in order, as a match tagged "anchor", pinned to the
    # exact record indices the caller confirmed.
    anchor_rows = [s for s in steps if s.get("origin") == ORIGIN_ANCHOR]
    assert len(anchor_rows) == len(anchors)
    for (ai, aj), row in zip(anchors, anchor_rows):
        assert row["action"] == "match"
        assert row["left"] == left[ai]
        assert row["right"] == right[aj]
    # With any anchor present every non-anchor row is algorithm-generated;
    # with no anchors the legacy shape omits provenance entirely.
    if anchors:
        assert all(
            s.get("origin") == ORIGIN_AUTO
            for s in steps
            if s.get("origin") != ORIGIN_ANCHOR
        )
    else:
        assert all("origin" not in s for s in steps)
    assert result["counts"] == {
        "match": sum(1 for s in steps if s["action"] == "match"),
        "left_gap": sum(1 for s in steps if s["action"] == "left_gap"),
        "right_gap": sum(1 for s in steps if s["action"] == "right_gap"),
    }


def test_no_anchors_keeps_legacy_response_shape():
    left = [note(0, "a"), note(5000, "b")]
    right = [note(10, "a"), note(5200, "b")]
    result = align(left, right)
    assert set(result.keys()) == {"steps", "total_cost", "counts", "costs"}
    for step in result["steps"]:
        assert set(step.keys()) == {
            "action",
            "left",
            "right",
            "cost",
            "cumulative_cost",
        }
    # Passing anchors=None or an empty list is the same legacy request.
    assert align(left, right, None) == result
    assert align(left, right, []) == result


def test_single_anchor_is_forced_tagged_and_present():
    left = [note(0, "a"), note(5000, "b"), note(9000, "c")]
    right = [note(10, "a"), note(4000, "x"), note(5200, "b")]
    result = align(left, right, anchors=[(2, 1)])  # force 9000/c <-> 4000/x

    assert result["anchors"] == [{"left": 2, "right": 1}]
    anchor_rows = [s for s in result["steps"] if s["origin"] == ORIGIN_ANCHOR]
    auto_rows = [s for s in result["steps"] if s["origin"] == ORIGIN_AUTO]
    assert len(anchor_rows) == 1
    assert anchor_rows[0]["left"] == note(9000, "c")
    assert anchor_rows[0]["right"] == note(4000, "x")
    # A forced pair is a match even though the free optimum would never pair
    # these distant, different-text notes.
    assert anchor_rows[0]["action"] == "match"
    assert anchor_rows[0]["cost"] == abs(9000 - 4000) + MISMATCH_PENALTY
    assert auto_rows and all(s["origin"] == ORIGIN_AUTO for s in auto_rows)
    _assert_valid_timeline(result, left, right, [(2, 1)])


def test_anchor_total_equals_anchor_cost_plus_optimal_segments():
    left = [note(0, "a"), note(5000, "b"), note(9000, "c")]
    right = [note(10, "a"), note(4000, "x"), note(5200, "b")]
    anchors = [(0, 0), (2, 1)]
    result = align(left, right, anchors=anchors)
    assert result["total_cost"] == constrained_brute(left, right, anchors)
    _assert_valid_timeline(result, left, right, anchors)

    # The two anchor rows sit at their forced positions in chronological order.
    anchor_rows = [s for s in result["steps"] if s["origin"] == ORIGIN_ANCHOR]
    assert [r["left"]["time"] for r in anchor_rows] == [0, 9000]
    assert [r["right"]["time"] for r in anchor_rows] == [10, 4000]


def test_anchor_consistent_with_global_optimum_when_it_agrees():
    # The free optimum already pairs equal-text same-position notes; pinning
    # those pairs must leave the timeline and total exactly unchanged.
    left = [note(0, "a"), note(5000, "b")]
    right = [note(100, "a"), note(4900, "b")]
    free = align(left, right)
    pinned = align(left, right, anchors=[(0, 0), (1, 1)])
    assert pinned["total_cost"] == free["total_cost"] == 200
    assert [
        (s["action"], s["cost"], s.get("origin")) for s in pinned["steps"]
    ] == [
        ("match", 100, ORIGIN_ANCHOR),
        ("match", 100, ORIGIN_ANCHOR),
    ]


def test_anchored_optimum_exhaustive_against_independent_recursion():
    rng = random.Random(20260913)
    cases = 0
    for trial in range(400):
        m = rng.randrange(0, 6)
        n = rng.randrange(0, 6)
        left = []
        t = 0
        for i in range(m):
            t += rng.randrange(0, 7000)
            left.append(note(t, rng.choice(("a", "b"))))
        right = []
        t = 0
        for j in range(n):
            t += rng.randrange(0, 7000)
            right.append(note(t, rng.choice(("a", "b"))))

        # Choose a random monotonic set of forced pairs.
        k = rng.randrange(0, min(m, n) + 1)
        li = sorted(rng.sample(range(m), k)) if k else []
        rj = sorted(rng.sample(range(n), k)) if k else []
        anchors = list(zip(li, rj))

        result = align(left, right, anchors=anchors)
        assert result["total_cost"] == constrained_brute(left, right, anchors)
        _assert_valid_timeline(result, left, right, anchors)
        cases += 1
    assert cases == 400


def test_removing_all_anchors_restores_free_result():
    left = [note(0, "a"), note(9000, "b")]
    right = [note(10, "b"), note(8999, "a")]
    free = align(left, right)
    constrained = align(left, right, anchors=[(0, 1)])
    assert constrained["total_cost"] >= free["total_cost"]
    # Cancelling the anchor (re-request without it) reproduces the free result
    # bit for bit, including the absence of provenance fields.
    again = align(left, right, None)
    assert again == free
    assert all("origin" not in s for s in again["steps"])


# --------------------------------------------------------------------------- #
# Strictly second-best ("alternative") complete path.
# --------------------------------------------------------------------------- #


def _step_sig(step: dict):
    def nk(item):
        return None if item is None else (item["time"], item["text"])

    return step["action"], nk(step["left"]), nk(step["right"]), step["cost"]


def _enumerate_paths(left, right, anchors=()):
    """Every distinct complete path (signature tuple -> total cost)."""
    m, n = len(left), len(right)
    bounds = [(-1, -1), *anchors, (m, n)]

    def seg_paths(li, lj, i1, j1):
        out = []

        def rec(i, j, acc, cost):
            if i == i1 and j == j1:
                out.append((tuple(acc), cost))
                return
            if i < i1 and j < j1:
                c = abs(left[i]["time"] - right[j]["time"]) + (
                    0 if left[i]["text"] == right[j]["text"] else MISMATCH_PENALTY
                )
                rec(
                    i + 1,
                    j + 1,
                    acc + [("match", (left[i]["time"], left[i]["text"]),
                            (right[j]["time"], right[j]["text"]), c)],
                    cost + c,
                )
            if j < j1:
                rec(i, j + 1, acc + [("left_gap", None,
                                      (right[j]["time"], right[j]["text"]), GAP_COST)],
                    cost + GAP_COST)
            if i < i1:
                rec(i + 1, j, acc + [("right_gap",
                                      (left[i]["time"], left[i]["text"]), None, GAP_COST)],
                    cost + GAP_COST)

        rec(li, lj, [], 0)
        return out

    partials = [((), 0)]
    for (a0, b0), (a1, b1) in zip(bounds, bounds[1:]):
        paths = seg_paths(a0 + 1, b0 + 1, a1, b1)
        if a1 < m:
            c = abs(left[a1]["time"] - right[b1]["time"]) + (
                0 if left[a1]["text"] == right[b1]["text"] else MISMATCH_PENALTY
            )
            anchor = (("match", (left[a1]["time"], left[a1]["text"]),
                       (right[b1]["time"], right[b1]["text"]), c),)
        else:
            anchor = ()
        partials = [
            (p + q + anchor, c0 + c + (anchor[0][3] if anchor else 0))
            for p, c0 in partials
            for q, c in paths
        ]
    return dict(partials)


_ACTION_CODE = {"match": 1, "left_gap": 2, "right_gap": 3}


def _compare_paths(p, q):
    """Independent total order: cost, then action at the last differing step."""
    a, ca = p
    b, cb = q
    if ca != cb:
        return -1 if ca < cb else 1
    for k in range(1, min(len(a), len(b)) + 1):
        if a[-k] != b[-k]:
            return -1 if _ACTION_CODE[a[-k][0]] < _ACTION_CODE[b[-k][0]] else 1
    raise AssertionError("distinct paths share their entire shorter suffix")


def _ranked(left, right, anchors=()):
    return sorted(
        _enumerate_paths(left, right, anchors).items(),
        key=cmp_to_key(_compare_paths),
    )


def test_compare_flag_off_keeps_legacy_shape_exactly():
    left = [note(0, "a"), note(4000, "b")]
    right = [note(4000, "a"), note(8000, "b")]
    plain = align(left, right)
    # Default and explicit false are the legacy call: no analysis field.
    assert align(left, right, compare_alternative=False) == plain
    assert "alternative" not in plain
    assert align(left, right, anchors=None, compare_alternative=False) == plain
    assert align(left, right, anchors=[(0, 0)], compare_alternative=False) == align(
        left, right, anchors=[(0, 0)]
    )


def test_alternative_is_strict_second_path_with_cost_and_gap():
    # Primary: right_gap + mismatch match(4000,4000) + left_gap = 2000+3000+2000.
    # Runner-up: two same-text diagonal matches = 4000 + 4000 = 8000.
    left = [note(0, "a"), note(4000, "b")]
    right = [note(4000, "a"), note(8000, "b")]
    result = align(left, right, compare_alternative=True)

    assert result["total_cost"] == 7000
    alt = result["alternative"]
    assert alt["total_cost"] == 8000
    assert alt["cost_diff"] == 1000
    assert [(s["action"], s["cost"]) for s in alt["steps"]] == [
        ("match", 4000),
        ("match", 4000),
    ]
    # The rows disagree from the very first step, which consumes left[0]/right[0].
    assert alt["first_divergence"] == {"left": 0, "right": 0}
    # Alternative rows replay their own total via cumulative costs.
    cum = 0
    for step in alt["steps"]:
        cum += step["cost"]
        assert step["cumulative_cost"] == cum
    assert cum == alt["total_cost"]
    # Every note is consumed exactly once, in order.
    assert [s["left"]["time"] for s in alt["steps"] if s["left"]] == [0, 4000]
    assert [s["right"]["time"] for s in alt["steps"] if s["right"]] == [4000, 8000]
    assert "origin" not in alt["steps"][0]


def test_alternative_tie_cost_diff_zero_uses_tie_rules():
    # The golden tail: two gap orderings share total 4250; the last-step
    # preference (left gap over right gap) fixes the runner-up deterministically.
    left = [note(0, "g"), note(4200, "p"), note(9000, "t")]
    right = [note(150, "g"), note(4100, "p"), note(12000, "h")]
    result = align(left, right, compare_alternative=True)
    alt = result["alternative"]
    assert result["total_cost"] == alt["total_cost"] == 4250
    assert alt["cost_diff"] == 0
    # The first two matches are shared; the paths split on the gap ordering,
    # and the alternative's first differing row leaves the LEFT side blank
    # while carrying right[2], so only the right index (2) is reported.
    assert alt["first_divergence"] == {"left": None, "right": 2}
    primary_actions = [s["action"] for s in result["steps"]]
    alt_actions = [s["action"] for s in alt["steps"]]
    assert primary_actions == ["match", "match", "right_gap", "left_gap"]
    assert alt_actions == ["match", "match", "left_gap", "right_gap"]


def test_empty_input_has_no_alternative():
    result = align([], [], compare_alternative=True)
    assert result["total_cost"] == 0
    assert result["steps"] == []
    assert result["alternative"] is None


def test_one_side_empty_has_no_alternative():
    # A single note has exactly one legal row, so the path is unique.
    result = align([note(1, "a")], [], compare_alternative=True)
    assert result["alternative"] is None
    result = align([], [note(1, "a")], compare_alternative=True)
    assert result["alternative"] is None


def test_fully_pinning_anchors_make_the_path_unique():
    # Forcing the only note pair pins the complete path.
    result = align(
        [note(1, "a")], [note(2, "a")],
        anchors=[(0, 0)], compare_alternative=True,
    )
    assert result["alternative"] is None

    # Two anchors split the grid into border-only segments: still unique.
    left = [note(0, "a"), note(5000, "b")]
    right = [note(10, "a"), note(5200, "b")]
    result = align(
        left, right, anchors=[(0, 0), (1, 1)], compare_alternative=True
    )
    assert result["alternative"] is None


def test_anchors_constrain_the_alternative_as_well():
    # The free runner-up swaps the tail gap order at index 2. Pinning the
    # opening pair leaves that freedom; pinning additionally through left[1]
    # removes it, so the alternative must change / disappear accordingly.
    left = [note(0, "g"), note(4200, "p"), note(9000, "t")]
    right = [note(150, "g"), note(4100, "p"), note(12000, "h")]

    pinned = align(left, right, anchors=[(0, 0)], compare_alternative=True)
    alt = pinned["alternative"]
    assert alt is not None and alt["cost_diff"] == 0
    # The forced anchor row is present identically in both paths.
    anchor_rows = [s for s in pinned["steps"] if s.get("origin") == ORIGIN_ANCHOR]
    alt_anchor_rows = [s for s in alt["steps"] if s.get("origin") == ORIGIN_ANCHOR]
    assert len(anchor_rows) == len(alt_anchor_rows) == 1
    assert anchor_rows[0] == alt_anchor_rows[0]
    assert all(s.get("origin") == ORIGIN_AUTO
               for s in alt["steps"] if s.get("origin") != ORIGIN_ANCHOR)

    full = align(
        left, right, anchors=[(0, 0), (1, 1)], compare_alternative=True
    )
    # Remaining notes are one gap on each side: the two gap orders tie, so an
    # equal-cost alternative still exists but both pairs stay anchored.
    assert full["alternative"] is not None
    assert full["alternative"]["cost_diff"] == 0
    assert sum(s.get("origin") == ORIGIN_ANCHOR
               for s in full["alternative"]["steps"]) == 2


def test_alternative_is_deterministic():
    left = [note(0, "a"), note(4000, "b")]
    right = [note(4000, "a"), note(8000, "b")]
    first = align(left, right, compare_alternative=True)["alternative"]
    for _ in range(5):
        again = align(left, right, compare_alternative=True)["alternative"]
        assert again == first


def test_alternative_exhaustive_against_independent_enumeration():
    rng = random.Random(20260913)
    cases = 0
    for trial in range(600):
        m = rng.randrange(0, 5)
        nn = rng.randrange(0, 5)
        left, right = [], []
        t = 0
        for _ in range(m):
            t += rng.randrange(1, 7) * 1000
            left.append(note(t, rng.choice(("a", "b"))))
        t = 0
        for _ in range(nn):
            t += rng.randrange(1, 7) * 1000
            right.append(note(t, rng.choice(("a", "b"))))

        k = rng.randrange(0, min(m, nn) + 1)
        anchors = list(zip(
            sorted(rng.sample(range(m), k)),
            sorted(rng.sample(range(nn), k)),
        ))

        result = align(
            left, right, anchors=anchors or None, compare_alternative=True
        )
        ranked = _ranked(left, right, anchors)
        best1, cost1 = ranked[0]
        best2 = ranked[1] if len(ranked) > 1 else None

        assert tuple(_step_sig(s) for s in result["steps"]) == best1
        assert result["total_cost"] == cost1

        alt = result["alternative"]
        if best2 is None:
            assert alt is None
        else:
            sig2, cost2 = best2
            assert alt is not None
            assert tuple(_step_sig(s) for s in alt["steps"]) == sig2
            assert alt["total_cost"] == cost2
            assert alt["cost_diff"] == cost2 - cost1

            primary_sigs = [_step_sig(s) for s in result["steps"]]
            alt_sigs = [_step_sig(s) for s in alt["steps"]]
            d = next(
                k
                for k in range(min(len(primary_sigs), len(alt_sigs)))
                if primary_sigs[k] != alt_sigs[k]
            )
            lc = sum(1 for s in primary_sigs[:d] if s[1] is not None)
            rc = sum(1 for s in primary_sigs[:d] if s[2] is not None)
            assert alt["first_divergence"] == {
                "left": lc if alt_sigs[d][1] is not None else None,
                "right": rc if alt_sigs[d][2] is not None else None,
            }
            # Validity invariants of the alternative timeline.
            assert [s["left"]["time"] for s in alt["steps"] if s["left"]] == [
                x["time"] for x in left
            ]
            assert [s["right"]["time"] for s in alt["steps"] if s["right"]] == [
                x["time"] for x in right
            ]
        cases += 1
    assert cases == 600


def test_alternative_large_inputs_200_items():
    left = [note(i * 1000, f"t{i}") for i in range(200)]
    right = [note(i * 1000 + 3, f"t{i}") for i in range(200)]
    result = align(left, right, compare_alternative=True)
    alt = result["alternative"]
    assert alt is not None
    assert alt["cost_diff"] >= 0
    assert sum(s["cost"] for s in alt["steps"]) == alt["total_cost"]
    assert len([s for s in alt["steps"] if s["left"]]) == 200
    assert len([s for s in alt["steps"] if s["right"]]) == 200


# --------------------------------------------------------------------------- #
# Optional term pairs: exact-hit synonym correspondences waiving the penalty.
# --------------------------------------------------------------------------- #


def _term_constrained_brute(left, right, anchors, term_pairs):
    """Constrained optimum with anchors and the term synonym cost model."""
    m, n = len(left), len(right)
    bounds = [(-1, -1), *anchors, (m, n)]
    total = 0
    for lo, hi in zip(bounds, bounds[1:]):
        sub_l = left[lo[0] + 1 : hi[0]]
        sub_r = right[lo[1] + 1 : hi[1]]

        @lru_cache(maxsize=None)
        def opt(i: int, j: int) -> float:
            if i == len(sub_l) and j == len(sub_r):
                return 0
            best = float("inf")
            if i < len(sub_l) and j < len(sub_r):
                best = min(
                    best,
                    _term_pair_cost(sub_l[i], sub_r[j], term_pairs)
                    + opt(i + 1, j + 1),
                )
            if i < len(sub_l):
                best = min(best, GAP_COST + opt(i + 1, j))
            if j < len(sub_r):
                best = min(best, GAP_COST + opt(i, j + 1))
            return best

        total += int(opt(0, 0))
        if hi != (m, n):
            total += _term_pair_cost(left[hi[0]], right[hi[1]], term_pairs)
    return total


def test_term_pairs_absent_or_empty_keep_legacy_result():
    left = [note(0, "人工智能"), note(9000, "结束语")]
    right = [note(100, "AI"), note(9200, "结束语")]
    free = align(left, right)
    assert "term_pairs" not in free
    assert all("term_pair" not in s for s in free["steps"])
    assert align(left, right, term_pairs=None) == free
    assert align(left, right, term_pairs=[]) == free


def test_term_pairs_exact_hit_waives_penalty_and_tags_the_row():
    left = [note(0, "人工智能"), note(9000, "结束语")]
    right = [note(100, "AI"), note(9200, "结束语")]
    result = align(left, right, term_pairs=[("人工智能", "AI")])

    assert result["term_pairs"] == [
        {"left_text": "人工智能", "right_text": "AI"}
    ]
    rows = result["steps"]
    assert [s["action"] for s in rows] == ["match", "match"]
    # The synonym match costs the plain time difference (100), no +3000.
    hit = rows[0]
    assert hit["cost"] == 100
    assert hit["term_pair"] == {"left_text": "人工智能", "right_text": "AI"}
    # The equal-text match keeps the ordinary same-text presentation.
    assert "term_pair" not in rows[1]
    assert rows[1]["cost"] == 200
    assert result["total_cost"] == 300


def test_term_pairs_non_hit_different_text_stays_penalized():
    left = [note(0, "x")]
    right = [note(0, "y")]
    result = align(left, right, term_pairs=[("a", "b")])
    assert result["total_cost"] == MISMATCH_PENALTY
    assert "term_pair" not in result["steps"][0]


def test_term_pairs_waive_on_forced_anchor_match():
    left = [note(0, "人工智能"), note(9000, "结束语")]
    right = [note(100, "AI"), note(9200, "结束语")]
    result = align(
        left, right,
        anchors=[(0, 0)], term_pairs=[("人工智能", "AI")],
    )
    anchor_row = next(s for s in result["steps"] if s["origin"] == ORIGIN_ANCHOR)
    assert anchor_row["cost"] == 100
    assert anchor_row["term_pair"] == {
        "left_text": "人工智能", "right_text": "AI"
    }
    # The echo is present even though anchors are also in the response.
    assert result["term_pairs"] == [
        {"left_text": "人工智能", "right_text": "AI"}
    ]


def test_term_pairs_apply_to_the_alternative_path_too():
    # Two same-time-position synonym notes plus a tail gap tie: the
    # alternative (gap-order swap) and any synonym match share the rule.
    left = [note(0, "g"), note(4200, "p"), note(9000, "t")]
    right = [note(150, "G"), note(4100, "P"), note(12000, "h")]
    pairs = [("g", "G"), ("p", "P")]
    result = align(left, right, compare_alternative=True, term_pairs=pairs)
    alt = result["alternative"]
    assert alt is not None and alt["cost_diff"] == 0
    # Both opening matches are term hits in primary and alternative.
    for path in (result["steps"], alt["steps"]):
        assert path[0]["term_pair"] == {"left_text": "g", "right_text": "G"}
        assert path[1]["term_pair"] == {"left_text": "p", "right_text": "P"}
    # Waiving both penalties turns the primary into the two matches + gaps at
    # 150 + 100 + 2000 + 2000 = 4250 instead of the penalized 10250.
    assert result["total_cost"] == 4250


def test_term_pairs_exhaustive_against_independent_recursion():
    rng = random.Random(20260913)
    cases = 0
    for trial in range(500):
        m = rng.randrange(0, 6)
        nn = rng.randrange(0, 6)
        vocab = ("a", "b", "c")
        left, right = [], []
        t = 0
        for _ in range(m):
            t += rng.randrange(0, 7000)
            left.append(note(t, rng.choice(vocab)))
        t = 0
        for _ in range(nn):
            t += rng.randrange(0, 7000)
            right.append(note(t, rng.choice(vocab)))

        # Declare a random synonym table: each left vocab word maps once to
        # at most one right vocab word and vice versa (validation rule).
        perm = list(vocab)
        rng.shuffle(perm)
        declared = list(zip(vocab, perm))
        k = rng.randrange(0, len(declared) + 1)
        term_pairs = declared[:k]

        # Optional monotonic anchors.
        ka = rng.randrange(0, min(m, nn) + 1)
        anchors = list(zip(
            sorted(rng.sample(range(m), ka)),
            sorted(rng.sample(range(nn), ka)),
        ))

        result = align(
            left, right, anchors=anchors or None, term_pairs=term_pairs or None
        )
        assert result["total_cost"] == _term_constrained_brute(
            left, right, anchors, term_pairs
        )

        # Every hit row is an exact declared pair on different texts; every
        # other match row carries no term_pair marker.
        for s in result["steps"]:
            if s["action"] != "match":
                assert "term_pair" not in s
                continue
            lt, rt = s["left"]["text"], s["right"]["text"]
            if "term_pair" in s:
                assert (lt, rt) in set(term_pairs)
                assert lt != rt
                # A tagged row's cost is exactly the time difference.
                assert s["cost"] == abs(s["left"]["time"] - s["right"]["time"])
            else:
                assert not (
                    lt != rt and _synonymous(lt, rt, term_pairs)
                )
        cases += 1
    assert cases == 500


def test_term_pairs_alternative_exhaustive_against_enumeration():
    """The 2-best runner-up under the synonym cost matches an enumeration."""

    def enumerate_ranked(left, right, term_pairs):
        m, n = len(left), len(right)
        found: dict[tuple, int] = {}

        def rec(i, j, acc, cost):
            if i == m and j == n:
                found[tuple(acc)] = cost
                return
            if i < m and j < n:
                c = _term_pair_cost(left[i], right[j], term_pairs)
                rec(i + 1, j + 1,
                    acc + [("match", (left[i]["time"], left[i]["text"]),
                            (right[j]["time"], right[j]["text"]), c)],
                    cost + c)
            if j < n:
                rec(i, j + 1,
                    acc + [("left_gap", None,
                            (right[j]["time"], right[j]["text"]), GAP_COST)],
                    cost + GAP_COST)
            if i < m:
                rec(i + 1, j,
                    acc + [("right_gap",
                            (left[i]["time"], left[i]["text"]), None, GAP_COST)],
                    cost + GAP_COST)

        rec(0, 0, [], 0)
        return sorted(found.items(), key=cmp_to_key(_compare_paths))

    rng = random.Random(99132026)
    cases = 0
    for _ in range(300):
        m = rng.randrange(0, 5)
        nn = rng.randrange(0, 5)
        left, right = [], []
        t = 0
        for _ in range(m):
            t += rng.randrange(1, 7) * 1000
            left.append(note(t, rng.choice(("a", "b"))))
        t = 0
        for _ in range(nn):
            t += rng.randrange(1, 7) * 1000
            right.append(note(t, rng.choice(("c", "d"))))
        # Every (a/b) <-> (c/d) combination may be declared synonym on hits.
        term_pairs = [
            (lt, rt) for lt in ("a", "b") for rt in ("c", "d")
            if rng.random() < 0.5
        ]
        # Per-side uniqueness: drop later rows reusing a side word.
        seen_l, seen_r, unique_pairs = set(), set(), []
        for lt, rt in term_pairs:
            if lt in seen_l or rt in seen_r:
                continue
            seen_l.add(lt)
            seen_r.add(rt)
            unique_pairs.append((lt, rt))
        term_pairs = unique_pairs

        result = align(
            left, right, compare_alternative=True,
            term_pairs=term_pairs or None,
        )
        ranked = enumerate_ranked(left, right, term_pairs)
        best1, cost1 = ranked[0]
        assert tuple(_step_sig(s) for s in result["steps"]) == best1
        assert result["total_cost"] == cost1
        if len(ranked) > 1:
            sig2, cost2 = ranked[1]
            alt = result["alternative"]
            assert alt is not None
            assert tuple(_step_sig(s) for s in alt["steps"]) == sig2
            assert alt["total_cost"] == cost2
            assert alt["cost_diff"] == cost2 - cost1
        else:
            assert result["alternative"] is None
        cases += 1
    assert cases == 300
