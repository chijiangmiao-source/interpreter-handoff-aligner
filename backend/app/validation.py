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


def validate_anchors(
    anchors: Any, m: int, n: int
) -> tuple[str | None, str | None]:
    """Validate the optional ``anchors`` array against two valid sequences.

    ``m`` and ``n`` are the lengths of the already-validated left and right
    arrays.  Each anchor must be an object containing only integer ``left``
    and ``right`` 0-based record indices.  Indices must exist (in range), no
    index may be reused, and successive anchors must grow on BOTH sides (so the
    forced matches never cross).

    Returns ``(error_path, error_message)``; on success both are ``None``.
    Exactly one failure is ever produced: anchors are examined in the order
    the client sent them, and the first definite error wins.  The returned
    path points at the offending anchor entry (e.g. ``anchors[1].left`` or
    ``anchors[2]``).
    """
    if not isinstance(anchors, list):
        return "anchors", "anchors 必须是数组。"

    seen_left: set[int] = set()
    seen_right: set[int] = set()
    prev_left: int | None = None
    prev_right: int | None = None

    for k, anchor in enumerate(anchors):
        base = f"anchors[{k}]"

        if not isinstance(anchor, dict):
            return base, f"{base} 必须是包含 left 与 right 索引的对象。"

        # Reject unknown keys up front so a typo is not silently ignored.
        extra = [key for key in anchor if key not in ("left", "right")]
        if extra:
            return f"{base}.{extra[0]}", f"{base}.{extra[0]} 是多余字段。"

        for side, length, seen in (
            ("left", m, seen_left),
            ("right", n, seen_right),
        ):
            if side not in anchor:
                return f"{base}.{side}", f"{base} 缺少整数记录索引 {side}。"
            value = anchor[side]
            if not _is_plain_int(value):
                return f"{base}.{side}", f"{base}.{side} 必须是非负整数记录索引。"
            if value < 0 or value >= length:
                range_text = f"，合法范围 0..{length - 1}" if length else "，该侧没有任何记录"
                return (
                    f"{base}.{side}",
                    f"{base}.{side} 索引 {value} 越界"
                    f"（{side} 共 {length} 项{range_text}）。",
                )
            if value in seen:
                return (
                    f"{base}.{side}",
                    f"{base}.{side} 索引 {value} 已被其他锚点配对，不可复用。",
                )

        li, ri = anchor["left"], anchor["right"]

        # Monotonic on both sides. Equalities were already returned as reuse
        # errors above, so a non-greater value here is a strict decrease, i.e.
        # the new anchor crosses (or runs backward against) the previous one.
        if prev_left is not None and prev_right is not None and (
            li < prev_left or ri < prev_right
        ):
            offender = "left" if li < prev_left else "right"
            return (
                f"{base}.{offender}",
                f"{base} 与锚点顺序交叉：({li}, {ri}) 未同时晚于上一锚点 "
                f"({prev_left}, {prev_right})，左右索引都必须严格递增。",
            )

        seen_left.add(li)
        seen_right.add(ri)
        prev_left, prev_right = li, ri

    return None, None


def validate_term_pairs(term_pairs: Any) -> tuple[str | None, str | None]:
    """Validate the optional ``term_pairs`` array of text correspondences.

    Each entry must be an object containing only a non-empty string
    ``left_text`` and a non-empty string ``right_text``.  A term may be
    mapped at most once on each side: the second entry reusing an already
    mapped left_text (or right_text) is a conflict.  Exactly one failure is
    produced — term pairs are examined in submission order and the first
    conflict wins, with its path, e.g. ``term_pairs[1].right_text``.

    Returns ``(error_path, error_message)``; on success both are ``None``.
    """
    if not isinstance(term_pairs, list):
        return "term_pairs", "term_pairs 必须是数组。"

    seen_left: set[str] = set()
    seen_right: set[str] = set()

    for k, pair in enumerate(term_pairs):
        base = f"term_pairs[{k}]"

        if not isinstance(pair, dict):
            return base, f"{base} 必须是包含 left_text 与 right_text 的对象。"

        # Reject unknown keys up front so a typo is not silently ignored.
        extra = [
            key for key in pair if key not in ("left_text", "right_text")
        ]
        if extra:
            return f"{base}.{extra[0]}", f"{base}.{extra[0]} 是多余字段。"

        for field, seen in (
            ("left_text", seen_left),
            ("right_text", seen_right),
        ):
            if field not in pair:
                return f"{base}.{field}", f"{base} 缺少非空字符串字段 {field}。"
            value = pair[field]
            if not isinstance(value, str):
                return f"{base}.{field}", f"{base}.{field} 必须是非空字符串。"
            if len(value) == 0:
                return f"{base}.{field}", f"{base}.{field} 不可为空字符串。"
            if value in seen:
                return (
                    f"{base}.{field}",
                    f"{base}.{field} 「{value}」已映射过，同一侧术语不可重复对应。",
                )

        seen_left.add(pair["left_text"])
        seen_right.add(pair["right_text"])

    return None, None
