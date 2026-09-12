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

    # 5c. Single-side gap costs exactly 2000
    status, body = http(
        "POST",
        f"{API_URL}/api/align",
        {"left": [{"time": 1, "text": "a"}], "right": []},
    )
    check(
        "single-side gap costs 2000",
        body["total_cost"] == 2000 and body["steps"][0]["action"] == "left_gap",
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
