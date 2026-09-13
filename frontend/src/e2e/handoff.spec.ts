import { expect, test } from "@playwright/test";

/**
 * Real full-stack integration: these tests drive a browser against the built
 * frontend talking to the live FastAPI process (same-origin via the preview
 * proxy, just like the Docker Compose deployment).
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("sample handoff produces the unique optimal timeline", async ({ page }) => {
  await expect(page.getByTestId("input-left")).toContainText("各位媒体朋友下午好");

  await page.getByTestId("submit").click();

  await expect(page.getByTestId("result-panel")).toBeVisible();
  const rows = page.getByTestId("timeline-row");
  await expect(rows).toHaveCount(4);

  await expect(rows.nth(0)).toHaveAttribute("data-action", "match");
  await expect(rows.nth(1)).toHaveAttribute("data-action", "match");
  // At the tail, left_gap and right_gap routes tie at 4250; the tie-break
  // (left gap before right gap during traceback) fixes this exact order.
  await expect(rows.nth(2)).toHaveAttribute("data-action", "right_gap");
  await expect(rows.nth(3)).toHaveAttribute("data-action", "left_gap");

  await expect(page.getByTestId("step-cost").nth(0)).toHaveText("150");
  await expect(page.getByTestId("step-cost").nth(1)).toHaveText("100");
  await expect(page.getByTestId("step-cost").nth(2)).toHaveText("2000");
  await expect(page.getByTestId("step-cumulative").nth(3)).toHaveText("4250");
  await expect(page.getByTestId("total-cost")).toHaveText("4250");

  // The per-step costs really do add up to the advertised total.
  const costs = await page.getByTestId("step-cost").allInnerTexts();
  expect(costs.map(Number).reduce((a, b) => a + b, 0)).toBe(4250);
});

test("timeline can be replayed one step at a time", async ({ page }) => {
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();

  await page.getByTestId("step-back").click();
  await page.getByTestId("step-back").click();
  await page.getByTestId("step-back").click();
  await expect(page.getByTestId("timeline-row")).toHaveCount(1);
  await expect(page.getByTestId("replay-count")).toContainText("复算 1 / 4 步");
  await expect(page.getByTestId("total-cost")).toHaveText("150");

  await page.getByTestId("step-next").click();
  await expect(page.getByTestId("timeline-row")).toHaveCount(2);
  await expect(page.getByTestId("total-cost")).toHaveText("250");
});

test("duplicate time yields one failure, keeps input, marks first path", async ({
  page,
}) => {
  const bad = JSON.stringify([
    { time: 100, text: "第一段" },
    { time: 100, text: "重复时间" },
  ]);
  await page.getByTestId("input-left").fill(bad);
  await page.getByTestId("input-right").fill("[]");

  await page.getByTestId("submit").click();

  const banner = page.getByTestId("error-banner");
  await expect(banner).toBeVisible();
  await expect(page.getByTestId("error-path")).toHaveText("left[1].time ");
  // Exactly one failure is displayed.
  await expect(page.getByTestId("error-banner")).toHaveCount(1);

  // Original input preserved verbatim.
  await expect(page.getByTestId("input-left")).toHaveValue(bad);
  // The offending member is highlighted in the source textarea.
  await expect(page.getByTestId("input-left-mark")).toBeVisible();
  // No result timeline for an invalid run.
  await expect(page.getByTestId("result-panel")).toHaveCount(0);
});

test("non-increasing time and over-limit arrays each fail once with a path", async ({
  request,
}) => {
  // Verify the live API contract directly as part of the e2e stack.
  const resp = await request.post("/api/align", {
    data: {
      left: [
        { time: 5, text: "a" },
        { time: 4, text: "b" },
      ],
      right: [],
    },
  });
  expect(resp.status()).toBe(422);
  expect(await resp.json()).toEqual({
    error: expect.stringContaining("递增"),
    path: "left[1].time",
  });

  const many = Array.from({ length: 201 }, (_, i) => ({ time: i, text: "x" }));
  const resp2 = await request.post("/api/align", {
    data: { left: many, right: [] },
  });
  expect(resp2.status()).toBe(422);
  expect((await resp2.json()).path).toBe("left[200]");
});

test("malformed JSON is reported with line and column and highlighted", async ({
  page,
}) => {
  await page
    .getByTestId("input-right")
    .fill('[\n  {"time": 1, "text": "a"},\n  ,\n]');
  await page.getByTestId("submit").click();
  const banner = page.getByTestId("error-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("第 3 行");
  await expect(page.getByTestId("input-right-mark")).toBeVisible();
  // Raw input stays intact for the user to fix.
  await expect(page.getByTestId("input-right")).toContainText(",");
});

test("empty arrays are a valid zero-cost handoff", async ({ page }) => {
  await page.getByTestId("clear").click();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();
  await expect(page.getByTestId("timeline-row")).toHaveCount(0);
  await expect(page.getByTestId("total-cost")).toHaveText("0");
});

test("huge increasing timestamps (past safe-integer range) are not false duplicates", async ({
  page,
}) => {
  // 2^53+1 and +3 collide when rounded to a JS double; the fill strings keep
  // the exact digits verbatim (a numeric literal here would itself round).
  await page.getByTestId("input-left").fill(
    `[{"time":9007199254740993,"text":"交接点"},{"time":9007199254740995,"text":"结束语"}]`,
  );
  await page.getByTestId("input-right").fill(
    `[{"time":9007199254740994,"text":"交接点"}]`,
  );
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("result-panel")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  const rows = page.getByTestId("timeline-row");
  await expect(rows).toHaveCount(2);
  // Exact large digits are rendered, not double-rounded 9007199254740992.
  await expect(rows.nth(0)).toContainText("9007199254740993 ms");
  await expect(rows.nth(0)).toContainText("9007199254740994 ms");
  // Same text, |1ms| difference -> single-step cost exactly 1.
  await expect(page.getByTestId("step-cost").nth(0)).toHaveText("1");
});

test("only-left notes label the right side as blank and carry content on the left", async ({
  page,
}) => {
  await page.getByTestId("input-left").fill(
    JSON.stringify([{ time: 100, text: "仅左侧记录" }]),
  );
  await page.getByTestId("input-right").fill("[]");
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("result-panel")).toBeVisible();
  const row = page.getByTestId("timeline-row");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-action", "right_gap");
  // Left cell shows the note, right cell shows the empty marker.
  // Columns: # | left | action | right | source | cost | cumulative | explain
  const cells = row.locator("td");
  await expect(cells.nth(1)).toContainText("仅左侧记录");
  await expect(cells.nth(3)).toContainText("∅");
  await expect(page.getByTestId("step-cost")).toHaveText("2000");
});

test("a marked anchor is fixed into the timeline and styled vs generated rows", async ({
  page,
}) => {
  // Pin left[0] <-> right[0] (the identical opening greetings).
  await page.getByTestId("pick-left-0").click();
  await page.getByTestId("pick-right-0").click();
  await expect(page.getByTestId("anchor-item")).toHaveCount(1);

  await page.getByTestId("submit").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();

  const rows = page.getByTestId("timeline-row");
  await expect(rows).toHaveCount(4);
  // The first row is the human-confirmed anchor; the rest are generated.
  await expect(rows.nth(0)).toHaveAttribute("data-origin", "anchor");
  await expect(rows.nth(1)).toHaveAttribute("data-origin", "auto");
  await expect(rows.nth(2)).toHaveAttribute("data-origin", "auto");
  await expect(rows.nth(3)).toHaveAttribute("data-origin", "auto");
  await expect(page.getByTestId("step-origin").nth(0)).toHaveText("人工锚点");
  await expect(page.getByTestId("step-origin").nth(1)).toHaveText("算法生成");
  await expect(page.getByTestId("legend-anchors")).toBeVisible();
  // The anchor pair is the one confirmed, and step costs still sum to total.
  await expect(rows.nth(0)).toContainText("各位媒体朋友下午好");
  const costs = await page.getByTestId("step-cost").allInnerTexts();
  expect(costs.map(Number).reduce((a, b) => a + b, 0)).toBe(4250);
  await expect(page.getByTestId("total-cost")).toHaveText("4250");
});

test("forcing a non-obvious anchor changes the alignment and pins the pair", async ({
  page,
}) => {
  // Free optimum pairs equal texts. Force left[2] (感谢各位的提问) with
  // right[1] (新产品将于下月上市): a distant, different-text match.
  await page.getByTestId("pick-left-2").click();
  await page.getByTestId("pick-right-1").click();
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("result-panel")).toBeVisible();
  const anchorRows = page.locator('[data-testid="timeline-row"][data-origin="anchor"]');
  await expect(anchorRows).toHaveCount(1);
  const row = anchorRows.first();
  await expect(row).toContainText("感谢各位的提问");
  await expect(row).toContainText("新产品将于下月上市");
  // |9000 - 4100| + 3000 mismatch = 7900
  await expect(row.getByTestId("step-cost")).toHaveText("7900");
});

test("crossing anchors fail once, keep inputs and markers, show no timeline", async ({
  page,
}) => {
  // The local picker keeps a crossing pair and flags it before submit, so a
  // cross can only reach the server from a stale/raced selection. Simulate
  // that single 422 to assert the page's failure UX (a real cross is covered
  // by the live-API test below).
  await page.route("**/api/align", async (route) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: "anchors[1] 与锚点顺序交叉。",
        path: "anchors[1].left",
      }),
    });
  });

  await page.getByTestId("pick-left-0").click();
  await page.getByTestId("pick-right-0").click();
  await page.getByTestId("pick-left-2").click();
  await page.getByTestId("pick-right-2").click();
  const leftBefore = await page.getByTestId("input-left").inputValue();

  await page.getByTestId("submit").click();

  await expect(page.getByTestId("error-banner")).toBeVisible();
  await expect(page.getByTestId("error-path")).toContainText("anchors[1].left");
  // Exactly one failure, no possibly-valid timeline.
  await expect(page.getByTestId("result-panel")).toHaveCount(0);
  // Current inputs and selected markers are retained.
  expect(await page.getByTestId("input-left").inputValue()).toBe(leftBefore);
  await expect(page.getByTestId("anchor-item")).toHaveCount(2);
  // The offending (second) anchor is flagged beside it.
  await expect(page.locator('[data-anchor-index="1"]')).toHaveClass(/invalid/);
  await expect(page.getByTestId("anchor-error")).toBeVisible();
});

