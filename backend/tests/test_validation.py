"""Tests for structural validation and the single-error contract."""

from app.validation import MAX_ITEMS, validate_sequence


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
