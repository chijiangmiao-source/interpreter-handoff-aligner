#!/usr/bin/env python3
"""One-off acceptance check for the deployed Compose stack.

Runs against the LIVE containers (no mocks):

  * API health endpoint;
  * web container serves the built SPA and proxies /api to the API container;
  * a golden handoff alignment with exact steps, costs and tie-break order;
  * every cost rule (same-text |time diff|, mismatch +3000, gap 2000);
  * the single-failure contract for duplicates, over-limit and bad shapes.

Uses only the Python standard library so it can run in the slim API image.
Exit code is 0 only when every check passes.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API_URL = os.environ.get("API_URL", "http://api:8000")
WEB_URL = os.environ.get("WEB_URL", "http://web:80")

failures: list[str] = []
checks = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def http(method: str, url: str, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def get(url: str) -> tuple[int, str]:
    with urllib.request.urlopen(url, timeout=10) as resp:
        return resp.status, resp.read().decode()


GAP = 2000
MISMATCH = 3000


def _pair_cost(a: dict, b: dict) -> int:
    return abs(a["time"] - b["time"]) + (0 if a["text"] == b["text"] else MISMATCH)


def _free_segment_cost(li: list, ri: list) -> int:
    """Independent optimum for two sub-sequences (plain stdlib DP)."""
    m, n = len(li), len(ri)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        dp[i][0] = dp[i - 1][0] + GAP
    for j in range(1, n + 1):
        dp[0][j] = dp[0][j - 1] + GAP
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            dp[i][j] = min(
                dp[i - 1][j - 1] + _pair_cost(li[i - 1], ri[j - 1]),
                dp[i][j - 1] + GAP,
                dp[i - 1][j] + GAP,
            )
    return dp[m][n]


def expected_anchored_cost(left, right, anchors) -> int:
    """Constrained optimum: per-interval optimum plus each anchor's cost."""
    bounds = [(-1, -1), *anchors, (len(left), len(right))]
    total = 0
    for (a0, b0), (a1, b1) in zip(bounds, bounds[1:]):
        total += _free_segment_cost(left[a0 + 1 : a1], right[b0 + 1 : b1])
        if a1 < len(left):  # a real forced anchor (not the trailing bound)
            total += _pair_cost(left[a1], right[b1])
    return total


