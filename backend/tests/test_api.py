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


# --------------------------------------------------------------------------- #
# Optional anchors.
# --------------------------------------------------------------------------- #


def test_request_without_anchors_is_byte_shape_compatible():
    payload = {
        "left": [{"time": 0, "text": "a"}, {"time": 5000, "text": "b"}],
        "right": [{"time": 10, "text": "a"}, {"time": 5200, "text": "b"}],
    }
    legacy = post(payload).json()
    # No anchors key anywhere, no per-row origin: the historical response.
    assert "anchors" not in legacy
    assert all("origin" not in s for s in legacy["steps"])
    # An explicitly empty anchors array is the same legacy request/response.
    assert post({**payload, "anchors": []}).json() == legacy


def test_valid_anchor_is_fixed_into_timeline_and_tagged():
    payload = {
        "left": [
            {"time": 0, "text": "a"},
            {"time": 5000, "text": "b"},
            {"time": 9000, "text": "c"},
        ],
        "right": [
            {"time": 10, "text": "a"},
            {"time": 4000, "text": "x"},
            {"time": 5200, "text": "b"},
        ],
        "anchors": [{"left": 2, "right": 1}],
    }
    resp = post(payload)
    assert resp.status_code == 200, resp.json()
    data = resp.json()
    assert data["anchors"] == [{"left": 2, "right": 1}]
    anchor_rows = [s for s in data["steps"] if s["origin"] == "anchor"]
    auto_rows = [s for s in data["steps"] if s["origin"] == "auto"]
    assert len(anchor_rows) == 1
    row = anchor_rows[0]
    assert row["action"] == "match"
    assert row["left"] == {"time": 9000, "text": "c"}
    assert row["right"] == {"time": 4000, "text": "x"}
    # Forced distant, different-text pair costs |dt| + 3000.
    assert row["cost"] == 5000 + 3000
    assert auto_rows and all(s["origin"] == "auto" for s in auto_rows)
    # Steps still replay exactly to the anchored total.
    assert sum(s["cost"] for s in data["steps"]) == data["total_cost"]


def test_two_anchors_split_intervals_and_keep_optimum():
    payload = {
        "left": [
            {"time": 0, "text": "a"},
            {"time": 5000, "text": "b"},
            {"time": 9000, "text": "c"},
        ],
        "right": [
            {"time": 10, "text": "a"},
            {"time": 4000, "text": "x"},
            {"time": 5200, "text": "b"},
        ],
        "anchors": [{"left": 0, "right": 0}, {"left": 2, "right": 1}],
    }
    data = post(payload).json()
    origins = [s["origin"] for s in data["steps"]]
    assert origins.count("anchor") == 2
    # Anchor rows are pinned to the confirmed records.
    anchor_rows = [s for s in data["steps"] if s["origin"] == "anchor"]
    assert [s["left"]["time"] for s in anchor_rows] == [0, 9000]
    assert [s["right"]["time"] for s in anchor_rows] == [10, 4000]


def test_anchor_out_of_range_is_single_error_and_no_timeline():
    payload = {
        "left": [{"time": 1, "text": "a"}],
        "right": [{"time": 2, "text": "b"}],
        "anchors": [{"left": 1, "right": 0}],
    }
    resp = post(payload)
    assert resp.status_code == 422
    body = resp.json()
    assert set(body) == {"error", "path"}
    assert body["path"] == "anchors[0].left"
    assert "越界" in body["error"]


def test_crossing_anchors_fail_once_at_first_offending_anchor():
    payload = {
        "left": [{"time": i, "text": "x"} for i in range(3)],
        "right": [{"time": i, "text": "x"} for i in range(3)],
        "anchors": [
            {"left": 0, "right": 0},
            {"left": 2, "right": 2},
            {"left": 1, "right": 1},  # crosses the previous anchor
        ],
    }
    resp = post(payload)
    assert resp.status_code == 422
    body = resp.json()
    assert body["path"] == "anchors[2].left"
    assert "交叉" in body["error"]
    # Exactly one failure object, never a partial/possibly-valid timeline.
    assert set(body) == {"error", "path"}


def test_reused_anchor_index_fails_once():
    payload = {
        "left": [{"time": i, "text": "x"} for i in range(3)],
        "right": [{"time": i, "text": "x"} for i in range(3)],
        "anchors": [{"left": 0, "right": 0}, {"left": 0, "right": 1}],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert resp.json()["path"] == "anchors[1].left"


def test_anchors_wrong_shape_failures():
    base = {
        "left": [{"time": 1, "text": "a"}],
        "right": [{"time": 2, "text": "b"}],
    }
    cases = [
        ("x", "anchors"),
        ([5], "anchors[0]"),
        ([{}], "anchors[0].left"),
        ([{"left": 0}], "anchors[0].right"),
        ([{"left": 0, "right": 0, "x": 1}], "anchors[0].x"),
        ([{"left": True, "right": 0}], "anchors[0].left"),
    ]
    for anchors, expected_path in cases:
        resp = post({**base, "anchors": anchors})
        assert resp.status_code == 422
        assert resp.json()["path"] == expected_path, (anchors, resp.json())


def test_sequence_error_is_reported_before_anchor_error():
    # Both the left sequence and the anchors are bad; validation order is
    # fixed (sequences first, left before right, then anchors).
    payload = {
        "left": [{"time": 1, "text": ""}],
        "right": [],
        "anchors": [{"left": 9, "right": 9}],
    }
    resp = post(payload)
    assert resp.status_code == 422
    assert resp.json()["path"] == "left[0].text"


def test_cancelling_anchors_restores_free_result():
    payload = {
        "left": [{"time": 0, "text": "a"}, {"time": 9000, "text": "b"}],
        "right": [{"time": 10, "text": "b"}, {"time": 8999, "text": "a"}],
    }
    free = post(payload).json()
    anchored = post({**payload, "anchors": [{"left": 0, "right": 1}]}).json()
    assert anchored["total_cost"] >= free["total_cost"]
    # Re-requesting with the anchor removed returns the identical free result.
    assert post(payload).json() == free
