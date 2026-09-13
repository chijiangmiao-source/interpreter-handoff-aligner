"""FastAPI application for interpreter handoff alignment.

Two business endpoints share exactly the same input contract:

* ``POST /api/align`` runs the DP and returns the unique optimal timeline;
* ``POST /api/audit`` verifies an externally hand-adjusted candidate timeline
  against the same two note sequences (plus the same anchors and term pairs),
  replaying every row under the current cost rules.

The shared request body is::

    {"left": [{"time": int, "text": str}, ...],
     "right": [{"time": int, "text": str}, ...],
     "anchors": [{"left": int, "right": int}, ...],     # optional
     "term_pairs": [{"left_text": str, "right_text": str}, ...],  # optional
     "compare_alternative": bool,                        # align only, optional
     "candidate": {"steps": [...], "total_cost": int}}   # audit only

``anchors`` is optional.  When present, each entry pins a human-confirmed
pair of 0-based record indices; the service re-runs the same DP on the
intervals the anchors cut out.  Bad anchors (out of range, reused index,
crossing/non-monotonic order) fail exactly once with a path such as
``anchors[1].left``.  Requests without ``anchors`` keep their historical
behaviour and response shape exactly.

``term_pairs`` is an optional list of lead-confirmed term correspondences.
Only an exact (verbatim) hit of a declared pair waives the mismatch penalty
for a pairing; the time difference, gap costs, anchor constraints, tie rules
and alternative ranking are unchanged.  A term may be mapped once per side;
the first conflicting entry fails exactly once with a path such as
``term_pairs[1].right_text``.  Absent or empty, request computation and the
response shape stay byte-for-byte identical to before.

``compare_alternative`` (align only) is an optional boolean (absent/false by
default).  When true the response additionally carries an ``alternative``
object with the strictly second-best complete path, its total cost, the cost
gap and the note indices of the first divergence; a unique legal path yields
``"alternative": null``.  The flag never affects the optimum: with it absent
or false the request and response stay byte-for-byte identical to before.

For ``/api/audit`` a structurally malformed candidate keeps the ordinary
single-error 4xx envelope (``{"error", "path"}``); a well-formed candidate
that disagrees with the inputs or the cost rules fails semantically with the
path of the first differing step and both values:
``{"error", "path", "expected", "actual"}``.

Malformed JSON and every structural/semantic violation (wrong type, too many
items, missing/empty field, duplicate or non-increasing time, unknown field)
produce exactly ONE 4xx failure carrying the first error path, e.g.
``{"error": "...", "path": "left[2].time"}``.  Pydantic's bulk error lists are
deliberately bypassed so the caller can mark a single location.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .alignment import align
from .audit import audit as run_audit
from .audit import validate_candidate
from .validation import (
    MAX_ITEMS,
    validate_anchors,
    validate_sequence,
    validate_term_pairs,
)

app = FastAPI(title="Interpreter Handoff Aligner", version="1.0.0")

# Direct browser -> API calls (Vite dev server) are allowed; in Docker the
# frontend nginx proxies /api to this service same-origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _failure(status: int, message: str, path: str = "") -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": message, "path": path},
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _parse_body(raw: bytes) -> tuple[Any | None, JSONResponse | None]:
    """Parse the request body as JSON, or hand back the single 400 failure."""
    try:
        return json.loads(raw), None
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None, _failure(400, "请求体不是合法的 JSON。")


def _prepare_alignment_inputs(
    payload: Any,
) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    """Validate the inputs shared by /api/align and /api/audit.

    Returns ``(prepared, None)`` on success, where ``prepared`` carries the
    validated sequences, anchor pairs and term pairs; otherwise
    ``(None, failure_response)`` carrying exactly the first error.  The check
    order is fixed: left, right, anchors, term_pairs.
    """
    if not isinstance(payload, dict):
        return None, _failure(422, "请求根节点必须是包含 left 与 right 的对象。")

    for side in ("left", "right"):
        if side not in payload:
            return None, _failure(422, f"缺少 {side} 数组。", side)

    # Validate the two sequences independently; left is examined first, so a
    # failure there is reported before any right-side problem.
    for side in ("left", "right"):
        bad_path = validate_sequence(payload[side], side)
        if bad_path is not None:
            return None, _failure(422, _describe(payload[side], bad_path, side), bad_path)

    # Optional anchors are only consulted once both sequences are valid, since
    # index bounds depend on their lengths.  Absent anchors keep the legacy
    # request/response contract exactly; an explicitly present (even empty)
    # array switches on anchor provenance.
    anchors_given = "anchors" in payload
    anchor_pairs: list[tuple[int, int]] = []
    if anchors_given:
        anchors_raw = payload["anchors"]
        bad_path, bad_message = validate_anchors(
            anchors_raw, len(payload["left"]), len(payload["right"])
        )
        if bad_path is not None:
            return None, _failure(422, bad_message, bad_path)
        anchor_pairs = [(a["left"], a["right"]) for a in anchors_raw]

    # Optional lead-declared term correspondences.  Like anchors they are
    # examined only after the two sequences pass; absent or an explicitly
    # empty list keeps the legacy computation and response exactly.
    terms_given = "term_pairs" in payload
    term_pairs_raw: list[dict[str, Any]] = []
    if terms_given:
        bad_path, bad_message = validate_term_pairs(payload["term_pairs"])
        if bad_path is not None:
            return None, _failure(422, bad_message, bad_path)
        term_pairs_raw = payload["term_pairs"]

    return (
        {
            "left": payload["left"],
            "right": payload["right"],
            "anchors_given": anchors_given,
            "anchor_pairs": anchor_pairs,
            "terms_given": terms_given,
            "term_pairs": [(p["left_text"], p["right_text"]) for p in term_pairs_raw],
        },
        None,
    )


@app.post("/api/align")
async def align_notes(request: Request) -> JSONResponse:
    raw = await request.body()
    payload, bad = _parse_body(raw)
    if bad is not None:
        return bad

    prepared, bad = _prepare_alignment_inputs(payload)
    if bad is not None:
        return bad

    # Optional switch for the strictly second-best complete path.  It is
    # examined only after the notes/anchors/term pairs pass (fixed check
    # order) and must be a plain JSON boolean; absent or false it changes
    # nothing at all.
    compare_alternative = False
    if "compare_alternative" in payload:
        flag = payload["compare_alternative"]
        if not isinstance(flag, bool):
            return _failure(
                422,
                "compare_alternative 必须是布尔值 true 或 false。",
                "compare_alternative",
            )
        compare_alternative = flag

    result = align(
        prepared["left"],
        prepared["right"],
        anchors=prepared["anchor_pairs"] if prepared["anchors_given"] else None,
        compare_alternative=compare_alternative,
        term_pairs=prepared["term_pairs"] if prepared["terms_given"] else None,
    )
    return JSONResponse(result)


@app.post("/api/audit")
async def audit_candidate(request: Request) -> JSONResponse:
    raw = await request.body()
    payload, bad = _parse_body(raw)
    if bad is not None:
        return bad

    prepared, bad = _prepare_alignment_inputs(payload)
    if bad is not None:
        return bad

    # The candidate is examined last: the notes/anchors/term pairs it is
    # verified against must themselves be valid first.
    if "candidate" not in payload:
        return _failure(422, "缺少 candidate 对象（须包含 steps 与 total_cost）。", "candidate")

    bad_path, bad_message = validate_candidate(payload["candidate"])
    if bad_path is not None:
        return _failure(422, bad_message, bad_path)

    outcome = run_audit(
        prepared["left"],
        prepared["right"],
        prepared["anchor_pairs"] if prepared["anchors_given"] else None,
        prepared["term_pairs"] if prepared["terms_given"] else None,
        payload["candidate"],
    )
    if not outcome.get("ok"):
        # First definite semantic difference: the step path plus the value the
        # current rules expect and the value the candidate actually carries.
        return JSONResponse(
            status_code=422,
            content={
                "error": outcome["error"],
                "path": outcome["path"],
                "expected": outcome["expected"],
                "actual": outcome["actual"],
            },
        )
    return JSONResponse(outcome)


def _describe(seq: Any, path: str, side: str) -> str:
    """Turn the first error path into one clear Chinese message."""
    if path == side and not isinstance(seq, list):
        return f"{side} 必须是数组。"

    if path == f"{side}[{MAX_ITEMS}]":
        return f"{side} 最多包含 {MAX_ITEMS} 项。"

    # Parse `side[index][.field]`.
    rest = path[len(side) + 1 :]
    idx_str, _, field = rest.partition("].")
    idx = int(idx_str)

    if "." not in rest:  # the item itself is not an object
        return f"{path} 必须是包含 time 与 text 的对象。"

    item = seq[idx]
    if field == "time":
        value = item.get("time")
        if "time" not in item:
            return f"{path} 缺少整数字段 time。"
        if isinstance(value, bool) or not isinstance(value, int):
            return f"{path} 必须是整数毫秒时间戳。"
        # Non-increasing: locate the previous time for a helpful message.
        if idx > 0 and isinstance(seq[idx - 1], dict) and isinstance(
            seq[idx - 1].get("time"), int
        ):
            return (
                f"{path} 为 {value}，未严格递增（上一项时间为 "
                f"{seq[idx - 1]['time']}）。"
            )
        return f"{path} 必须严格递增且不可重复。"

    if field == "text":
        if "text" not in item:
            return f"{path} 缺少非空字符串字段 text。"
        return f"{path} 必须是非空字符串。"

    return f"{path} 是多余字段，每项仅允许 time 与 text。"