test("cancelling an anchor restores the original anchor-free result", async ({
  page,
}) => {
  // Without anchors: 4 rows as the golden timeline, no provenance tags.
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();
  expect(await page.getByTestId("step-origin").count()).toBe(0);

  // Mark an anchor and realign: provenance appears.
  await page.getByTestId("pick-left-0").click();
  await page.getByTestId("pick-right-0").click();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("step-origin").first()).toHaveText("人工锚点");

  // Cancel the anchor and submit again: back to the original result.
  await page.getByTestId("anchor-remove-0").click();
  await expect(page.getByTestId("anchor-item")).toHaveCount(0);
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();
  expect(await page.getByTestId("step-origin").count()).toBe(0);
  await expect(page.getByTestId("total-cost")).toHaveText("4250");
});

test("unanchored request omits anchors and shows no anchor legend", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/align")) requests.push(req.postData() ?? "");
  });
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();
  expect(requests[0]).not.toContain("anchors");
  await expect(page.getByTestId("legend-anchors")).toHaveCount(0);
});

test("compare alternative: checkbox off by default, request/response stay legacy", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/align")) requests.push(req.postData() ?? "");
  });
  await expect(page.getByTestId("compare-alternative")).not.toBeChecked();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();
  // No analysis field in either the request or the rendered legacy result.
  expect(requests[0]).not.toContain("compare_alternative");
  await expect(page.getByTestId("alternative-summary")).toHaveCount(0);
  await expect(page.getByTestId("alternative-empty")).toHaveCount(0);
  await expect(page.getByTestId("alternative-row")).toHaveCount(0);
});

