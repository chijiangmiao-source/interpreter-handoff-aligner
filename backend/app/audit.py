"""Verification of an externally adjusted candidate timeline.

External collaborators sometimes hand-align the timeline by hand.  Before the
lead accepts such a result every ORIGINAL note must still be present COMPLETE,
IN ORDER and used EXACTLY ONCE, and the adjusted costs must recompute under the
current rules (time difference, the 3000 mismatch penalty, the 2000 gap cost,
anchor pinning and exact term-pair synonyms).

``audit`` replays the candidate row by row against the same two validated note
sequences used by ``POST /api/align`` and reports the FIRST definite semantic
difference only: the step path (e.g. ``candidate.steps[2].cost``), the expected
value and the actual value.  Structural errors (wrong shape/types) are handled
beforehand by :func:`validate_candidate` and keep using the ordinary single
-error envelope.

The audit never re-runs the DP and never decides whether the candidate is
optimal: it only verifies that the candidate is a well-formed, conservative
realignment whose costs follow the current rules.
"""

from __future__ import annotations

from typing import Any

from .alignment import (
    ACTION_LEFT_GAP,
    ACTION_MATCH,
    ACTION_RIGHT_GAP,
    GAP_COST,
    MISMATCH_PENALTY,
    ORIGIN_ANCHOR,
    ORIGIN_AUTO,
    TermSynonyms,
    hit_term_pair,
    match_cost,
)

ACTIONS = (ACTION_MATCH, ACTION_LEFT_GAP, ACTION_RIGHT_GAP)

CANDIDATE_ROOT = "candidate"
STEPS_PREFIX = "candidate.steps"

# Keys every candidate row may carry (no others — a typo must not be ignored).
_STEP_KEYS = {
    "action",
    "left",
    "right",
    "cost",
    "cumulative_cost",
    "origin",
    "term_pair",
}


def _is_plain_int(value: Any) -> bool:
    # bool is a subclass of int in Python; JSON true/false are not costs.
    return isinstance(value, int) and not isinstance(value, bool)


def _step_path(k: int, field: str | None = None) -> str:
    base = f"{STEPS_PREFIX}[{k}]"
    return f"{base}.{field}" if field else base


