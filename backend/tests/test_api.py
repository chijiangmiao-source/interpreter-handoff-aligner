"""End-to-end API tests through FastAPI's ASGI stack (real request cycle)."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def post(payload, raw: bytes | None = None):
    if raw is not None:
        return client.post(
            "/api/align",
            content=raw,
            headers={"content-type": "application/json"},
        )
    return client.post("/api/align", json=payload)


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_valid_alignment_end_to_end():
    payload = {
        "left": [
            {"time": 0, "text": "开场"},
            {"time": 5000, "text": "交接点"},
        ],
        "right": [
            {"time": 120, "text": "开场"},
            {"time": 4800, "text": "交接点"},
        ],
    }
    resp = post(payload)
    assert resp.status_code == 200
    data = resp.json()
    assert [s["action"] for s in data["steps"]] == ["match", "match"]
    assert data["steps"][0]["cost"] == 120
    assert data["steps"][1]["cost"] == 200
    assert data["total_cost"] == 320
    assert data["counts"]["match"] == 2


def test_malformed_json_is_single_failure():
    resp = post(None, raw=b"{not json")
    assert resp.status_code == 400
    body = resp.json()
    assert body["path"] == ""
    assert len(body["error"]) > 0


def test_root_not_object():
    resp = post([1, 2])
    assert resp.status_code == 422
    assert resp.json()["path"] == ""


def test_missing_side_reports_side_path():
    resp = post({"left": []})
    assert resp.status_code == 422
    assert resp.json()["path"] == "right"


def test_side_not_array():
    resp = post({"left": {}, "right": []})
    assert resp.status_code == 422
    assert resp.json()["path"] == "left"


def test_duplicate_time_single_error_with_path():
    payload = {
        "left": [{"time": 1, "text": "a"}, {"time": 1, "text": "b"}],
        "right": [],
    }
    resp = post(payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["path"] == "left[1].time"
    assert "递增" in body["error"]


def test_too_many_items_single_error():
    payload = {
        "left": [{"time": i, "text": "x"} for i in range(201)],
        "right": [],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert resp.json()["path"] == "left[200]"


def test_extra_field_single_error():
    payload = {
        "left": [{"time": 1, "text": "a", "who": "interpreter-1"}],
        "right": [],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert resp.json()["path"] == "left[0].who"


def test_empty_text_single_error():
    payload = {"left": [{"time": 1, "text": ""}], "right": []}
    resp = post(payload)
    assert resp.status_code == 422
    assert resp.json()["path"] == "left[0].text"


def test_left_error_takes_precedence_over_right():
    payload = {
        "left": [{"time": 2, "text": "a"}, {"time": 1, "text": "b"}],
        "right": [{"time": "x", "text": "y"}],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert resp.json()["path"] == "left[1].time"


def test_each_failure_is_one_error_object_only():
    resp = post(
        {"left": [{"time": "bad", "text": ""}], "right": "also bad"}
    )
    assert resp.status_code == 422
    body = resp.json()
    assert set(body.keys()) == {"error", "path"}
    assert body["path"] == "left[0].time"


def test_empty_arrays_are_valid():
    resp = post({"left": [], "right": []})
    assert resp.status_code == 200
    assert resp.json()["total_cost"] == 0
    assert resp.json()["steps"] == []


def test_response_shape_contains_replay_fields():
    resp = post(
        {
            "left": [{"time": 0, "text": "a"}],
            "right": [{"time": 30, "text": "a"}],
        }
    )
    data = resp.json()
    step = data["steps"][0]
    assert set(step.keys()) == {
        "action",
        "left",
        "right",
        "cost",
        "cumulative_cost",
    }
    assert step["cumulative_cost"] == step["cost"] == data["total_cost"]
    assert data["costs"] == {"gap": 2000, "mismatch_penalty": 3000}