test("compare alternative: locates the first divergence of the golden tie", async ({
  page,
}) => {
  await page.getByTestId("compare-alternative").check();
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("result-panel")).toBeVisible();
  // The primary timeline remains the four-row golden timeline.
  await expect(page.getByTestId("timeline-row")).toHaveCount(4);

  // Equal-cost runner-up selected by the deterministic tie rules.
  await expect(page.getByTestId("alternative-total")).toHaveText("4250");
  await expect(page.getByTestId("alternative-diff")).toHaveText("0");
  const divergence = page.getByTestId("alternative-divergence");
  await expect(divergence).toContainText("left[∅]");
  await expect(divergence).toContainText("right[2]");

  // Exactly one expansion row, directly after primary row #3 (index 2), and
  // the primary row is marked as the divergence point.
  const altRows = page.getByTestId("alternative-row");
  await expect(altRows).toHaveCount(1);
  await expect(altRows.first()).toHaveAttribute("data-row", "2");
  const rows = page.getByTestId("timeline-row");
  await expect(rows.nth(2)).toHaveClass(/row-divergence/);
  await expect(rows.nth(0)).not.toHaveClass(/row-divergence/);
  // The alternative at that row leaves the LEFT side blank and carries the
  // right[2] note, while the primary row carries left[2] and leaves right
  // blank — the swapped gap ordering.
  const altRow = altRows.first();
  const altCells = altRow.locator("td");
  await expect(altCells.nth(1)).toContainText("∅");
  await expect(altCells.nth(3)).toContainText("交接后的补充记录");
  await expect(page.getByTestId("alternative-row-gap")).toContainText("成本差 +0");
});

