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


# --------------------------------------------------------------------------- #
# Strictly second-best ("compare_alternative") path.
# --------------------------------------------------------------------------- #


def test_compare_alternative_flag_absent_or_false_is_legacy_response():
    payload = {
        "left": [
            {"time": 0, "text": "a"},
            {"time": 4000, "text": "b"},
        ],
        "right": [
            {"time": 4000, "text": "a"},
            {"time": 8000, "text": "b"},
        ],
    }
    legacy = post(payload).json()
    assert "alternative" not in legacy
    assert post({**payload, "compare_alternative": False}).json() == legacy
    # Anchored requests keep the same guarantee.
    anchored_legacy = post(
        {**payload, "anchors": [{"left": 0, "right": 0}]}
    ).json()
    assert "alternative" not in anchored_legacy
    assert post(
        {
            **payload,
            "anchors": [{"left": 0, "right": 0}],
            "compare_alternative": False,
        }
    ).json() == anchored_legacy


def test_compare_alternative_returns_second_path_cost_gap_and_divergence():
    payload = {
        "left": [
            {"time": 0, "text": "a"},
            {"time": 4000, "text": "b"},
        ],
        "right": [
            {"time": 4000, "text": "a"},
            {"time": 8000, "text": "b"},
        ],
        "compare_alternative": True,
    }
    data = post(payload).json()
    # The optimum is unchanged by the flag.
    assert data["total_cost"] == 7000
    alt = data["alternative"]
    assert alt["total_cost"] == 8000
    assert alt["cost_diff"] == 1000
    assert alt["first_divergence"] == {"left": 0, "right": 0}
    assert [(s["action"], s["cost"]) for s in alt["steps"]] == [
        ("match", 4000),
        ("match", 4000),
    ]
    # Alternative rows carry their own cumulative costs and no provenance on
    # an anchor-free request.
    assert [s["cumulative_cost"] for s in alt["steps"]] == [4000, 8000]
    assert all("origin" not in s for s in alt["steps"])


def test_compare_alternative_equal_cost_tie_reports_zero_gap():
    payload = {
        "left": [
            {"time": 0, "text": "g"},
            {"time": 4200, "text": "p"},
            {"time": 9000, "text": "t"},
        ],
        "right": [
            {"time": 150, "text": "g"},
            {"time": 4100, "text": "p"},
            {"time": 12000, "text": "h"},
        ],
        "compare_alternative": True,
    }
    data = post(payload).json()
    alt = data["alternative"]
    assert data["total_cost"] == alt["total_cost"] == 4250
    assert alt["cost_diff"] == 0
    assert alt["first_divergence"] == {"left": None, "right": 2}
    assert [s["action"] for s in alt["steps"]] == [
        "match",
        "match",
        "left_gap",
        "right_gap",
    ]


def test_compare_alternative_unique_path_is_null_but_result_still_shown():
    # Empty input: exactly one (empty) legal path.
    data = post({"left": [], "right": [], "compare_alternative": True}).json()
    assert data["total_cost"] == 0
    assert data["steps"] == []
    assert data["alternative"] is None

    # A single note likewise has one legal row.
    data = post(
        {
            "left": [{"time": 1, "text": "a"}],
            "right": [],
            "compare_alternative": True,
        }
    ).json()
    assert data["total_cost"] == 2000
    assert data["alternative"] is None


def test_compare_alternative_with_fully_pinning_anchors_is_null():
    payload = {
        "left": [{"time": 1, "text": "a"}],
        "right": [{"time": 2, "text": "a"}],
        "anchors": [{"left": 0, "right": 0}],
        "compare_alternative": True,
    }
    data = post(payload).json()
    assert data["anchors"] == [{"left": 0, "right": 0}]
    assert data["alternative"] is None


