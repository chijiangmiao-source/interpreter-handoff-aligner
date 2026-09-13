"""Tests for structural validation and the single-error contract."""

from app.validation import MAX_ITEMS, validate_anchors, validate_sequence


def seq(*items):
    return list(items)


def n(t, text="x"):
    return {"time": t, "text": text}


def test_valid_sequences():
    assert validate_sequence([], "left") is None
    assert validate_sequence([n(1), n(2, "y"), n(10**9, "中文")], "left") is None


def test_not_an_array():
    assert validate_sequence({"time": 1}, "left") == "left"
    assert validate_sequence("nope", "right") == "right"


def test_too_many_items_points_at_first_over_limit():
    big = [n(i) for i in range(MAX_ITEMS + 1)]
    assert validate_sequence(big, "left") == f"left[{MAX_ITEMS}]"


def test_boundary_200_items_ok():
    assert validate_sequence([n(i) for i in range(MAX_ITEMS)], "left") is None


def test_item_not_object():
    assert validate_sequence([1], "left") == "left[0]"
    assert validate_sequence([n(1), "x"], "right") == "right[1]"


def test_missing_time():
    assert validate_sequence([{"text": "x"}], "left") == "left[0].time"


def test_time_must_be_integer():
    assert validate_sequence([n("1")], "left") == "left[0].time"
    assert validate_sequence([{"time": 1.5, "text": "x"}], "left") == "left[0].time"
    # bool is not a timestamp
    assert validate_sequence([{"time": True, "text": "x"}], "left") == "left[0].time"
    assert validate_sequence([{"time": None, "text": "x"}], "left") == "left[0].time"


def test_missing_or_empty_text():
    assert validate_sequence([{"time": 1}], "right") == "right[0].text"
    assert validate_sequence([{"time": 1, "text": ""}], "right") == "right[0].text"
    assert validate_sequence([{"time": 1, "text": 3}], "right") == "right[0].text"


def test_whitespace_only_text_is_non_empty_and_valid():
    assert validate_sequence([{"time": 1, "text": " "}], "left") is None


def test_duplicate_time_fails():
    assert validate_sequence([n(5), n(5)], "left") == "left[1].time"


def test_decreasing_time_fails_at_first_offender():
    assert validate_sequence([n(1), n(5), n(4), n(3)], "left") == "left[2].time"


def test_extra_field_rejected():
    item = {"time": 1, "text": "x", "source": "A"}
    assert validate_sequence([item], "left") == "left[0].source"


def test_only_first_error_is_reported():
    # Two errors at once (bad time AND empty text): time is checked first.
    bad = {"time": "no", "text": ""}
    assert validate_sequence([bad], "left") == "left[0].time"

    # Error at index 0 and 2: index 0 wins.
    data = [{"time": "x", "text": "y"}, n(1), n(1)]
    assert validate_sequence(data, "right") == "right[0].time"


# --------------------------------------------------------------------------- #
# Anchors: existence (in range), no reuse, strict monotonicity (no crossing).
# --------------------------------------------------------------------------- #


def anchors_error(anchors, m=3, n=3):
    """Run validate_anchors and return (path, message), shorthand."""
    path, message = validate_anchors(anchors, m, n)
    return path, message


def test_anchors_empty_and_none_are_valid():
    assert validate_anchors([], 0, 0) == (None, None)
    assert validate_anchors([], 3, 3) == (None, None)
    assert validate_anchors(
        [{"left": 2, "right": 2}], 3, 3
    ) == (None, None)


def test_anchors_not_an_array():
    path, _ = anchors_error({"left": 0, "right": 0})
    assert path == "anchors"
    path, _ = anchors_error("nope")
    assert path == "anchors"


def test_anchors_entry_must_be_object():
    path, _ = anchors_error([5])
    assert path == "anchors[0]"
    path, _ = anchors_error([[0, 0]])
    assert path == "anchors[0]"
    path, _ = anchors_error([None])
    assert path == "anchors[0]"


def test_anchors_keys_only_left_right():
    assert anchors_error([{"left": 0, "right": 0, "who": 1}])[0] == "anchors[0].who"
    assert anchors_error([{"left": 0}])[0] == "anchors[0].right"
    assert anchors_error([{"right": 0}])[0] == "anchors[0].left"


def test_anchors_indices_must_be_plain_nonneg_int():
    for bad in (1.5, "0", True, None, [0]):
        assert anchors_error([{"left": bad, "right": 0}])[0] == "anchors[0].left", bad
        assert anchors_error([{"left": 0, "right": bad}])[0] == "anchors[0].right", bad
    # An in-range index is fine; out-of-range is what is rejected next.
    assert anchors_error([{"left": 0, "right": 6}])[0] == "anchors[0].right"


def test_anchors_out_of_range_on_either_side():
    # left/right lengths are 3 each (0..2).
    assert anchors_error([{"left": 3, "right": 0}])[0] == "anchors[0].left"
    assert anchors_error([{"left": 0, "right": 3}])[0] == "anchors[0].right"
    assert anchors_error([{"left": -1, "right": 0}])[0] == "anchors[0].left"
    assert anchors_error([{"left": 0, "right": -1}])[0] == "anchors[0].right"
    # m=0/n=0: any index is out of range even if it looks valid elsewhere.
    assert anchors_error([{"left": 0, "right": 0}], m=0, n=0)[0] == "anchors[0].left"
    assert anchors_error([{"left": 0, "right": 0}], m=1, n=0)[0] == "anchors[0].right"


def test_anchors_reuse_detected():
    # Same left index in two anchors -> second .left reported.
    assert anchors_error([
        {"left": 0, "right": 0}, {"left": 0, "right": 1}
    ])[0] == "anchors[1].left"
    # Same right index -> second .right reported.
    assert anchors_error([
        {"left": 0, "right": 0}, {"left": 1, "right": 0}
    ])[0] == "anchors[1].right"


def test_anchors_crossing_reported_once_at_first_offending_anchor():
    # Strictly increasing left but decreasing right = crossing.
    path, msg = anchors_error([
        {"left": 0, "right": 2}, {"left": 1, "right": 1}
    ])
    assert path == "anchors[1].right"
    assert "交叉" in msg
    # Decreasing left = crossing, reported on .left.
    assert anchors_error([
        {"left": 2, "right": 0}, {"left": 1, "right": 1}
    ])[0] == "anchors[1].left"
    # Three valid then one crossing: only the first crossing is reported.
    path, _ = anchors_error([
        {"left": 0, "right": 0},
        {"left": 1, "right": 1},
        {"left": 2, "right": 2},
        {"left": 3, "right": 1},
    ], m=5, n=5)
    assert path == "anchors[3].right"


def test_anchors_unsorted_input_still_flags_first_error():
    # The client normally sends anchors in selection order; an out-of-order
    # (crossing) pair is a crossing error regardless of whether an earlier-sent
    # index would be fine. The FIRST definite error is what we report.
    path, _ = anchors_error([{"left": 2, "right": 2}, {"left": 1, "right": 1}])
    assert path in ("anchors[1].left", "anchors[1].right")


def test_anchors_big_indices_boundary():
    assert validate_anchors([{"left": 199, "right": 199}], 200, 200) == (None, None)
    assert anchors_error([{"left": 200, "right": 199}], m=200, n=200)[0] == (
        "anchors[0].left"
    )