test("compare alternative: unique empty path shows the empty notice and result", async ({
  page,
}) => {
  await page.getByTestId("clear").click();
  await page.getByTestId("compare-alternative").check();
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("result-panel")).toBeVisible();
  await expect(page.getByTestId("total-cost")).toHaveText("0");
  await expect(page.getByTestId("alternative-empty")).toBeVisible();
  await expect(page.getByTestId("alternative-summary")).toHaveCount(0);
  await expect(page.getByTestId("alternative-row")).toHaveCount(0);
});

test("compare alternative: anchors constrain the runner-up path too", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/align")) requests.push(req.postData() ?? "");
  });
  // Pin left[0] <-> right[0] and ask for the runner-up in one request.
  await page.getByTestId("pick-left-0").click();
  await page.getByTestId("pick-right-0").click();
  await page.getByTestId("compare-alternative").check();
  await page.getByTestId("submit").click();

  await expect(page.getByTestId("result-panel")).toBeVisible();
  // The request carries both the anchors and the comparison flag.
  expect(requests[0]).toContain('"anchors"');
  expect(requests[0]).toContain('"compare_alternative":true');
  // The pinned anchor is row 1 in the primary path, the divergence is at the
  // tail gap swap, and the alternative keeps the anchor row untouched.
  const rows = page.getByTestId("timeline-row");
  await expect(rows.nth(0)).toHaveAttribute("data-origin", "anchor");
  const altRow = page.getByTestId("alternative-row");
  await expect(altRow).toHaveCount(1);
  await expect(altRow.first()).toHaveAttribute("data-row", "2");
  await expect(page.getByTestId("alternative-diff")).toHaveText("0");
});

test("live API: compare_alternative ordering, uniqueness, anchors and legacy bytes", async ({
  request,
}) => {
  const payload = {
    left: [
      { time: 0, text: "a" },
      { time: 4000, text: "b" },
    ],
    right: [
      { time: 4000, text: "a" },
      { time: 8000, text: "b" },
    ],
  };

  // 1) Deterministic strict runner-up under the shared cost/tie rules.
  const resp = await request.post("/api/align", {
    data: { ...payload, compare_alternative: true },
  });
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.total_cost).toBe(7000);
  expect(body.alternative.total_cost).toBe(8000);
  expect(body.alternative.cost_diff).toBe(1000);
  expect(body.alternative.first_divergence).toEqual({ left: 0, right: 0 });
  expect(body.alternative.steps.map((s: { action: string }) => s.action)).toEqual([
    "match",
    "match",
  ]);
  expect(
    body.alternative.steps.reduce(
      (acc: number, s: { cost: number }) => acc + s.cost,
      0,
    ),
  ).toBe(8000);

  // Deterministic: asking again returns the identical alternative.
  const again = await (
    await request.post("/api/align", {
      data: { ...payload, compare_alternative: true },
    })
  ).json();
  expect(again.alternative).toEqual(body.alternative);

  // 2) Unique legal path (empty input) -> null alternative, normal optimum.
  const empty = await (
    await request.post("/api/align", {
      data: { left: [], right: [], compare_alternative: true },
    })
  ).json();
  expect(empty.total_cost).toBe(0);
  expect(empty.alternative).toBeNull();

  // Fully pinning anchors make the path unique as well, and both fields
  // coexist in one response.
  const pinned = await (
    await request.post("/api/align", {
      data: {
        left: [{ time: 1, text: "a" }],
        right: [{ time: 2, text: "a" }],
        anchors: [{ left: 0, right: 0 }],
        compare_alternative: true,
      },
    })
  ).json();
  expect(pinned.anchors).toEqual([{ left: 0, right: 0 }]);
  expect(pinned.alternative).toBeNull();

  // 3) Anchors constrain the alternative: the anchor row is identical in
  // both timelines and the runner-up still honours it.
  const golden = {
    left: [
      { time: 0, text: "g" },
      { time: 4200, text: "p" },
      { time: 9000, text: "t" },
    ],
    right: [
      { time: 150, text: "g" },
      { time: 4100, text: "p" },
      { time: 12000, text: "h" },
    ],
  };
  const anchored = await (
    await request.post("/api/align", {
      data: {
        ...golden,
        anchors: [{ left: 0, right: 0 }],
        compare_alternative: true,
      },
    })
  ).json();
  expect(anchored.alternative.cost_diff).toBe(0);
  const primaryAnchor = anchored.steps.filter(
    (s: { origin?: string }) => s.origin === "anchor",
  );
  const altAnchor = anchored.alternative.steps.filter(
    (s: { origin?: string }) => s.origin === "anchor",
  );
  expect(altAnchor).toEqual(primaryAnchor);
  expect(altAnchor).toHaveLength(1);

  // 4) Legacy requests add no analysis field to the response structure.
  const legacy = await (await request.post("/api/align", { data: payload })).text();
  expect(legacy).not.toContain("alternative");
  const legacyFalse = await (
    await request.post("/api/align", {
      data: { ...payload, compare_alternative: false },
    })
  ).text();
  expect(legacyFalse).toBe(legacy);
});