def run_anchor_checks(left, right, free_body) -> None:
    """Acceptance for the four anchor guarantees."""
    base = {"left": left, "right": right}

    # Guarantee 1: a request WITHOUT anchors is byte-shape identical and never
    # carries anchors/provenance.
    status, body = http("POST", f"{API_URL}/api/align", base)
    check(
        "anchors: absent-anchor request keeps the exact free result",
        status == 200 and body == free_body,
        f"body={body}",
    )
    check(
        "anchors: free response has no anchors field and no per-row origin",
        "anchors" not in body
        and all("origin" not in s for s in body["steps"]),
    )
    # An explicitly empty anchors array is the same legacy request.
    status, body_empty = http(
        "POST", f"{API_URL}/api/align", {**base, "anchors": []}
    )
    check(
        "anchors: empty anchors array equals the legacy result",
        status == 200 and body_empty == free_body,
    )

    # Guarantee 2: legal anchors are fixed into the timeline and each interval
    # is independently optimal.
    anchors = [[0, 0], [2, 1]]
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {**base, "anchors": [{"left": a, "right": b} for a, b in anchors]},
    )
    anchor_rows = [s for s in body["steps"] if s.get("origin") == "anchor"]
    auto_rows = [s for s in body["steps"] if s.get("origin") == "auto"]
    check(
        "anchors: legal anchors fixed into the rows as matches",
        status == 200
        and body.get("anchors") == [{"left": 0, "right": 0}, {"left": 2, "right": 1}]
        and len(anchor_rows) == 2
        and all(s["action"] == "match" for s in anchor_rows)
        and anchor_rows[0]["left"] == left[0]
        and anchor_rows[0]["right"] == right[0]
        and anchor_rows[1]["left"] == left[2]
        and anchor_rows[1]["right"] == right[1],
        f"body={body}",
    )
    check(
        "anchors: human rows vs generated rows are clearly distinguished",
        len(auto_rows) == len(body["steps"]) - 2
        and all(s.get("origin") == "auto" for s in auto_rows),
    )
    check(
        "anchors: total equals anchor costs plus per-interval DP optimum",
        body["total_cost"] == expected_anchored_cost(left, right, anchors)
        and sum(s["cost"] for s in body["steps"]) == body["total_cost"],
        f"total={body.get('total_cost')} "
        f"expected={expected_anchored_cost(left, right, anchors)}",
    )

    # Out-of-range and reused indices each fail exactly once.
    status, body = http(
        "POST", f"{API_URL}/api/align",
        {**base, "anchors": [{"left": 99, "right": 0}]},
    )
    check(
        "anchors: out-of-range index fails once at anchors[0].left",
        status == 422
        and set(body) == {"error", "path"}
        and body["path"] == "anchors[0].left",
        f"body={body}",
    )
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            **base,
            "anchors": [
                {"left": 0, "right": 0},
                {"left": 0, "right": 1},
            ],
        },
    )
    check(
        "anchors: reused index fails once at anchors[1].left",
        status == 422 and body["path"] == "anchors[1].left",
        f"body={body}",
    )

    # Guarantee 3: crossing anchors produce a single error on the first
    # offending anchor, never a possibly-valid timeline.
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            **base,
            "anchors": [
                {"left": 0, "right": 0},
                {"left": 2, "right": 2},
                {"left": 1, "right": 1},
            ],
        },
    )
    check(
        "anchors: crossing pair fails once at anchors[2].left, no timeline",
        status == 422
        and set(body) == {"error", "path"}
        and body["path"] == "anchors[2].left"
        and "steps" not in body,
        f"body={body}",
    )

    # Guarantee 4: cancelling the anchors (re-request without them) restores
    # the original free result exactly.
    status, restored = http("POST", f"{API_URL}/api/align", base)
    check(
        "anchors: cancelling anchors restores the original result",
        status == 200 and restored == free_body,
    )


