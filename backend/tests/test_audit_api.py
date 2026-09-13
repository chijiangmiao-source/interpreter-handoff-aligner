"""End-to-end API tests for POST /api/audit through the real ASGI stack."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

LEFT = [
    {"time": 0, "text": "各位媒体朋友下午好"},
    {"time": 4200, "text": "新产品将于下月上市"},
    {"time": 9000, "text": "感谢各位的提问"},
]
RIGHT = [
    {"time": 150, "text": "各位媒体朋友下午好"},
    {"time": 4100, "text": "新产品将于下月上市"},
    {"time": 12000, "text": "交接后的补充记录"},
]


def aligned(**extra):
    return client.post("/api/align", json={"left": LEFT, "right": RIGHT, **extra}).json()


def audit(candidate, **extra):
    return client.post(
        "/api/audit",
        json={"left": LEFT, "right": RIGHT, "candidate": candidate, **extra},
    )


def golden_candidate():
    body = aligned()
    return {"steps": body["steps"], "total_cost": body["total_cost"]}


# -------------------------------------------------------------------------- #
# Passing verifications
# -------------------------------------------------------------------------- #


def test_golden_candidate_passes_end_to_end():
    resp = audit(golden_candidate())
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["total_cost"] == 4250
    assert body["consumed"] == {"left": 3, "right": 3}
    assert [d["expected_cost"] for d in body["steps"]] == [150, 100, 2000, 2000]
    assert [d["expected_cumulative_cost"] for d in body["steps"]] == [
        150, 250, 2250, 4250
    ]


def test_empty_inputs_with_empty_candidate_pass():
    resp = client.post(
        "/api/audit",
        json={"left": [], "right": [], "candidate": {"steps": [], "total_cost": 0}},
    )
    assert resp.status_code == 200
    assert resp.json()["total_cost"] == 0


def test_candidate_with_anchors_and_term_pairs_recomputes_fully():
    terms = [
        {"left_text": "g", "right_text": "G"},
        {"left_text": "p", "right_text": "P"},
    ]
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
    body = client.post(
        "/api/align",
        json={
            "left": left,
            "right": right,
            "anchors": [{"left": 0, "right": 0}],
            "term_pairs": terms,
        },
    ).json()
    resp = client.post(
        "/api/audit",
        json={
            "left": left,
            "right": right,
            "anchors": [{"left": 0, "right": 0}],
            "term_pairs": terms,
            "candidate": {"steps": body["steps"], "total_cost": body["total_cost"]},
        },
    )
    assert resp.status_code == 200
    outcome = resp.json()
    assert outcome["ok"] is True
    assert outcome["anchors"] == [{"left": 0, "right": 0}]
    first = outcome["steps"][0]
    assert first["origin"] == "anchor"
    assert first["expected_term_pair"] == {"left_text": "g", "right_text": "G"}
    assert first["expected_cost"] == 150
    assert "免除 3000" in first["basis"]


# -------------------------------------------------------------------------- #
# Structural failures keep the ordinary single-error envelope
# -------------------------------------------------------------------------- #


def test_malformed_json_is_single_400():
    resp = client.post(
        "/api/audit",
        content=b"{not json",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 400
    assert set(resp.json()) == {"error", "path"}
    assert resp.json()["path"] == ""


def test_input_errors_are_reported_before_the_candidate():
    # Bad left notes win over a missing candidate (fixed check order).
    resp = client.post(
        "/api/audit",
        json={
            "left": [{"time": 1, "text": "a"}, {"time": 1, "text": "b"}],
            "right": [],
            "candidate": {"steps": [], "total_cost": 0},
        },
    )
    assert resp.status_code == 422
    assert resp.json()["path"] == "left[1].time"
    assert set(resp.json()) == {"error", "path"}


def test_missing_candidate_fails_once():
    resp = client.post("/api/audit", json={"left": [], "right": []})
    assert resp.status_code == 422
    assert resp.json()["path"] == "candidate"


def test_candidate_structure_failure_uses_single_envelope():
    resp = client.post(
        "/api/audit",
        json={
            "left": [],
            "right": [],
            "candidate": {"steps": [{"action": "match"}], "total_cost": 0},
        },
    )
    assert resp.status_code == 422
    body = resp.json()
    assert set(body) == {"error", "path"}
    assert body["path"] == "candidate.steps[0].left"


def test_bad_total_cost_type_is_structural():
    resp = client.post(
        "/api/audit",
        json={"left": [], "right": [], "candidate": {"steps": [], "total_cost": "0"}},
    )
    assert resp.status_code == 422
    assert resp.json()["path"] == "candidate.total_cost"


# -------------------------------------------------------------------------- #
# Semantic failures: path + expected + actual for the first difference
# -------------------------------------------------------------------------- #


def test_missing_note_is_localized():
    candidate = golden_candidate()
    # Drop the trailing left_gap row (right[2]) but keep its cost in total.
    candidate["steps"] = [
        dict(s) for s in candidate["steps"] if s["action"] != "left_gap"
    ]
    for s in candidate["steps"]:  # replay cumulative so conservation fails first
        pass
    cumulative = 0
    for s in candidate["steps"]:
        cumulative += s["cost"]
        s["cumulative_cost"] = cumulative
    candidate["total_cost"] = cumulative
    resp = audit(candidate)
    assert resp.status_code == 422
    body = resp.json()
    assert body["path"] == "candidate.steps[3]"
    assert body["expected"] == {"time": 12000, "text": "交接后的补充记录"}
    assert body["actual"] is None
    assert set(body) == {"error", "path", "expected", "actual"}


def test_duplicate_note_is_localized():
    candidate = golden_candidate()
    repeated = dict(candidate["steps"][2])  # right_gap carrying left[2]
    candidate["steps"].insert(3, repeated)
    resp = audit(candidate)
    assert resp.status_code == 422
    body = resp.json()
    assert body["path"] == "candidate.steps[3].left"
    assert "left[2]" in body["actual"]
    assert "重复" in body["error"]


def test_wrong_single_step_cost_is_rejected():
    candidate = golden_candidate()
    candidate["steps"][2]["cost"] = 9999
    resp = audit(candidate)
    assert resp.status_code == 422
    body = resp.json()
    assert body["path"] == "candidate.steps[2].cost"
    assert body["expected"] == 2000
    assert body["actual"] == 9999


def test_wrong_total_cost_is_rejected():
    candidate = golden_candidate()
    candidate["total_cost"] = 4249
    resp = audit(candidate)
    assert resp.status_code == 422
    body = resp.json()
    assert body["path"] == "candidate.total_cost"
    assert body["expected"] == 4250
    assert body["actual"] == 4249


def test_term_hit_cost_without_declared_pair_is_rejected():
    # Different texts cost |100| + 3000 = 3100 with no declared synonym.
    candidate = {
        "steps": [
            {
                "action": "match",
                "left": {"time": 0, "text": "人工智能"},
                "right": {"time": 100, "text": "AI"},
                "cost": 100,
                "cumulative_cost": 100,
            }
        ],
        "total_cost": 100,
    }
    resp = client.post(
        "/api/audit",
        json={
            "left": [{"time": 0, "text": "人工智能"}],
            "right": [{"time": 100, "text": "AI"}],
            "candidate": candidate,
        },
    )
    assert resp.status_code == 422
    body = resp.json()
    assert body["path"] == "candidate.steps[0].cost"
    assert body["expected"] == 3100
    assert body["actual"] == 100


def test_audit_does_not_change_the_align_endpoint():
    # The legacy endpoint's request/response stay byte-for-byte identical; the
    # new endpoint simply coexists.
    first = client.post("/api/align", json={"left": LEFT, "right": RIGHT}).json()
    audit(golden_candidate())
    second = client.post("/api/align", json={"left": LEFT, "right": RIGHT}).json()
    assert first == second
    assert "candidate" not in first