test("live API: valid anchors fix the pairs, crossing fails once, cancelling restores", async ({
  request,
}) => {
  const payload = {
    left: [
      { time: 0, text: "a" },
      { time: 5000, text: "b" },
      { time: 9000, text: "c" },
    ],
    right: [
      { time: 10, text: "a" },
      { time: 4000, text: "x" },
      { time: 5200, text: "b" },
    ],
  };

  // 1) No anchors: legacy shape (no anchors field, no per-row origin).
  const free = await request.post("/api/align", { data: payload });
  expect(free.status()).toBe(200);
  const freeBody = await free.json();
  expect(freeBody.anchors).toBeUndefined();
  expect(freeBody.steps.every((s: unknown) => !("origin" in (s as object)))).toBe(true);

  // 2) Valid anchors are fixed into the result and tagged.
  const anchored = await request.post("/api/align", {
    data: { ...payload, anchors: [{ left: 0, right: 0 }, { left: 2, right: 1 }] },
  });
  expect(anchored.status()).toBe(200);
  const anchoredBody = await anchored.json();
  expect(anchoredBody.anchors).toEqual([
    { left: 0, right: 0 },
    { left: 2, right: 1 },
  ]);
  const anchorRows = anchoredBody.steps.filter(
    (s: { origin?: string }) => s.origin === "anchor",
  );
  expect(anchorRows).toHaveLength(2);
  expect(anchorRows.map((s: { left: { time: number } }) => s.left.time)).toEqual([
    0, 9000,
  ]);
  // Per-step costs still replay to the exact total.
  expect(
    anchoredBody.steps.reduce(
      (acc: number, s: { cost: number }) => acc + s.cost,
      0,
    ),
  ).toBe(anchoredBody.total_cost);

  // 3) Crossing anchors: exactly one 422 at the first offending anchor.
  const crossed = await request.post("/api/align", {
    data: {
      ...payload,
      anchors: [
        { left: 0, right: 0 },
        { left: 2, right: 2 },
        { left: 1, right: 1 },
      ],
    },
  });
  expect(crossed.status()).toBe(422);
  const crossedBody = await crossed.json();
  expect(Object.keys(crossedBody).sort()).toEqual(["error", "path"]);
  expect(crossedBody.path).toBe("anchors[2].left");

  // 4) Cancelling anchors (re-request without them) restores the free result.
  const restored = await request.post("/api/align", { data: payload });
  expect(await restored.json()).toEqual(freeBody);
});

// --------------------------------------------------------------------------- //
// Lead-declared term correspondences (term_pairs).
// --------------------------------------------------------------------------- //