def run_compare_alternative_checks(left, right, free_body) -> None:
    """Acceptance for the strictly second-best ("alternative") path."""
    base = {"left": left, "right": right}

    # Guarantee 1: absent / false flag adds no analysis field at all, and the
    # response is byte/structure identical to the legacy result.
    status, body = http("POST", f"{API_URL}/api/align", {**base})
    check(
        "compare: flag absent keeps the exact legacy response (no alternative)",
        status == 200 and body == free_body and "alternative" not in body,
        f"body={body}",
    )
    status, body_false = http(
        "POST", f"{API_URL}/api/align", {**base, "compare_alternative": False}
    )
    check(
        "compare: compare_alternative=false equals the legacy response",
        status == 200 and body_false == free_body,
    )

    # Guarantee 2: on the golden input an equal-cost runner-up exists (the
    # tail gap order swap) and is selected deterministically by the ties.
    status, body = http(
        "POST", f"{API_URL}/api/align", {**base, "compare_alternative": True}
    )
    check(
        "compare: golden optimum is unchanged while comparing",
        status == 200
        and body["steps"] == free_body["steps"]
        and body["total_cost"] == free_body["total_cost"],
        f"body={body}",
    )
    alt = body.get("alternative")
    check(
        "compare: golden equal-cost alternative (diff 0, first divergence)",
        alt is not None
        and alt["total_cost"] == 4250
        and alt["cost_diff"] == 0
        and alt["first_divergence"] == {"left": None, "right": 2}
        and [s["action"] for s in alt["steps"]]
        == ["match", "match", "left_gap", "right_gap"]
        and sum(s["cost"] for s in alt["steps"]) == alt["total_cost"]
        and [s["cumulative_cost"] for s in alt["steps"]]
        == [150, 250, 2250, 4250],
        f"alt={alt}",
    )

    # Guarantee 3: a strictly costlier runner-up reports the positive gap and
    # the note indices at the first disagreement.
    strict = {
        "left": [
            {"time": 0, "text": "a"},
            {"time": 4000, "text": "b"},
        ],
        "right": [
            {"time": 4000, "text": "a"},
            {"time": 8000, "text": "b"},
        ],
    }
    status, body = http(
        "POST", f"{API_URL}/api/align", {**strict, "compare_alternative": True}
    )
    alt = body.get("alternative")
    check(
        "compare: strict runner-up cost/gap/divergence and deterministic order",
        status == 200
        and body["total_cost"] == 7000
        and alt is not None
        and alt["total_cost"] == 8000
        and alt["cost_diff"] == 1000
        and alt["first_divergence"] == {"left": 0, "right": 0}
        and [s["action"] for s in alt["steps"]] == ["match", "match"],
        f"body={body}",
    )
    _, again = http(
        "POST", f"{API_URL}/api/align", {**strict, "compare_alternative": True}
    )
    check(
        "compare: alternative is selected deterministically",
        again["alternative"] == alt,
    )

    # Guarantee 4: a unique legal path (empty input, or fully pinning anchors)
    # yields null but the optimal result is still returned normally.
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {"left": [], "right": [], "compare_alternative": True},
    )
    check(
        "compare: empty unique path returns null alternative with the result",
        status == 200
        and body["steps"] == []
        and body["total_cost"] == 0
        and body["alternative"] is None,
        f"body={body}",
    )
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [{"time": 1, "text": "a"}],
            "right": [{"time": 2, "text": "a"}],
            "anchors": [{"left": 0, "right": 0}],
            "compare_alternative": True,
        },
    )
    check(
        "compare: fully pinning anchors make the path unique (null)",
        status == 200
        and body["anchors"] == [{"left": 0, "right": 0}]
        and body["alternative"] is None,
        f"body={body}",
    )

    # Guarantee 5: anchors constrain the alternative path as well — the forced
    # anchor row is present identically in both timelines.
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            **base,
            "anchors": [{"left": 0, "right": 0}],
            "compare_alternative": True,
        },
    )
    primary_anchor = [s for s in body["steps"] if s.get("origin") == "anchor"]
    alt_anchor = [
        s for s in body["alternative"]["steps"] if s.get("origin") == "anchor"
    ]
    check(
        "compare: anchors pin the alternative path identically",
        status == 200
        and body["alternative"] is not None
        and alt_anchor == primary_anchor
        and len(alt_anchor) == 1
        and all(
            s.get("origin") == "auto"
            for s in body["alternative"]["steps"]
            if s.get("origin") != "anchor"
        ),
        f"body={body}",
    )

    # The flag must be a plain boolean; the single-failure contract holds.
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {"left": [], "right": [], "compare_alternative": "yes"},
    )
    check(
        "compare: non-boolean flag fails once at compare_alternative",
        status == 422
        and set(body) == {"error", "path"}
        and body["path"] == "compare_alternative",
        f"body={body}",
    )


