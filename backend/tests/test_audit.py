"""Tests for candidate verification (app.audit).

Covers the structural single-error contract of ``validate_candidate`` and the
row-by-row semantic replay of ``audit``: action/blank-side consistency,
conservation (complete, in order, each original note used once), anchor
pinning, exact term-pair hit cost, cumulative and total costs — including the
first-difference envelope (path, expected, actual) and randomized round trips
through the real DP output.
"""

import random

import pytest

from app.alignment import align
from app.audit import audit, validate_candidate

GOLDEN_LEFT = [
    {"time": 0, "text": "各位媒体朋友下午好"},
    {"time": 4200, "text": "新产品将于下月上市"},
    {"time": 9000, "text": "感谢各位的提问"},
]
GOLDEN_RIGHT = [
    {"time": 150, "text": "各位媒体朋友下午好"},
    {"time": 4100, "text": "新产品将于下月上市"},
    {"time": 12000, "text": "交接后的补充记录"},
]


@pytest.fixture
def golden_candidate():
    result = align(GOLDEN_LEFT, GOLDEN_RIGHT)
    return {"steps": result["steps"], "total_cost": result["total_cost"]}


def run(candidate, left=None, right=None, anchors=None, terms=None):
    return audit(
        GOLDEN_LEFT if left is None else left,
        GOLDEN_RIGHT if right is None else right,
        anchors,
        terms,
        candidate,
    )


# -------------------------------------------------------------------------- #
# Structural validation
# -------------------------------------------------------------------------- #


def test_valid_candidate_structure_passes(golden_candidate):
    assert validate_candidate(golden_candidate) == (None, None)


def test_empty_timeline_candidate_passes():
    assert validate_candidate({"steps": [], "total_cost": 0}) == (None, None)


@pytest.mark.parametrize(
    "candidate,path",
    [
        ([], "candidate"),
        ("x", "candidate"),
        ({"total_cost": 0}, "candidate.steps"),
        ({"steps": {}, "total_cost": 0}, "candidate.steps"),
        ({"steps": []}, "candidate.total_cost"),
        ({"steps": [], "total_cost": -1}, "candidate.total_cost"),
        ({"steps": [], "total_cost": "1"}, "candidate.total_cost"),
        ({"steps": [], "total_cost": True}, "candidate.total_cost"),
    ],
)
def test_root_shape_failures(candidate, path):
    bad_path, _ = validate_candidate(candidate)
    assert bad_path == path


def test_step_must_be_object():
    bad_path, _ = validate_candidate({"steps": [1], "total_cost": 0})
    assert bad_path == "candidate.steps[0]"


def test_unknown_step_field():
    step = {
        "action": "match",
        "left": {"time": 0, "text": "a"},
        "right": {"time": 0, "text": "a"},
        "cost": 0,
        "cumulative_cost": 0,
        "who": 1,
    }
    bad_path, _ = validate_candidate({"steps": [step], "total_cost": 0})
    assert bad_path == "candidate.steps[0].who"


def test_action_required_and_known():
    base = {
        "left": {"time": 0, "text": "a"},
        "right": {"time": 0, "text": "a"},
        "cost": 0,
        "cumulative_cost": 0,
    }
    bad_path, _ = validate_candidate({"steps": [dict(base)], "total_cost": 0})
    assert bad_path == "candidate.steps[0].action"
    bad_path, _ = validate_candidate(
        {"steps": [{**base, "action": "delete"}], "total_cost": 0}
    )
    assert bad_path == "candidate.steps[0].action"


def test_side_slot_must_be_present():
    step = {
        "action": "left_gap",
        "right": {"time": 0, "text": "a"},
        "cost": 2000,
        "cumulative_cost": 2000,
    }
    bad_path, _ = validate_candidate({"steps": [step], "total_cost": 2000})
    assert bad_path == "candidate.steps[0].left"


def test_side_slot_null_or_note():
    def step(note):
        return {
            "action": "right_gap",
            "left": note,
            "right": None,
            "cost": 2000,
            "cumulative_cost": 2000,
        }

    assert validate_candidate({"steps": [step(1)], "total_cost": 2000})[0] == \
        "candidate.steps[0].left"
    assert validate_candidate(
        {"steps": [step({"time": 1, "text": "a", "x": 1})], "total_cost": 2000}
    )[0] == "candidate.steps[0].left.x"
    assert validate_candidate(
        {"steps": [step({"time": "1", "text": "a"})], "total_cost": 2000}
    )[0] == "candidate.steps[0].left.time"
    assert validate_candidate(
        {"steps": [step({"time": 1, "text": ""})], "total_cost": 2000}
    )[0] == "candidate.steps[0].left.text"