def test_anchors_constrain_the_alternative_path():
    base = {
        "left": [
            {"time": 0, "text": "g"},
            {"time": 4200, "text": "p"},
            {"time": 9000, "text": "t"},
        ],
        "right": [
            {"time": 150, "text": "g"},
            {"time": 4100, "text": "p"},
            {"time": 12000, "text": "h"},
        ],
    }
    data = post(
        {
            **base,
            "anchors": [{"left": 0, "right": 0}],
            "compare_alternative": True,
        }
    ).json()
    alt = data["alternative"]
    assert alt is not None and alt["cost_diff"] == 0
    # The forced anchor is an identical row in both timelines.
    primary_anchor = [s for s in data["steps"] if s["origin"] == "anchor"]
    alt_anchor = [s for s in alt["steps"] if s["origin"] == "anchor"]
    assert primary_anchor == alt_anchor and len(alt_anchor) == 1
    assert all(
        s.get("origin") == "auto"
        for s in alt["steps"]
        if s["origin"] != "anchor"
    )


def test_compare_alternative_must_be_boolean():
    for bad in ("true", 1, [True]):
        resp = post(
            {
                "left": [],
                "right": [],
                "compare_alternative": bad,
            }
        )
        assert resp.status_code == 422, (bad, resp.json())
        body = resp.json()
        assert body["path"] == "compare_alternative"
        assert set(body) == {"error", "path"}


def test_sequence_failure_is_reported_before_compare_flag_check():
    # Fixed check order: bad notes fail before the boolean flag is examined.
    resp = post(
        {
            "left": [{"time": 1, "text": ""}],
            "right": [],
            "compare_alternative": "yes",
        }
    )
    assert resp.status_code == 422
    assert resp.json()["path"] == "left[0].text"


# --------------------------------------------------------------------------- #
# Optional term_pairs: lead-declared exact-hit synonym correspondences.
# --------------------------------------------------------------------------- #


def test_term_pairs_absent_or_empty_keep_legacy_response():
    payload = {
        "left": [
            {"time": 0, "text": "人工智能"},
            {"time": 9000, "text": "结束语"},
        ],
        "right": [
            {"time": 100, "text": "AI"},
            {"time": 9200, "text": "结束语"},
        ],
    }
    legacy = post(payload).json()
    assert "term_pairs" not in legacy
    assert all("term_pair" not in s for s in legacy["steps"])
    # An explicitly empty term_pairs array is byte/shape identical.
    assert post({**payload, "term_pairs": []}).json() == legacy


def test_term_pair_exact_hit_waives_penalty_and_echoes_the_pair():
    payload = {
        "left": [
            {"time": 0, "text": "人工智能"},
            {"time": 9000, "text": "结束语"},
        ],
        "right": [
            {"time": 100, "text": "AI"},
            {"time": 9200, "text": "结束语"},
        ],
        "term_pairs": [{"left_text": "人工智能", "right_text": "AI"}],
    }
    data = post(payload).json()
    assert data["term_pairs"] == [
        {"left_text": "人工智能", "right_text": "AI"}
    ]
    hit = data["steps"][0]
    assert hit["action"] == "match"
    assert hit["cost"] == 100  # |0-100|, no mismatch penalty
    assert hit["term_pair"] == {
        "left_text": "人工智能", "right_text": "AI"
    }
    # The ordinary equal-text match carries no term marker.
    assert "term_pair" not in data["steps"][1]
    assert data["total_cost"] == 300


def test_term_pair_miss_keeps_the_mismatch_penalty_and_marker_absent():
    payload = {
        "left": [{"time": 0, "text": "x"}],
        "right": [{"time": 0, "text": "y"}],
        "term_pairs": [{"left_text": "a", "right_text": "b"}],
    }
    data = post(payload).json()
    assert data["total_cost"] == 3000
    assert "term_pair" not in data["steps"][0]


def test_term_pair_on_a_forced_anchor_waives_the_penalty_there_too():
    payload = {
        "left": [
            {"time": 0, "text": "人工智能"},
            {"time": 9000, "text": "结束语"},
        ],
        "right": [
            {"time": 100, "text": "AI"},
            {"time": 9200, "text": "结束语"},
        ],
        "anchors": [{"left": 0, "right": 0}],
        "term_pairs": [{"left_text": "人工智能", "right_text": "AI"}],
    }
    data = post(payload).json()
    anchor_row = next(s for s in data["steps"] if s["origin"] == "anchor")
    assert anchor_row["cost"] == 100
    assert anchor_row["term_pair"] == {
        "left_text": "人工智能", "right_text": "AI"
    }
    assert data["anchors"] == [{"left": 0, "right": 0}]
    assert data["term_pairs"] == [
        {"left_text": "人工智能", "right_text": "AI"}
    ]