def run_term_pair_checks() -> None:
    """Acceptance for the lead-declared term correspondences."""
    # Opening texts genuinely differ (penalized for free); the rest mirrors
    # the golden handoff (one equal-text match plus a tail gap-order tie), so
    # anchors and the alternative path are exercised under the term rule.
    left = [
        {"time": 0, "text": "人工智能"},
        {"time": 4200, "text": "新产品将于下月上市"},
        {"time": 9000, "text": "感谢各位的提问"},
    ]
    right = [
        {"time": 100, "text": "AI"},
        {"time": 4100, "text": "新产品将于下月上市"},
        {"time": 12000, "text": "交接后的补充记录"},
    ]
    base = {"left": left, "right": right}
    terms = [{"left_text": "人工智能", "right_text": "AI"}]

    # Guarantee 1: absent / empty term_pairs keep the exact legacy result.
    status, free_body = http("POST", f"{API_URL}/api/align", base)
    check(
        "terms: free response has no term_pairs field and no row markers",
        status == 200
        and "term_pairs" not in free_body
        and all("term_pair" not in s for s in free_body["steps"]),
        f"body={free_body}",
    )
    status, body_empty = http(
        "POST", f"{API_URL}/api/align", {**base, "term_pairs": []}
    )
    check(
        "terms: empty term_pairs array equals the legacy result",
        status == 200 and body_empty == free_body,
    )

    # Guarantee 2: the main flow — the lead adds the translation
    # correspondence, aligns, and the mismatch penalty is waived exactly on
    # the exact-hit pairing; per-step recomputation still totals the result.
    status, body = http(
        "POST", f"{API_URL}/api/align", {**base, "term_pairs": terms}
    )
    check(
        "terms: declared correspondence is echoed back",
        status == 200 and body.get("term_pairs") == terms,
        f"body={body}",
    )
    hit_rows = [s for s in body["steps"] if "term_pair" in s]
    check(
        "terms: exactly the exact-hit pairing is marked 术语等价",
        len(hit_rows) == 1
        and hit_rows[0]["action"] == "match"
        and hit_rows[0]["left"]["text"] == "人工智能"
        and hit_rows[0]["right"]["text"] == "AI"
        and hit_rows[0]["term_pair"] == terms[0]
        and hit_rows[0]["cost"] == 100,
        f"hit_rows={hit_rows}",
    )
    check(
        "terms: penalty is accurately waived (|dt|, no +3000) and steps replay",
        body["total_cost"] == free_body["total_cost"] - MISMATCH == 4200
        and [s["cost"] for s in body["steps"]] == [100, 100, 2000, 2000]
        and [s["cumulative_cost"] for s in body["steps"]]
        == [100, 200, 2200, 4200]
        and sum(s["cost"] for s in body["steps"]) == body["total_cost"],
        f"total={body.get('total_cost')} free={free_body['total_cost']}",
    )
    # Equal-text matches and gap rows keep their original source presentation.
    check(
        "terms: non-hit rows keep their original source presentation",
        all("term_pair" not in s for s in body["steps"][1:]),
    )
    # A substring (non-verbatim) declaration never hits.
    status, near_miss = http(
        "POST",
        f"{API_URL}/api/align",
        {**base, "term_pairs": [{"left_text": "人工", "right_text": "AI"}]},
    )
    check(
        "terms: a near miss keeps the mismatch penalty (legacy total)",
        status == 200
        and near_miss["total_cost"] == free_body["total_cost"]
        and all("term_pair" not in s for s in near_miss["steps"]),
        f"body={near_miss}",
    )

    # Guarantee 3: anchors and the alternative path both adopt the term rule.
    status, combined = http(
        "POST",
        f"{API_URL}/api/align",
        {
            **base,
            "anchors": [{"left": 0, "right": 0}],
            "term_pairs": terms,
            "compare_alternative": True,
        },
    )
    anchor_rows = [s for s in combined["steps"] if s.get("origin") == "anchor"]
    alt_anchor_rows = [
        s for s in combined.get("alternative", {}).get("steps", [])
        if s.get("origin") == "anchor"
    ]
    check(
        "terms: a forced anchor on the synonym waives its penalty too",
        status == 200
        and len(anchor_rows) == 1
        and anchor_rows[0]["cost"] == 100
        and anchor_rows[0]["term_pair"] == terms[0],
        f"combined={combined}",
    )
    check(
        "terms: anchors and the alternative share the term rule",
        combined.get("alternative") is not None
        and combined["alternative"]["cost_diff"] == 0
        and alt_anchor_rows == anchor_rows
        and any(
            s.get("term_pair") == terms[0]
            for s in combined["alternative"]["steps"]
        ),
        f"alternative={combined.get('alternative')}",
    )

    # Guarantee 4: a same-side duplicate mapping fails exactly once, on the
    # first conflicting entry, no matter how many later entries also clash.
    conflict_terms = [
        {"left_text": "人工智能", "right_text": "AI"},
        {"left_text": "人工智能", "right_text": "ML"},
        {"left_text": "机器学习", "right_text": "AI"},
    ]
    status, body = http(
        "POST", f"{API_URL}/api/align",
        {**base, "term_pairs": conflict_terms},
    )
    check(
        "terms: duplicate left mapping fails once at term_pairs[1].left_text",
        status == 422
        and set(body) == {"error", "path"}
        and body["path"] == "term_pairs[1].left_text"
        and "steps" not in body,
        f"body={body}",
    )
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            **base,
            "term_pairs": [
                {"left_text": "人工智能", "right_text": "AI"},
                {"left_text": "机器学习", "right_text": "AI"},
            ],
        },
    )
    check(
        "terms: duplicate right mapping fails once at term_pairs[1].right_text",
        status == 422 and body["path"] == "term_pairs[1].right_text",
        f"body={body}",
    )

    # Guarantee 5: deleting every term pair restores the original result.
    status, restored = http("POST", f"{API_URL}/api/align", base)
    check(
        "terms: deleting all term pairs restores the original result",
        status == 200 and restored == free_body,
    )

    # Guarantee 6: declared texts are kept verbatim, leading/trailing spaces
    # included, and hit notes carrying those exact spaces.
    spaced_terms = [{"left_text": " 人工智能 ", "right_text": " AI "}]
    status, spaced = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [{"time": 0, "text": " 人工智能 "}],
            "right": [{"time": 100, "text": " AI "}],
            "term_pairs": spaced_terms,
        },
    )
    check(
        "terms: leading/trailing spaces are preserved verbatim and hit",
        status == 200
        and spaced.get("term_pairs") == spaced_terms
        and spaced["steps"][0].get("term_pair") == spaced_terms[0]
        and spaced["total_cost"] == 100,
        f"spaced={spaced}",
    )

    # Guarantee 7: a pair whose two declared sides are themselves identical
    # is still a declared correspondence, so the equal-text match row carries
    # the pair as its source.
    same_text = "新产品将于下月上市"
    same_terms = [{"left_text": same_text, "right_text": same_text}]
    status, marked = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [{"time": 0, "text": same_text}],
            "right": [{"time": 100, "text": same_text}],
            "term_pairs": same_terms,
        },
    )
    check(
        "terms: an equal-sided declared pair marks the same-text match row",
        status == 200
        and marked["steps"][0].get("term_pair") == same_terms[0]
        and marked["total_cost"] == 100,
        f"marked={marked}",
    )