def test_costs_must_be_non_negative_ints():
    base = {
        "action": "left_gap",
        "left": None,
        "right": {"time": 0, "text": "a"},
    }
    for value, field in [("2000", "cost"), (-1, "cost"), (1.5, "cost"),
                         (True, "cumulative_cost"), (None, "cumulative_cost")]:
        step = {**base, "cost": 2000, "cumulative_cost": 2000, field: value}
        bad_path, _ = validate_candidate({"steps": [step], "total_cost": 2000})
        assert bad_path == f"candidate.steps[0].{field}"


def test_origin_and_term_pair_shapes():
    base = {
        "action": "match",
        "left": {"time": 0, "text": "a"},
        "right": {"time": 0, "text": "b"},
        "cost": 0,
        "cumulative_cost": 0,
    }
    bad_path, _ = validate_candidate(
        {"steps": [{**base, "origin": "human"}], "total_cost": 0}
    )
    assert bad_path == "candidate.steps[0].origin"
    bad_path, _ = validate_candidate(
        {"steps": [{**base, "term_pair": {"left_text": "a"}}], "total_cost": 0}
    )
    assert bad_path == "candidate.steps[0].term_pair.right_text"
    bad_path, _ = validate_candidate(
        {"steps": [{**base, "term_pair": {"left_text": "a", "right_text": ""}}],
         "total_cost": 0}
    )
    assert bad_path == "candidate.steps[0].term_pair.right_text"
    # An explicit null term_pair is allowed.
    assert validate_candidate(
        {"steps": [{**base, "term_pair": None}], "total_cost": 0}
    ) == (None, None)


# -------------------------------------------------------------------------- #
# Successful replays
# -------------------------------------------------------------------------- #


def test_golden_candidate_passes_with_row_details(golden_candidate):
    outcome = run(golden_candidate)
    assert outcome["ok"] is True
    assert outcome["total_cost"] == 4250
    assert outcome["counts"] == {"match": 2, "left_gap": 1, "right_gap": 1}
    assert outcome["consumed"] == {"left": 3, "right": 3}
    costs = [d["expected_cost"] for d in outcome["steps"]]
    assert costs == [150, 100, 2000, 2000]
    cumulative = [d["expected_cumulative_cost"] for d in outcome["steps"]]
    assert cumulative == [150, 250, 2250, 4250]
    assert [d["consumed"] for d in outcome["steps"]] == [
        {"left": 0, "right": 0},
        {"left": 1, "right": 1},
        {"left": 2, "right": None},
        {"left": None, "right": 2},
    ]
    # Every actual value equals the recomputed value on a passing run.
    assert all(d["expected_cost"] == d["actual_cost"] for d in outcome["steps"])


def test_empty_inputs_zero_cost_candidate():
    outcome = run({"steps": [], "total_cost": 0}, left=[], right=[])
    assert outcome == {
        "ok": True,
        "total_cost": 0,
        "counts": {"match": 0, "left_gap": 0, "right_gap": 0},
        "consumed": {"left": 0, "right": 0},
        "anchors": [],
        "steps": [],
    }


def test_anchored_candidate_passes_and_pins_rows():
    anchors = [(0, 0)]
    result = align(GOLDEN_LEFT, GOLDEN_RIGHT, anchors=anchors)
    outcome = run(
        {"steps": result["steps"], "total_cost": result["total_cost"]},
        anchors=anchors,
    )
    assert outcome["ok"] is True
    origins = [d["origin"] for d in outcome["steps"]]
    assert origins[0] == "anchor"
    assert origins[1:] == ["auto", "auto", "auto"]


def test_term_pair_candidate_recomputes_without_penalty():
    left = [{"time": 0, "text": "人工智能"}, {"time": 9000, "text": "结束语"}]
    right = [{"time": 100, "text": "AI"}, {"time": 9200, "text": "结束语"}]
    terms = [("人工智能", "AI")]
    result = align(left, right, term_pairs=terms)
    outcome = run(
        {"steps": result["steps"], "total_cost": result["total_cost"]},
        left=left,
        right=right,
        terms=terms,
    )
    assert outcome["ok"] is True
    assert outcome["total_cost"] == 300
    assert outcome["steps"][0]["expected_term_pair"] == {
        "left_text": "人工智能",
        "right_text": "AI",
    }
    assert "免除 3000" in outcome["steps"][0]["basis"]


