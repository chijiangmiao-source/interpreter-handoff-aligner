"""Sequence validation for the handoff alignment API.

Each interpreter note is an object of the form ``{"time": <int ms>, "text": <str>}``.
The rules enforced here, in check order, are:

1. the payload must be an array (objects are not silently accepted);
2. the array contains at most ``MAX_ITEMS`` entries;
3. every entry is a JSON object;
4. every object contains an integer ``time`` (booleans and floats are rejected)
   and a non-empty ``text`` string, and no other keys (each item contains
   only ``time`` and ``text``);
5. ``time`` values are strictly increasing (duplicates and decreases fail).

``first_error_path`` is a JSON-Pointer-ish path of the *first* failure only,
e.g. ``left[2].time``, so the UI can mark exactly one place and the user fixes
errors one at a time without being flooded.
"""

from __future__ import annotations

from typing import Any

MAX_ITEMS = 200


def _is_plain_int(value: Any) -> bool:
    # bool is a subclass of int in Python; JSON true/false are not timestamps.
    return isinstance(value, int) and not isinstance(value, bool)


def validate_sequence(seq: Any, side: str) -> str | None:
    """Return the first error path, or None when the sequence is valid."""
    prefix = side

    if not isinstance(seq, list):
        return prefix

    if len(seq) > MAX_ITEMS:
        return f"{prefix}[{MAX_ITEMS}]"

    prev_time: int | None = None
    for i, item in enumerate(seq):
        item_path = f"{prefix}[{i}]"
        if not isinstance(item, dict):
            return item_path

        if "time" not in item:
            return f"{item_path}.time"
        time_value = item["time"]
        if not _is_plain_int(time_value):
            return f"{item_path}.time"

        if "text" not in item:
            return f"{item_path}.text"
        text_value = item["text"]
        if not isinstance(text_value, str) or len(text_value) == 0:
            return f"{item_path}.text"

        extra_keys = [k for k in item if k not in ("time", "text")]
        if extra_keys:
            return f"{item_path}.{extra_keys[0]}"

        if prev_time is not None and time_value <= prev_time:
            return f"{item_path}.time"
        prev_time = time_value

    return None