def _validate_note_slot(
    value: Any, path: str
) -> tuple[str | None, str | None] | None:
    """Validate one side slot: null or a single ``{time, text}`` note.

    Returns ``(error_path, error_message)`` or None.  ``path`` is the full
    slot path (e.g. ``candidate.steps[0].left``); sub-field failures extend it.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        return path, f"{path} 必须是 null 或仅含 time 与 text 的笔记对象。"

    extra = [key for key in value if key not in ("time", "text")]
    if extra:
        return f"{path}.{extra[0]}", f"{path}.{extra[0]} 是多余字段，笔记仅允许 time 与 text。"
    if "time" not in value:
        return f"{path}.time", f"{path} 缺少整数字段 time。"
    if not _is_plain_int(value["time"]):
        return f"{path}.time", f"{path}.time 必须是整数毫秒时间戳。"
    if "text" not in value:
        return f"{path}.text", f"{path} 缺少非空字符串字段 text。"
    if not isinstance(value["text"], str) or len(value["text"]) == 0:
        return f"{path}.text", f"{path}.text 必须是非空字符串。"
    return None


def validate_candidate(candidate: Any) -> tuple[str | None, str | None]:
    """Structural validation of the ``candidate`` object.

    The candidate must be an object carrying a ``steps`` array and an integer
    ``total_cost``; every step must be an object with a known ``action``, the
    right ``left``/``right`` slots (null or a note), non-negative integer
    ``cost`` and ``cumulative_cost``, and (when present) only valid
    ``origin``/``term_pair`` provenance.  Exactly one failure is produced — the
    first definite one in document order — with a path such as
    ``candidate.steps[2].cost``.

    Returns ``(error_path, error_message)``; on success both are ``None``.
    """
    if not isinstance(candidate, dict):
        return CANDIDATE_ROOT, "candidate 必须是包含 steps 与 total_cost 的对象。"

    if "steps" not in candidate:
        return f"{CANDIDATE_ROOT}.steps", "candidate 缺少 steps 数组。"
    if not isinstance(candidate["steps"], list):
        return f"{CANDIDATE_ROOT}.steps", "candidate.steps 必须是数组。"

    for k, step in enumerate(candidate["steps"]):
        base = _step_path(k)
        if not isinstance(step, dict):
            return base, f"{base} 必须是表示一行对齐步骤的对象。"

        extra = [key for key in step if key not in _STEP_KEYS]
        if extra:
            return f"{base}.{extra[0]}", f"{base}.{extra[0]} 是多余字段。"

        if "action" not in step:
            return f"{base}.action", f"{base} 缺少动作字段 action。"
        if not isinstance(step["action"], str) or step["action"] not in ACTIONS:
            return (
                f"{base}.action",
                f"{base}.action 必须是 match、left_gap 或 right_gap 之一。",
            )

        # Both side slots must be present explicitly; a blank side is null,
        # never a missing key.
        for side in ("left", "right"):
            slot_path = f"{base}.{side}"
            if side not in step:
                return slot_path, f"{base} 缺少 {side} 字段（留空必须显式写 null）。"
            bad = _validate_note_slot(step[side], slot_path)
            if bad is not None:
                return bad

        for field in ("cost", "cumulative_cost"):
            if field not in step:
                return f"{base}.{field}", f"{base} 缺少整数字段 {field}。"
            if not _is_plain_int(step[field]):
                return f"{base}.{field}", f"{base}.{field} 必须是非负整数。"
            if step[field] < 0:
                return f"{base}.{field}", f"{base}.{field} 不可为负数。"

        if "origin" in step and step["origin"] not in (ORIGIN_ANCHOR, ORIGIN_AUTO):
            return f"{base}.origin", f"{base}.origin 必须是 anchor 或 auto。"

        if "term_pair" in step and step["term_pair"] is not None:
            tp = step["term_pair"]
            tp_path = f"{base}.term_pair"
            if not isinstance(tp, dict):
                return tp_path, f"{tp_path} 必须是 null 或术语对对象。"
            tp_extra = [
                key for key in tp if key not in ("left_text", "right_text")
            ]
            if tp_extra:
                return (
                    f"{tp_path}.{tp_extra[0]}",
                    f"{tp_path}.{tp_extra[0]} 是多余字段。",
                )
            for field in ("left_text", "right_text"):
                if field not in tp:
                    return f"{tp_path}.{field}", f"{tp_path} 缺少非空字符串字段 {field}。"
                if not isinstance(tp[field], str) or len(tp[field]) == 0:
                    return f"{tp_path}.{field}", f"{tp_path}.{field} 必须是非空字符串。"

    if "total_cost" not in candidate:
        return f"{CANDIDATE_ROOT}.total_cost", "candidate 缺少整数字段 total_cost。"
    if not _is_plain_int(candidate["total_cost"]):
        return f"{CANDIDATE_ROOT}.total_cost", "candidate.total_cost 必须是非负整数。"
    if candidate["total_cost"] < 0:
        return f"{CANDIDATE_ROOT}.total_cost", "candidate.total_cost 不可为负数。"

    return None, None


def _semantic_failure(
    path: str, message: str, expected: Any, actual: Any
) -> dict[str, Any]:
    """The single semantic-difference envelope for one audited candidate."""
    return {
        "ok": False,
        "error": message,
        "path": path,
        "expected": expected,
        "actual": actual,
    }


def _note_index(note: dict[str, Any], seq: list[dict[str, Any]]) -> int | None:
    """Index of a content-identical note in a validated sequence, else None."""
    for idx, original in enumerate(seq):
        if original == note:
            return idx
    return None


def audit(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    anchor_pairs: list[tuple[int, int]] | None,
    term_pairs: list[tuple[str, str]] | None,
    candidate: dict[str, Any],
) -> dict[str, Any]:
    """Replay a structurally valid candidate under the current cost rules.

    On success returns ``{"ok": True, "total_cost": int, "steps": [details]}``
    where every detail carries the expected/actual single-step and cumulative
    costs plus the rule it was recomputed from.  The first semantic difference
    returns ``{"ok": False, "error", "path", "expected", "actual"}``.

    Semantic checks run in replay order, so the first reported difference is
    the first row the lead must fix:

    1. action/blank-side consistency;
    2. conservation of the original notes — complete, in sequence order, each
       used exactly once (unknown content, a repeated or a missing index);
    3. anchor pinning (forced rows at exactly the submitted indices);
    4. the exact term-pair hit and its single-step cost;
    5. the cumulative cost per row;
    and after every row, 6. the total cost.
    """
    m, n = len(left), len(right)
    anchors = list(anchor_pairs or [])
    terms = TermSynonyms(list(term_pairs or [])) if term_pairs else None
    anchor_set: set[tuple[int, int]] = set(anchors)
    anchored = bool(anchors)

    steps: list[dict[str, Any]] = candidate["steps"]
    li = ri = 0  # next unconsumed index on each side
    cumulative = 0
    used_left: set[int] = set()
    used_right: set[int] = set()
    details: list[dict[str, Any]] = []
    counts = {ACTION_MATCH: 0, ACTION_LEFT_GAP: 0, ACTION_RIGHT_GAP: 0}

    for k, step in enumerate(steps):
        base = _step_path(k)
        action = step["action"]
        has_left = step["left"] is not None
        has_right = step["right"] is not None

        # --- 1. action matches which side is blank -------------------------
        if action == ACTION_MATCH and not (has_left and has_right):
            return _semantic_failure(
                f"{base}.action",
                "match 行必须左右各携带一条笔记，不允许任一侧留空。",
                {"left": "note", "right": "note"},
                {
                    "left": "note" if has_left else None,
                    "right": "note" if has_right else None,
                },
            )
        if action == ACTION_LEFT_GAP and not (not has_left and has_right):
            offending = "left" if has_left else "right"
            return _semantic_failure(
                f"{base}.{offending}",
                "left_gap 行必须左侧留空（left 为 null）且仅携带一条右侧笔记。",
                {"left": None, "right": "note"},
                {
                    "left": "note" if has_left else None,
                    "right": "note" if has_right else None,
                },
            )
        if action == ACTION_RIGHT_GAP and not (has_left and not has_right):
            offending = "right" if has_right else "left"
            return _semantic_failure(
                f"{base}.{offending}",
                "right_gap 行必须右侧留空（right 为 null）且仅携带一条左侧笔记。",
                {"left": "note", "right": None},
                {
                    "left": "note" if has_left else None,
                    "right": "note" if has_right else None,
                },
            )

        # --- 2. conservation: the exact next original note, in order --------
        used_left_idx: int | None = None
        used_right_idx: int | None = None
        if has_left:
            idx = _note_index(step["left"], left)
            if idx is None:
                expected_note = (
                    {"time": left[li]["time"], "text": left[li]["text"]}
                    if li < m
                    else None
                )
                return _semantic_failure(
                    f"{base}.left",
                    "该行左侧笔记不属于原始左侧输入（内容被改写或来自他处）。",
                    expected_note,
                    step["left"],
                )
            if idx in used_left:
                return _semantic_failure(
                    f"{base}.left",
                    f"原始左侧笔记 left[{idx}] 在候选时间轴中被重复使用，"
                    "每条原始笔记只允许使用一次。",
                    f"left[{li}]（按顺序下一条未使用笔记）",
                    f"left[{idx}]（重复）",
                )
            if idx != li:
                return _semantic_failure(
                    f"{base}.left",
                    f"左侧笔记顺序被打乱或存在遗漏：按顺序此处应为 left[{li}]，"
                    f"候选却使用 left[{idx}]。",
                    f"left[{li}]",
                    f"left[{idx}]",
                )
            used_left_idx = idx
        if has_right:
            idx = _note_index(step["right"], right)
            if idx is None:
                expected_note = (
                    {"time": right[ri]["time"], "text": right[ri]["text"]}
                    if ri < n
                    else None
                )
                return _semantic_failure(
                    f"{base}.right",
                    "该行右侧笔记不属于原始右侧输入（内容被改写或来自他处）。",
                    expected_note,
                    step["right"],
                )
            if idx in used_right:
                return _semantic_failure(
                    f"{base}.right",
                    f"原始右侧笔记 right[{idx}] 在候选时间轴中被重复使用，"
                    "每条原始笔记只允许使用一次。",
                    f"right[{ri}]（按顺序下一条未使用笔记）",
                    f"right[{idx}]（重复）",
                )
            if idx != ri:
                return _semantic_failure(
                    f"{base}.right",
                    f"右侧笔记顺序被打乱或存在遗漏：按顺序此处应为 right[{ri}]，"
                    f"候选却使用 right[{idx}]。",
                    f"right[{ri}]",
                    f"right[{idx}]",
                )
            used_right_idx = idx

        # --- 3. anchor pinning ----------------------------------------------
        actual_origin = step.get("origin")
        if anchored and action == ACTION_MATCH:
            assert used_left_idx is not None and used_right_idx is not None
            is_anchor_row = (used_left_idx, used_right_idx) in anchor_set
            expected_origin = ORIGIN_ANCHOR if is_anchor_row else ORIGIN_AUTO
            if actual_origin != expected_origin:
                if is_anchor_row:
                    message = (
                        f"left[{used_left_idx}] ↔ right[{used_right_idx}] "
                        "是人工锚点，该行必须固定入列并标记 origin=anchor。"
                    )
                else:
                    message = (
                        f"left[{used_left_idx}] ↔ right[{used_right_idx}] "
                        "不在锚点列表中，只有人工锚点配对行可标记 origin=anchor。"
                    )
                return _semantic_failure(
                    f"{base}.origin", message, expected_origin, actual_origin
                )
            if is_anchor_row:
                anchor_set.discard((used_left_idx, used_right_idx))
        elif actual_origin == ORIGIN_ANCHOR:
            # Without anchors in the request no row may claim the pinning,
            # and a blank-side row can never be a forced anchor match.
            return _semantic_failure(
                f"{base}.origin",
                "本次核验没有提供人工锚点，任何行都不能标记 origin=anchor。"
                if not anchored
                else "留空行不可能是人工锚点，origin 必须为 auto。",
                ORIGIN_AUTO if anchored else None,
                actual_origin,
            )

        # --- 4. recompute the single-step cost under the current rules ------
        if action == ACTION_MATCH:
            assert used_left_idx is not None and used_right_idx is not None
            l_note = left[used_left_idx]
            r_note = right[used_right_idx]
            expected_cost = match_cost(l_note, r_note, terms)
            hit = hit_term_pair(l_note, r_note, terms)
            expected_term_pair = (
                {"left_text": hit[0], "right_text": hit[1]}
                if hit is not None
                else None
            )
            time_diff = abs(l_note["time"] - r_note["time"])
            same_text = l_note["text"] == r_note["text"]
            if hit is not None:
                basis = (
                    f"术语等价「{hit[0]} ≡ {hit[1]}」：|{l_note['time']} − "
                    f"{r_note['time']}| = {time_diff}"
                    + ("" if same_text else "（免除 3000）")
                )
            elif same_text:
                basis = (
                    f"相同文本：|{l_note['time']} − {r_note['time']}| = {expected_cost}"
                )
            else:
                basis = (
                    f"不同文本：|{l_note['time']} − {r_note['time']}| + "
                    f"{MISMATCH_PENALTY} = {time_diff} + {MISMATCH_PENALTY} "
                    f"= {expected_cost}"
                )
        else:
            expected_cost = GAP_COST
            expected_term_pair = None
            basis = "单侧留空 = 2000"

        if step["cost"] != expected_cost:
            return _semantic_failure(
                f"{base}.cost",
                "单步代价与按当前规则复算的结果不一致。",
                expected_cost,
                step["cost"],
            )

        actual_term_pair = step.get("term_pair")
        if actual_term_pair != expected_term_pair:
            return _semantic_failure(
                f"{base}.term_pair",
                "术语命中标记与按当前术语对复算的结果不一致。",
                expected_term_pair,
                actual_term_pair,
            )

        # --- 5. cumulative cost ---------------------------------------------
        cumulative += expected_cost
        if step["cumulative_cost"] != cumulative:
            return _semantic_failure(
                f"{base}.cumulative_cost",
                "累计代价与逐行累加的结果不一致。",
                cumulative,
                step["cumulative_cost"],
            )

        counts[action] += 1
        details.append(
            {
                "index": k,
                "action": action,
                "expected_cost": expected_cost,
                "actual_cost": step["cost"],
                "expected_cumulative_cost": cumulative,
                "actual_cumulative_cost": step["cumulative_cost"],
                "consumed": {"left": used_left_idx, "right": used_right_idx},
                "origin": actual_origin,
                "expected_term_pair": expected_term_pair,
                "basis": basis,
            }
        )

        if has_left:
            used_left.add(li)
            li += 1
        if has_right:
            used_right.add(ri)
            ri += 1

    # Every submitted anchor must have appeared as a forced row.
    if anchor_set:
        ai, aj = next(iter(anchor_set))
        return _semantic_failure(
            _step_path(len(steps)),
            f"人工锚点 left[{ai}] ↔ right[{aj}] 未在候选时间轴中固定入列。",
            f"match(left[{ai}], right[{aj}])",
            None,
        )

    # --- 2b. conservation at the end: no original note may remain unused ----
    if li != m:
        return _semantic_failure(
            _step_path(len(steps)),
            f"原始左侧笔记 left[{li}] 未出现在候选时间轴中（原始笔记遗漏）。",
            {"time": left[li]["time"], "text": left[li]["text"]},
            None,
        )
    if ri != n:
        return _semantic_failure(
            _step_path(len(steps)),
            f"原始右侧笔记 right[{ri}] 未出现在候选时间轴中（原始笔记遗漏）。",
            {"time": right[ri]["time"], "text": right[ri]["text"]},
            None,
        )

    # --- 6. total cost ------------------------------------------------------
    if candidate["total_cost"] != cumulative:
        return _semantic_failure(
            f"{CANDIDATE_ROOT}.total_cost",
            "候选总代价与逐行复算的累计结果不一致。",
            cumulative,
            candidate["total_cost"],
        )

    return {
        "ok": True,
        "total_cost": cumulative,
        "counts": counts,
        "consumed": {"left": m, "right": n},
        "anchors": [{"left": a, "right": b} for a, b in anchors],
        "steps": details,
    }