def main() -> int:
    # 1. API health
    status, body = http("GET", f"{API_URL}/health")
    check("API /health returns 200 ok", status == 200 and body.get("status") == "ok")

    # 2. Web serves the SPA
    wstatus, html = get(f"{WEB_URL}/")
    check("web serves index.html", wstatus == 200 and "口译交接时间轴对齐" in html)

    # 3. Web nginx proxies /api through to the API container (integration!)
    pstatus, pbody = http(
        "POST",
        f"{WEB_URL}/api/align",
        {"left": [], "right": []},
    )
    check(
        "web /api proxy reaches FastAPI",
        pstatus == 200 and pbody.get("total_cost") == 0 and pbody.get("steps") == [],
        f"status={pstatus} body={pbody}",
    )

    # 4. Golden handoff
    left = [
        {"time": 0, "text": "各位媒体朋友下午好"},
        {"time": 4200, "text": "新产品将于下月上市"},
        {"time": 9000, "text": "感谢各位的提问"},
    ]
    right = [
        {"time": 150, "text": "各位媒体朋友下午好"},
        {"time": 4100, "text": "新产品将于下月上市"},
        {"time": 12000, "text": "交接后的补充记录"},
    ]
    status, body = http("POST", f"{API_URL}/api/align", {"left": left, "right": right})
    actions = [s["action"] for s in body["steps"]]
    costs = [s["cost"] for s in body["steps"]]
    check(
        "golden alignment actions + tie-break order",
        status == 200 and actions == ["match", "match", "right_gap", "left_gap"],
        f"actions={actions}",
    )
    # Action name must equal the side that is actually blank on that row.
    check(
        "gap action name matches the blank side (row 2 right_gap keeps left note)",
        body["steps"][2]["left"] == {"time": 9000, "text": "感谢各位的提问"}
        and body["steps"][2]["right"] is None,
    )
    check(
        "gap action name matches the blank side (row 3 left_gap keeps right note)",
        body["steps"][3]["left"] is None
        and body["steps"][3]["right"] == {"time": 12000, "text": "交接后的补充记录"},
    )
    check("golden per-step costs", costs == [150, 100, 2000, 2000], f"costs={costs}")
    check("golden total cost 4250", body.get("total_cost") == 4250)
    cumulative = [s["cumulative_cost"] for s in body["steps"]]
    check("cumulative costs replay to total", cumulative == [150, 250, 2250, 4250])
    check(
        "step costs sum to total",
        sum(costs) == body["total_cost"],
    )

    # 5a. Same-text match cost = absolute time difference
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [{"time": 1000, "text": "same"}],
            "right": [{"time": 1250, "text": "same"}],
        },
    )
    check("same-text match costs |time diff| (250)", body["total_cost"] == 250)

    # 5b. Different-text match cost = |diff| + 3000
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [{"time": 1000, "text": "a"}],
            "right": [{"time": 1000, "text": "b"}],
        },
    )
    check("different-text match costs |diff| + 3000", body["total_cost"] == 3000)

    # 5c. Only a left note: the RIGHT side is blank on that row -> right_gap,
    # costing exactly 2000 (action name = the side that is blank).
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {"left": [{"time": 1, "text": "a"}], "right": []},
    )
    check(
        "left-only note -> right_gap (right side blank) costs 2000",
        body["total_cost"] == 2000 and body["steps"][0]["action"] == "right_gap",
        f"body={body}",
    )
    check(
        "right_gap row carries the left note with right = null",
        body["steps"][0]["left"] == {"time": 1, "text": "a"}
        and body["steps"][0]["right"] is None,
    )

    # 5c-bis. Only a right note -> left_gap (left side blank).
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {"left": [], "right": [{"time": 1, "text": "a"}]},
    )
    check(
        "right-only note -> left_gap (left side blank)",
        body["steps"][0]["action"] == "left_gap"
        and body["steps"][0]["left"] is None
        and body["steps"][0]["right"] == {"time": 1, "text": "a"},
        f"body={body}",
    )

    # 5c-ter. Timestamps beyond Number.MAX_SAFE_INTEGER must keep exact
    # precision end to end: two adjacent increasing values that collide when
    # rounded to a JS double must NOT be reported as duplicates, and the
    # server-computed cost must reflect the exact 1ms difference.
    big_a = 9007199254740993  # 2^53+1
    big_b = 9007199254740995  # 2^53+3; JSON.parse rounds both together
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [
                {"time": big_a, "text": "交接点"},
                {"time": big_b, "text": "结束语"},
            ],
            "right": [{"time": big_a + 1, "text": "交接点"}],
        },
    )
    check(
        "huge increasing integers are not false duplicates (200 ok)",
        status == 200 and body.get("total_cost") is not None,
        f"status={status} body={body}",
    )
    check(
        "huge integer digits survive response exactly (|Δt| = 1)",
        body["steps"][0]["left"]["time"] == big_a
        and body["steps"][0]["right"]["time"] == big_a + 1
        and body["steps"][0]["cost"] == 1,
        f"step0={body.get('steps', [None])[0]}",
    )
    # A genuine duplicate at huge magnitude must still fail exactly once.
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [
                {"time": big_a, "text": "a"},
                {"time": big_a, "text": "b"},
            ],
            "right": [],
        },
    )
    check(
        "genuine duplicate huge integer still fails once at left[1].time",
        status == 422 and body.get("path") == "left[1].time",
        f"status={status} body={body}",
    )

    # 5d. Two gaps preferred to a 9000-time-difference match; tie at 4000
    # prefers the match.
    status, far = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [{"time": 0, "text": "s"}],
            "right": [{"time": 9000, "text": "s"}],
        },
    )
    check(
        "two gaps (4000) beat a 9000 match",
        far["total_cost"] == 4000
        and [s["action"] for s in far["steps"]] == ["right_gap", "left_gap"],
    )
    status, tie = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [{"time": 0, "text": "s"}],
            "right": [{"time": 4000, "text": "s"}],
        },
    )
    check(
        "tie at 4000 prefers the match",
        [s["action"] for s in tie["steps"]] == ["match"] and tie["total_cost"] == 4000,
    )

    # 6a. Duplicate time -> exactly one failure with first path
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {
            "left": [
                {"time": 1, "text": "a"},
                {"time": 1, "text": "b"},
            ],
            "right": [{"time": "x", "text": "y"}],  # also wrong, must not be reported
        },
    )
    check(
        "duplicate time: single 422 at left[1].time",
        status == 422
        and set(body.keys()) == {"error", "path"}
        and body["path"] == "left[1].time",
        f"status={status} body={body}",
    )

    # 6b. Over the 200-item limit -> first over-limit index
    many = [{"time": i, "text": "x"} for i in range(201)]
    status, body = http(
        "POST", f"{API_URL}/api/align", {"left": many, "right": []}
    )
    check("201 items fail once at left[200]", status == 422 and body["path"] == "left[200]")

    # 6c. Non-increasing time, missing field, empty text, extra key
    cases = [
        (
            {"left": [{"time": 9, "text": "a"}, {"time": 8, "text": "b"}], "right": []},
            "left[1].time",
        ),
        (
            {"left": [{"text": "a"}], "right": []},
            "left[0].time",
        ),
        (
            {"left": [{"time": 1, "text": ""}], "right": []},
            "left[0].text",
        ),
        (
            {"left": [{"time": 1, "text": "a", "who": "z"}], "right": []},
            "left[0].who",
        ),
        (
            {"left": "not-an-array", "right": []},
            "left",
        ),
        (
            {"left": [], "right": [{"time": 1.5, "text": "a"}]},
            "right[0].time",
        ),
    ]
    for payload, expected_path in cases:
        status, body = http("POST", f"{API_URL}/api/align", payload)
        check(
            f"validation {expected_path} yields one failure",
            status == 422 and body.get("path") == expected_path and len(body) == 2,
            f"got status={status} body={body}",
        )

    # 7. Uniqueness: the same payload always produces an identical timeline.
    payload = {"left": left, "right": right}
    _, first = http("POST", f"{API_URL}/api/align", payload)
    for _ in range(3):
        _, again = http("POST", f"{API_URL}/api/align", payload)
    check("repeated runs return an identical unique timeline", again == first)

    # 8. Human-confirmed anchors.
    run_anchor_checks(left, right, first)

    # 9. Strictly second-best alternative path comparison.
    run_compare_alternative_checks(left, right, first)

    # 10. Lead-declared term correspondences (synonym pairs).
    run_term_pair_checks()

    print(f"\n{checks - len(failures)}/{checks} checks passed.")
    if failures:
        print("FAILED:")
        for name in failures:
            print(f"  - {name}")
        return 1
    print("ACCEPTANCE VERIFIED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