def test_term_pairs_constrain_the_alternative_path():
    payload = {
        "left": [
            {"time": 0, "text": "g"},
            {"time": 4200, "text": "p"},
            {"time": 9000, "text": "t"},
        ],
        "right": [
            {"time": 150, "text": "G"},
            {"time": 4100, "text": "P"},
            {"time": 12000, "text": "h"},
        ],
        "term_pairs": [
            {"left_text": "g", "right_text": "G"},
            {"left_text": "p", "right_text": "P"},
        ],
        "compare_alternative": True,
    }
    data = post(payload).json()
    assert data["total_cost"] == 4250  # 150 + 100 + 2000 + 2000
    assert data["alternative"] is not None
    assert data["alternative"]["cost_diff"] == 0
    assert data["alternative"]["steps"][0]["term_pair"] == {
        "left_text": "g", "right_text": "G"
    }


def test_term_pairs_conflict_is_a_single_failure_on_first_item():
    base = {"left": [], "right": []}

    # Duplicate left_text -> the second entry's left_text is reported once.
    resp = post({
        **base,
        "term_pairs": [
            {"left_text": "a", "right_text": "x"},
            {"left_text": "a", "right_text": "y"},
        ],
    })
    assert resp.status_code == 422
    body = resp.json()
    assert set(body) == {"error", "path"}
    assert body["path"] == "term_pairs[1].left_text"
    assert "steps" not in body

    # Duplicate right_text -> the second entry's right_text.
    resp = post({
        **base,
        "term_pairs": [
            {"left_text": "a", "right_text": "x"},
            {"left_text": "b", "right_text": "x"},
        ],
    })
    assert resp.json()["path"] == "term_pairs[1].right_text"


def test_term_pairs_shape_failures():
    base = {"left": [], "right": []}
    cases = [
        ("nope", "term_pairs"),
        ([5], "term_pairs[0]"),
        ([{"left_text": "a"}], "term_pairs[0].right_text"),
        ([{"right_text": "b"}], "term_pairs[0].left_text"),
        ([{"left_text": "", "right_text": "b"}], "term_pairs[0].left_text"),
        ([{"left_text": "a", "right_text": ""}], "term_pairs[0].right_text"),
        ([{"left_text": 1, "right_text": "b"}], "term_pairs[0].left_text"),
        ([{"left_text": "a", "right_text": None}], "term_pairs[0].right_text"),
        (
            [{"left_text": "a", "right_text": "b", "x": 1}],
            "term_pairs[0].x",
        ),
    ]
    for term_pairs, expected_path in cases:
        resp = post({**base, "term_pairs": term_pairs})
        assert resp.status_code == 422
        assert resp.json()["path"] == expected_path, (term_pairs, resp.json())


def test_check_order_sequences_then_anchors_then_terms_then_flag():
    # Bad note text beats a bad term pair and a bad compare flag.
    resp = post({
        "left": [{"time": 1, "text": ""}],
        "right": [],
        "anchors": [{"left": 9, "right": 9}],
        "term_pairs": "nope",
        "compare_alternative": "yes",
    })
    assert resp.json()["path"] == "left[0].text"

    # With valid notes, a bad anchor beats a bad term pair.
    resp = post({
        "left": [{"time": 1, "text": "a"}],
        "right": [{"time": 2, "text": "b"}],
        "anchors": [{"left": 9, "right": 0}],
        "term_pairs": "nope",
    })
    assert resp.json()["path"] == "anchors[0].left"

    # With valid notes and anchors, the bad term pair beats the bad flag.
    resp = post({
        "left": [],
        "right": [],
        "term_pairs": "nope",
        "compare_alternative": "yes",
    })
    assert resp.json()["path"] == "term_pairs"


def test_deleting_all_term_pairs_restores_the_original_result():
    payload = {
        "left": [{"time": 0, "text": "人工智能"}],
        "right": [{"time": 100, "text": "AI"}],
    }
    free = post(payload).json()
    with_terms = post({
        **payload,
        "term_pairs": [{"left_text": "人工智能", "right_text": "AI"}],
    }).json()
    assert with_terms["total_cost"] == 100
    assert free["total_cost"] == 3100
    # Re-requesting with every term pair removed restores the free result.
    assert post(payload).json() == free
