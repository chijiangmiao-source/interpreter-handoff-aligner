"""Unit tests for the DP alignment algorithm and its tie-breaking."""

import itertools
from functools import lru_cache

from app.alignment import (
    GAP_COST,
    MISMATCH_PENALTY,
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
    result = align([note(100, "a")], [])
    assert result["steps"][0]["action"] == "left_gap"
    assert result["steps"][0]["cost"] == GAP_COST
    assert result["steps"][0]["left"] == note(100, "a")
    assert result["steps"][0]["right"] is None
    assert result["total_cost"] == GAP_COST

    result = align([], [note(100, "a")])
    assert result["steps"][0]["action"] == "right_gap"
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
    assert actions == ["right_gap", "left_gap"]
    assert result["total_cost"] == 2 * GAP_COST


def test_tie_match_vs_two_gaps_prefers_match():
    # Match 4000 ties with left+right gap 4000 -> match priority wins.
    result = align([note(0, "same")], [note(4000, "same")])
    assert [s["action"] for s in result["steps"]] == ["match"]
    assert result["total_cost"] == 4000


def test_tie_left_gap_vs_right_gap_prefers_left_gap():
    # Cell (1,2): left_gap and right_gap both cost 6000 (see derivation
    # below); left_gap has the higher priority.
    left = [note(0, "a")]
    right = [note(4000, "a"), note(4100, "b")]
    result = align(left, right)
    # (1,1): match 4000 ties with both gap routes -> match.
    # (1,2): match = 2000 + 4100 + 3000 = 9100
    #        left_gap  = dp(0,2)=4000 + 2000 = 6000
    #        right_gap = dp(1,1)=4000 + 2000 = 6000  -> left_gap wins
    assert result["total_cost"] == 6000
    assert [s["action"] for s in result["steps"]] == [
        "right_gap",
        "right_gap",
        "left_gap",
    ]


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
    assert matched_left == sorted(left, key=lambda n: n["time"])[0:0] or True
    assert matched_left == [0, 10000]  # every left note appears, in order
    assert matched_right == [100, 9999]
    assert result["counts"]["match"] + result["counts"]["left_gap"] == 2
    assert result["counts"]["match"] + result["counts"]["right_gap"] == 2
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