def test_anchors_and_terms_together_recompute():
    left = [
        {"time": 0, "text": "g"},
        {"time": 4200, "text": "p"},
        {"time": 9000, "text": "t"},
    ]
    right = [
        {"time": 150, "text": "G"},
        {"time": 4100, "text": "P"},
        {"time": 12000, "text": "h"},
    ]
    anchors = [(0, 0)]
    terms = [("g", "G"), ("p", "P")]
    result = align(left, right, anchors=anchors, term_pairs=terms)
    outcome = run(
        {"steps": result["steps"], "total_cost": result["total_cost"]},
        left=left,
        right=right,
        anchors=anchors,
        terms=terms,
    )
    assert outcome["ok"] is True
    first = outcome["steps"][0]
    assert first["origin"] == "anchor"
    assert first["expected_term_pair"] == {"left_text": "g", "right_text": "G"}
    assert first["expected_cost"] == 150


# -------------------------------------------------------------------------- #
# Semantic failures: first definite difference only
# -------------------------------------------------------------------------- #


def _copy_steps(candidate):
    return [dict(s) for s in candidate["steps"]]


def test_wrong_single_step_cost_is_rejected(golden_candidate):
    steps = _copy_steps(golden_candidate)
    steps[2]["cost"] = 9999
    outcome = run({**golden_candidate, "steps": steps})
    assert outcome["ok"] is False
    assert outcome["path"] == "candidate.steps[2].cost"
    assert outcome["expected"] == 2000
    assert outcome["actual"] == 9999


def test_wrong_cumulative_cost_is_rejected(golden_candidate):
    steps = _copy_steps(golden_candidate)
    steps[1]["cumulative_cost"] = 999
    outcome = run({**golden_candidate, "steps": steps})
    assert outcome["path"] == "candidate.steps[1].cumulative_cost"
    assert outcome["expected"] == 250
    assert outcome["actual"] == 999


def test_wrong_total_cost_is_rejected(golden_candidate):
    outcome = run({**golden_candidate, "total_cost": 4249})
    assert outcome["path"] == "candidate.total_cost"
    assert outcome["expected"] == 4250
    assert outcome["actual"] == 4249


def test_missing_left_note_is_localized_at_end(golden_candidate):
    # Drop the right_gap row carrying left[2] (感谢各位的提问) and replay the
    # remaining rows' cumulative costs, so conservation is the first breach.
    kept = [dict(s) for s in golden_candidate["steps"] if s["action"] != "right_gap"]
    cumulative = 0
    for s in kept:
        cumulative += s["cost"]
        s["cumulative_cost"] = cumulative
    outcome = run({"steps": kept, "total_cost": cumulative})
    assert outcome["ok"] is False
    assert outcome["path"] == "candidate.steps[3]"
    assert outcome["expected"] == {"time": 9000, "text": "感谢各位的提问"}
    assert outcome["actual"] is None
    assert "遗漏" in outcome["error"]


def test_missing_right_note_is_localized_at_end(golden_candidate):
    kept = [dict(s) for s in golden_candidate["steps"] if s["action"] != "left_gap"]
    cumulative = 0
    for s in kept:
        cumulative += s["cost"]
        s["cumulative_cost"] = cumulative
    outcome = run({"steps": kept, "total_cost": cumulative})
    assert outcome["path"] == "candidate.steps[3]"
    assert outcome["expected"] == {"time": 12000, "text": "交接后的补充记录"}


def test_duplicate_note_is_localized_on_the_repeated_row(golden_candidate):
    steps = _copy_steps(golden_candidate)
    # Repeat the right_gap row (left[2]) before the trailing left_gap.
    repeated = dict(steps[2])
    steps.insert(3, repeated)
    outcome = run({"steps": steps, "total_cost": 6250})
    assert outcome["ok"] is False
    assert outcome["path"] == "candidate.steps[3].left"
    assert "left[2]" in outcome["actual"]
    assert "重复" in outcome["error"]