test.describe("term pairs", () => {
  test("lead adds a term correspondence, penalty is waived and rows are tagged", async ({
    page,
  }) => {
    const left = JSON.stringify([
      { time: 0, text: " 人工智能 " },
      { time: 9000, text: "结束语" },
    ]);
    const right = JSON.stringify([
      { time: 100, text: " AI " },
      { time: 9200, text: "结束语" },
    ]);
    await page.getByTestId("input-left").fill(left);
    await page.getByTestId("input-right").fill(right);

    // Before declaring the correspondence, mismatching text would cost +3000.
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    await expect(page.getByTestId("total-cost")).toHaveText("3300");

    // Declare the pair with leading/trailing spaces; "exact" is verbatim, so
    // every declared character is preserved and sent character-for-character.
    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/align")) requests.push(req.postData() ?? "");
    });
    await page.getByTestId("term-input-left").fill(" 人工智能 ");
    await page.getByTestId("term-input-right").fill(" AI ");
    await page.getByTestId("term-add").click();
    const items = page.getByTestId("term-item");
    await expect(items).toHaveCount(1);
    // The declared spaces are kept in the list row (no trimming on save).
    expect(
      await items.first().getByTestId("term-item-left").textContent(),
    ).toBe(" 人工智能 ");
    expect(
      await items.first().getByTestId("term-item-right").textContent(),
    ).toBe(" AI ");
    // Both draft fields start the next pair blank.
    await expect(page.getByTestId("term-input-left")).toHaveValue("");
    await expect(page.getByTestId("term-input-right")).toHaveValue("");

    await page.getByTestId("submit").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();

    // The request carries the texts character-for-character, spaces included.
    expect(requests.at(-1)).toContain(
      `"term_pairs":[{"left_text":" 人工智能 ","right_text":" AI "}]`,
    );

    const rows = page.getByTestId("timeline-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-term-hit", "true");
    await expect(rows.nth(1)).toHaveAttribute("data-term-hit", "false");
    // |0 - 100| = 100 with the 3000 mismatch penalty waived; totals replay.
    await expect(page.getByTestId("step-cost").nth(0)).toHaveText("100");
    await expect(page.getByTestId("step-cumulative").nth(0)).toHaveText("100");
    await expect(page.getByTestId("step-cumulative").nth(1)).toHaveText("300");
    await expect(page.getByTestId("total-cost")).toHaveText("300");
    // The hit row's source is "术语等价" and its recomputation explains it.
    await expect(page.getByTestId("step-term")).toHaveText("术语等价");
    await expect(page.getByTestId("step-explain").nth(0)).toContainText(
      "术语等价",
    );
    await expect(page.getByTestId("step-explain").nth(0)).toContainText("免除 3000");
    await expect(page.getByTestId("legend-terms")).toBeVisible();
  });

  test("a half-typed one-sided term draft is discarded by load-sample and clear", async ({
    page,
  }) => {
    // Only one side is filled: the pair was never added, but the draft must
    // not survive a page reset.
    await page.getByTestId("term-input-left").fill("只写了左侧");
    await page.getByTestId("clear").click();
    await expect(page.getByTestId("term-input-left")).toHaveValue("");
    await expect(page.getByTestId("term-input-right")).toHaveValue("");
    await expect(page.getByTestId("term-empty")).toBeVisible();

    // Loading the sample resets a right-only draft the same way.
    await page.getByTestId("term-input-right").fill(" AI ");
    await page.getByTestId("sample").click();
    await expect(page.getByTestId("term-input-left")).toHaveValue("");
    await expect(page.getByTestId("term-input-right")).toHaveValue("");
    await expect(page.getByTestId("term-empty")).toBeVisible();
  });

  test("a declared pair with identical left/right text marks the equal-text match", async ({
    page,
  }) => {
    // Both interpreters wrote the same text; the lead nonetheless declares
    // that text as an accepted term pair for this review.
    const same = JSON.stringify([{ time: 0, text: "新产品将于下月上市" }]);
    await page.getByTestId("input-left").fill(same);
    await page.getByTestId("input-right").fill(
      JSON.stringify([{ time: 100, text: "新产品将于下月上市" }]),
    );
    await page.getByTestId("term-input-left").fill("新产品将于下月上市");
    await page.getByTestId("term-input-right").fill("新产品将于下月上市");
    await page.getByTestId("term-add").click();
    await page.getByTestId("submit").click();

    await expect(page.getByTestId("result-panel")).toBeVisible();
    const row = page.getByTestId("timeline-row");
    await expect(row).toHaveCount(1);
    // The equal-text match is attributed to the declared pair as its source.
    await expect(row).toHaveAttribute("data-term-hit", "true");
    await expect(page.getByTestId("step-term")).toHaveText("术语等价");
    await expect(page.getByTestId("step-cost")).toHaveText("100");
    await expect(page.getByTestId("total-cost")).toHaveText("100");
  });

  test("deleting every term pair restores the original penalized result", async ({
    page,
  }) => {
    const left = JSON.stringify([{ time: 0, text: "人工智能" }]);
    const right = JSON.stringify([{ time: 100, text: "AI" }]);
    await page.getByTestId("input-left").fill(left);
    await page.getByTestId("input-right").fill(right);

    await page.getByTestId("term-input-left").fill("人工智能");
    await page.getByTestId("term-input-right").fill("AI");
    await page.getByTestId("term-add").click();
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("total-cost")).toHaveText("100");
    await expect(page.getByTestId("step-term")).toHaveText("术语等价");

    // Delete the only correspondence and realign: the 3000 penalty is back.
    await page.getByTestId("term-remove-0").click();
    await expect(page.getByTestId("term-item")).toHaveCount(0);
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    await expect(page.getByTestId("total-cost")).toHaveText("3100");
    expect(await page.getByTestId("step-term").count()).toBe(0);
  });

  test("a same-side duplicate mapping is flagged once and blocks no timeline", async ({
    page,
  }) => {
    const addPair = async (l: string, r: string) => {
      await page.getByTestId("term-input-left").fill(l);
      await page.getByTestId("term-input-right").fill(r);
      await page.getByTestId("term-add").click();
    };
    await addPair("人工智能", "AI");
    await addPair("人工智能", "机器学习");
    const items = page.getByTestId("term-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toHaveClass(/invalid/);
    await expect(page.getByTestId("error-path")).toContainText(
      "term_pairs[1].left_text",
    );
    // The candidate stays listed and no result is shown.
    expect(await page.getByTestId("result-panel").count()).toBe(0);

    // Removing the conflicting row clears the single error.
    await page.getByTestId("term-remove-1").click();
    await expect(page.getByTestId("error-banner")).toHaveCount(0);
  });

  test("a conflict added after a valid timeline keeps that timeline", async ({
    page,
  }) => {
    const left = JSON.stringify([{ time: 0, text: "人工智能" }]);
    const right = JSON.stringify([{ time: 100, text: "AI" }]);
    await page.getByTestId("input-left").fill(left);
    await page.getByTestId("input-right").fill(right);

    const addPair = async (l: string, r: string) => {
      await page.getByTestId("term-input-left").fill(l);
      await page.getByTestId("term-input-right").fill(r);
      await page.getByTestId("term-add").click();
    };
    await addPair("人工智能", "AI");
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    await expect(page.getByTestId("total-cost")).toHaveText("100");

    // After the valid timeline is shown, declaring a conflicting pair must
    // keep that timeline on screen while flagging the single conflict.
    await addPair("人工智能", "机器学习");
    await expect(page.getByTestId("result-panel")).toBeVisible();
    await expect(page.getByTestId("timeline-row")).toHaveCount(1);
    await expect(page.getByTestId("total-cost")).toHaveText("100");
    await expect(page.getByTestId("step-term")).toHaveText("术语等价");
    await expect(page.getByTestId("error-path")).toContainText(
      "term_pairs[1].left_text",
    );

    // Resubmitting while the conflict exists is blocked (single request sent)
    // and the previous timeline survives.
    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/align")) requests.push(req.method());
    });
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("error-path")).toContainText(
      "term_pairs[1].left_text",
    );
    expect(requests).toHaveLength(0);
    await expect(page.getByTestId("result-panel")).toBeVisible();

    // Deleting the conflict clears the banner while the timeline remains.
    await page.getByTestId("term-remove-1").click();
    await expect(page.getByTestId("error-banner")).toHaveCount(0);
    await expect(page.getByTestId("result-panel")).toBeVisible();
    await expect(page.getByTestId("total-cost")).toHaveText("100");
  });
});

