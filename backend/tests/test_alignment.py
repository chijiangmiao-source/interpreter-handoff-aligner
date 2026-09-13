"""Unit tests for the DP alignment algorithm, tie-breaking and anchors."""

import itertools
import random
from functools import lru_cache

from app.alignment import (
    GAP_COST,
    MISMATCH_PENALTY,
    ORIGIN_ANCHOR,
    ORIGIN_AUTO,
    align,
)


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