def test_reordered_notes_are_localized(golden_candidate):
    # Swap the two opening matches' left notes: row 0 then uses left[1].
    steps = _copy_steps(golden_candidate)
    steps[0]["left"], steps[1]["left"] = steps[1]["left"], steps[0]["left"]
    # Costs of those rows are now wrong too, but order/conservation is checked
    # first, so the first difference is the out-of-order note on row 0.
    outcome = run({**golden_candidate, "steps": steps})
    assert outcome["path"] == "candidate.steps[0].left"
    assert outcome["expected"] == "left[0]"
    assert outcome["actual"] == "left[1]"


def test_unknown_note_content_is_localized(golden_candidate):
    steps = _copy_steps(golden_candidate)
    steps[0]["left"] = {"time": 0, "text": "被外部改写的内容"}
    outcome = run({**golden_candidate, "steps": steps})
    assert outcome["path"] == "candidate.steps[0].left"
    assert outcome["expected"] == GOLDEN_LEFT[0]
    assert outcome["actual"] == {"time": 0, "text": "被外部改写的内容"}


def test_match_row_may_not_leave_a_side_blank(golden_candidate):
    steps = _copy_steps(golden_candidate)
    steps[0]["left"] = None
    outcome = run({**golden_candidate, "steps": steps})
    assert outcome["path"] == "candidate.steps[0].action"


def test_gap_row_must_blank_the_named_side(golden_candidate):
    steps = _copy_steps(golden_candidate)
    # right_gap row must keep the LEFT note and null on the right.
    steps[2]["left"], steps[2]["right"] = None, steps[2]["left"]
    outcome = run({**golden_candidate, "steps": steps})
    assert outcome["path"] == "candidate.steps[2].right"


def test_mismatch_penalty_cannot_be_silently_dropped():
    # Different texts, no term pair: a match must cost |dt| + 3000.
    left = [{"time": 0, "text": "a"}]
    right = [{"time": 100, "text": "b"}]
    candidate = {
        "steps": [
            {
                "action": "match",
                "left": left[0],
                "right": right[0],
                "cost": 100,  # should be 3100
                "cumulative_cost": 100,
            }
        ],
        "total_cost": 100,
    }
    outcome = run(candidate, left=left, right=right)
    assert outcome["path"] == "candidate.steps[0].cost"
    assert outcome["expected"] == 3100
    assert outcome["actual"] == 100


def test_undeclared_term_marker_is_rejected():
    # The pair is a real exact hit only when the term is declared.
    left = [{"time": 0, "text": "人工智能"}]
    right = [{"time": 100, "text": "AI"}]
    step = {
        "action": "match",
        "left": left[0],
        "right": right[0],
        "cost": 3100,
        "cumulative_cost": 3100,
        "term_pair": {"left_text": "人工智能", "right_text": "AI"},
    }
    outcome = run({"steps": [step], "total_cost": 3100}, left=left, right=right)
    assert outcome["path"] == "candidate.steps[0].term_pair"
    assert outcome["expected"] is None
    assert outcome["actual"] == {"left_text": "人工智能", "right_text": "AI"}


def test_declared_term_requires_the_hit_marker_and_waived_cost():
    left = [{"time": 0, "text": "人工智能"}]
    right = [{"time": 100, "text": "AI"}]
    terms = [("人工智能", "AI")]
    # Cost correctly waived (100) but the term_pair marker missing.
    step = {
        "action": "match",
        "left": left[0],
        "right": right[0],
        "cost": 100,
        "cumulative_cost": 100,
    }
    outcome = run({"steps": [step], "total_cost": 100}, left=left, right=right, terms=terms)
    assert outcome["path"] == "candidate.steps[0].term_pair"
    assert outcome["expected"] == {"left_text": "人工智能", "right_text": "AI"}


def test_anchor_row_must_be_marked_anchor():
    anchors = [(0, 0)]
    result = align(GOLDEN_LEFT, GOLDEN_RIGHT, anchors=anchors)
    steps = [dict(s) for s in result["steps"]]
    steps[0].pop("origin")  # the forced pair is present but unmarked
    outcome = run(
        {"steps": steps, "total_cost": result["total_cost"]}, anchors=anchors
    )
    assert outcome["path"] == "candidate.steps[0].origin"
    assert outcome["expected"] == "anchor"
    assert outcome["actual"] is None


def test_non_anchor_row_must_not_claim_anchor_origin():
    anchors = [(0, 0)]
    result = align(GOLDEN_LEFT, GOLDEN_RIGHT, anchors=anchors)
    steps = [dict(s) for s in result["steps"]]
    # row 1 is the free (1,1) match; mark it as an anchor wrongly.
    steps[1]["origin"] = "anchor"
    outcome = run(
        {"steps": steps, "total_cost": result["total_cost"]},
        anchors=anchors,
    )
    assert outcome["path"] == "candidate.steps[1].origin"
    assert outcome["expected"] == "auto"
    assert outcome["actual"] == "anchor"