test("live API: term pairs waive the penalty only on exact hits and stay legacy-compatible", async ({
  request,
}) => {
  const payload = {
    left: [
      { time: 0, text: "人工智能" },
      { time: 9000, text: "结束语" },
    ],
    right: [
      { time: 100, text: "AI" },
      { time: 9200, text: "结束语" },
    ],
  };

  // 1) Legacy requests (absent and empty array) are identical and carry no
  //    term fields.
  const legacy = await (await request.post("/api/align", { data: payload })).text();
  expect(legacy).not.toContain("term_pairs");
  const empty = await (
    await request.post("/api/align", { data: { ...payload, term_pairs: [] } })
  ).text();
  expect(empty).toBe(legacy);

  // 2) An exact hit waives the 3000 penalty and tags that match row only.
  const hit = await (
    await request.post("/api/align", {
      data: {
        ...payload,
        term_pairs: [{ left_text: "人工智能", right_text: "AI" }],
      },
    })
  ).json();
  expect(hit.total_cost).toBe(300);
  expect(hit.term_pairs).toEqual([
    { left_text: "人工智能", right_text: "AI" },
  ]);
  expect(hit.steps[0].cost).toBe(100);
  expect(hit.steps[0].term_pair).toEqual({
    left_text: "人工智能",
    right_text: "AI",
  });
  expect("term_pair" in hit.steps[1]).toBe(false);

  // 3) A near miss (substring, not verbatim) keeps the mismatch penalty.
  const miss = await (
    await request.post("/api/align", {
      data: {
        ...payload,
        term_pairs: [{ left_text: "人工", right_text: "AI" }],
      },
    })
  ).json();
  expect(miss.total_cost).toBe(3300);
  expect("term_pair" in miss.steps[0]).toBe(false);

  // 3b) Declared spaces are part of the term: an exact verbatim hit waives
  //     the penalty, while notes without those spaces do not hit.
  const spaced = await (
    await request.post("/api/align", {
      data: {
        left: [{ time: 0, text: " 人工智能 " }],
        right: [{ time: 100, text: " AI " }],
        term_pairs: [{ left_text: " 人工智能 ", right_text: " AI " }],
      },
    })
  ).json();
  expect(spaced.term_pairs).toEqual([
    { left_text: " 人工智能 ", right_text: " AI " },
  ]);
  expect(spaced.steps[0].term_pair).toEqual({
    left_text: " 人工智能 ",
    right_text: " AI ",
  });
  expect(spaced.total_cost).toBe(100);

  // 3c) A declared pair whose two sides are identical marks the equal-text
  //     match row with that pair as its source.
  const equalPair = await (
    await request.post("/api/align", {
      data: {
        left: [{ time: 0, text: "新产品将于下月上市" }],
        right: [{ time: 100, text: "新产品将于下月上市" }],
        term_pairs: [
          {
            left_text: "新产品将于下月上市",
            right_text: "新产品将于下月上市",
          },
        ],
      },
    })
  ).json();
  expect(equalPair.steps[0].term_pair).toEqual({
    left_text: "新产品将于下月上市",
    right_text: "新产品将于下月上市",
  });

  // 4) A same-side duplicate mapping fails exactly once.
  const conflict = await request.post("/api/align", {
    data: {
      left: [],
      right: [],
      term_pairs: [
        { left_text: "a", right_text: "x" },
        { left_text: "a", right_text: "y" },
      ],
    },
  });
  expect(conflict.status()).toBe(422);
  const conflictBody = await conflict.json();
  expect(Object.keys(conflictBody).sort()).toEqual(["error", "path"]);
  expect(conflictBody.path).toBe("term_pairs[1].left_text");

  // 5) The term rule applies together with anchors and the alternative.
  const golden = {
    left: [
      { time: 0, text: "g" },
      { time: 4200, text: "p" },
      { time: 9000, text: "t" },
    ],
    right: [
      { time: 150, text: "G" },
      { time: 4100, text: "P" },
      { time: 12000, text: "h" },
    ],
  };
  const combined = await (
    await request.post("/api/align", {
      data: {
        ...golden,
        anchors: [{ left: 0, right: 0 }],
        term_pairs: [
          { left_text: "g", right_text: "G" },
          { left_text: "p", right_text: "P" },
        ],
        compare_alternative: true,
      },
    })
  ).json();
  const anchorRow = combined.steps.find(
    (s: { origin?: string }) => s.origin === "anchor",
  );
  expect(anchorRow.cost).toBe(150);
  expect(anchorRow.term_pair).toEqual({ left_text: "g", right_text: "G" });
  // The tail gap-order tie keeps a runner-up; it is ranked under the same
  // synonym cost, and the forced anchor row is identical in both paths.
  expect(combined.alternative).not.toBeNull();
  expect(combined.alternative.cost_diff).toBe(0);
  const altAnchor = combined.alternative.steps.find(
    (s: { origin?: string }) => s.origin === "anchor",
  );
  expect(altAnchor.term_pair).toEqual({ left_text: "g", right_text: "G" });
  expect(altAnchor).toEqual(anchorRow);
});