def test_missing_anchor_pair_is_rejected(golden_candidate):
    # The free golden timeline never pairs left[2] with anything; force that
    # pair as an anchor and audit the unanchored candidate against it.
    anchors = [(2, 1)]
    outcome = run(golden_candidate, anchors=anchors)
    assert outcome["ok"] is False
    assert "锚点" in outcome["error"]
    assert outcome["path"].startswith("candidate.steps[")


def test_anchor_origin_without_anchors_in_request_is_rejected(golden_candidate):
    # No anchors are verified against; a row may not claim the pinning.
    steps = _copy_steps(golden_candidate)
    steps[0]["origin"] = "anchor"
    outcome = run({"steps": steps, "total_cost": golden_candidate["total_cost"]})
    assert outcome["ok"] is False
    assert outcome["path"] == "candidate.steps[0].origin"
    assert outcome["actual"] == "anchor"


def test_gap_row_origin_anchor_is_rejected():
    anchors = [(0, 0)]
    result = align(GOLDEN_LEFT, GOLDEN_RIGHT, anchors=anchors)
    steps = [dict(s) for s in result["steps"]]
    steps[2]["origin"] = "anchor"  # a gap row can never be an anchor
    outcome = run(
        {"steps": steps, "total_cost": result["total_cost"]},
        anchors=anchors,
    )
    assert outcome["path"] == "candidate.steps[2].origin"
    assert outcome["expected"] == "auto"


def test_huge_integer_timestamps_recompute_exactly():
    big_a = 9007199254740993
    big_b = 9007199254740995
    left = [{"time": big_a, "text": "交接点"}]
    right = [{"time": big_a + 1, "text": "交接点"}]
    result = align(left, right)
    outcome = run(
        {"steps": result["steps"], "total_cost": result["total_cost"]},
        left=left,
        right=right,
    )
    assert outcome["ok"] is True
    assert outcome["total_cost"] == 1
    # The tail must not be auditable as consumed while a huge second left note
    # is left out.
    missing = run(
        {"steps": result["steps"], "total_cost": 1},
        left=left + [{"time": big_b, "text": "结束语"}],
        right=right,
    )
    assert missing["path"] == "candidate.steps[1]"
    assert missing["expected"]["time"] == big_b


# -------------------------------------------------------------------------- #
# Randomized round trips: every DP output verifies against its own inputs.
# -------------------------------------------------------------------------- #


def test_every_dp_output_verifies_randomized():
    rng = random.Random(20260913)
    texts = ["a", "b", "c", "d"]
    for trial in range(300):
        m = rng.randrange(0, 6)
        n = rng.randrange(0, 6)
        left = [
            {"time": rng.randrange(0, 50) * 100, "text": rng.choice(texts)}
            for _ in range(m)
        ]
        right = [
            {"time": rng.randrange(0, 50) * 100, "text": rng.choice(texts)}
            for _ in range(n)
        ]
        # Sort + de-duplicate times per side so they pass sequence validation.
        for seq in (left, right):
            seq.sort(key=lambda item: item["time"])
            for k in range(1, len(seq)):
                if seq[k]["time"] <= seq[k - 1]["time"]:
                    seq[k]["time"] = seq[k - 1]["time"] + 1

        anchors = None
        if m and n and trial % 3 == 0:
            k = rng.randrange(1, min(m, n) + 1)
            ls = sorted(rng.sample(range(m), k))
            rs = sorted(rng.sample(range(n), k))
            anchors = list(zip(ls, rs))

        terms = None
        if trial % 3 == 1:
            pairs = set()
            for _ in range(rng.randrange(1, 4)):
                pairs.add((rng.choice(texts), rng.choice(texts)))
            terms = list(pairs)

        result = align(left, right, anchors=anchors, term_pairs=terms)
        candidate = {"steps": result["steps"], "total_cost": result["total_cost"]}
        outcome = audit(left, right, anchors, terms, candidate)
        assert outcome["ok"] is True, (
            f"trial {trial}: {outcome} left={left} right={right} "
            f"anchors={anchors} terms={terms}"
        )
        assert outcome["total_cost"] == result["total_cost"]
