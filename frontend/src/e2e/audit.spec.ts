import { expect, test } from "@playwright/test";

/**
 * Real full-stack integration for the independent "核验时间轴" workspace:
 * the lead pastes an externally hand-adjusted candidate and verifies it
 * against the CURRENT left/right notes, anchors and term pairs. These tests
 * drive the built frontend against the live FastAPI process.
 */

async function alignAndFillCandidate(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("result-panel")).toBeVisible();
  await page.getByTestId("audit-fill").click();
  await expect(page.getByTestId("audit-input")).toHaveValue(/.+/);
}

test.describe("audit workspace (browser)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("a legal candidate passes with the conclusion and per-row recomputation", async ({
    page,
  }) => {
    await alignAndFillCandidate(page);
    await page.getByTestId("audit-submit").click();

    await expect(page.getByTestId("audit-pass")).toBeVisible();
    await expect(page.getByTestId("audit-pass-summary")).toContainText(
      "完整、按序且只使用一次",
    );
    await expect(page.getByTestId("audit-total-cost")).toHaveText("4250");
    const details = page.getByTestId("audit-detail-row");
    await expect(details).toHaveCount(4);
    await expect(page.getByTestId("audit-detail-cost").nth(2)).toHaveText("2000");
    await expect(page.getByTestId("audit-detail-cumulative").nth(3)).toHaveText(
      "4250",
    );
    await expect(page.getByTestId("audit-error-banner")).toHaveCount(0);
  });

  test("a wrong single-step cost is rejected and the candidate row is localized", async ({
    page,
  }) => {
    await alignAndFillCandidate(page);

    // First verification passes (this becomes the last passing report).
    await page.getByTestId("audit-submit").click();
    await expect(page.getByTestId("audit-pass")).toBeVisible();

    // Tamper with row 3 (index 2): its gap cost becomes 9999.
    const value = await page.getByTestId("audit-input").inputValue();
    const candidate = JSON.parse(value);
    expect(candidate.steps[2].action).toBe("right_gap");
    candidate.steps[2].cost = 9999;
    await page.getByTestId("audit-input").fill(JSON.stringify(candidate));
    await page.getByTestId("audit-submit").click();

    const banner = page.getByTestId("audit-error-banner");
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("audit-error-path")).toContainText(
      "candidate.steps[2].cost",
    );
    await expect(page.getByTestId("audit-expected")).toHaveText("2000");
    await expect(page.getByTestId("audit-actual")).toHaveText("9999");

    // The pasted content is retained and the offending preview row flagged.
    expect(await page.getByTestId("audit-input").inputValue()).toContain("9999");
    const rows = page.getByTestId("audit-candidate-row");
    await expect(rows.nth(2)).toHaveClass(/invalid/);
    await expect(rows.nth(2)).toContainText("首个差异行");
    // A failed verification never replaces the last passing report.
    await expect(page.getByTestId("audit-pass")).toBeVisible();
  });

  test("a duplicated original note is localized on the repeated candidate row", async ({
    page,
  }) => {
    await alignAndFillCandidate(page);
    const value = await page.getByTestId("audit-input").inputValue();
    const candidate = JSON.parse(value);
    // Repeat the right_gap row (which carries left[2]) before the tail gap.
    candidate.steps.splice(3, 0, { ...candidate.steps[2] });
    await page.getByTestId("audit-input").fill(JSON.stringify(candidate));

    await page.getByTestId("audit-submit").click();

    await expect(page.getByTestId("audit-error-banner")).toBeVisible();
    await expect(page.getByTestId("audit-error-path")).toContainText(
      "candidate.steps[3].left",
    );
    await expect(page.getByTestId("audit-actual")).toContainText("left[2]");
    const rows = page.getByTestId("audit-candidate-row");
    await expect(rows.nth(3)).toHaveClass(/invalid/);
    // The pasted candidate (5 rows) is still in the box.
    expect(JSON.parse(await page.getByTestId("audit-input").inputValue()).steps).toHaveLength(
      5,
    );
  });

  test("a missing original note is reported at the end of the candidate", async ({
    page,
  }) => {
    await alignAndFillCandidate(page);
    const value = await page.getByTestId("audit-input").inputValue();
    const candidate = JSON.parse(value);
    // Drop the trailing left_gap row but leave total_cost as the old total:
    // conservation (the unused right note) is reported before the total.
    candidate.steps.pop();
    await page.getByTestId("audit-input").fill(JSON.stringify(candidate));

    await page.getByTestId("audit-submit").click();

    await expect(page.getByTestId("audit-error-banner")).toBeVisible();
    await expect(page.getByTestId("audit-error-path")).toContainText(
      "candidate.steps[3]",
    );
    await expect(page.getByTestId("audit-expected")).toContainText("交接后的补充记录");
    await expect(page.getByTestId("audit-actual")).toHaveText("null");
  });

  test("malformed candidate JSON is reported locally and the paste is kept", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/audit")) requests.push(req.url());
    });
    await page.getByTestId("audit-input").fill('{"steps": [,],');
    await page.getByTestId("audit-submit").click();
    await expect(page.getByTestId("audit-error-banner")).toBeVisible();
    await expect(page.getByTestId("audit-input-mark")).toBeVisible();
    expect(requests).toHaveLength(0);
    await expect(page.getByTestId("audit-input")).toHaveValue('{"steps": [,],');
  });

  test("anchors and term pairs are adopted: a synonym candidate recomputes fully", async ({
    page,
  }) => {
    const left = JSON.stringify([
      { time: 0, text: "人工智能" },
      { time: 9000, text: "结束语" },
    ]);
    const right = JSON.stringify([
      { time: 100, text: "AI" },
      { time: 9200, text: "结束语" },
    ]);
    await page.getByTestId("input-left").fill(left);
    await page.getByTestId("input-right").fill(right);
    // Pin the opening pair and declare its terminology correspondence.
    await page.getByTestId("pick-left-0").click();
    await page.getByTestId("pick-right-0").click();
    await page.getByTestId("term-input-left").fill("人工智能");
    await page.getByTestId("term-input-right").fill("AI");
    await page.getByTestId("term-add").click();

    await page.getByTestId("submit").click();
    await expect(page.getByTestId("result-panel")).toBeVisible();
    await expect(page.getByTestId("total-cost")).toHaveText("300");

    await page.getByTestId("audit-fill").click();
    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/audit")) requests.push(req.postData() ?? "");
    });
    await page.getByTestId("audit-submit").click();

    await expect(page.getByTestId("audit-pass")).toBeVisible();
    await expect(page.getByTestId("audit-total-cost")).toHaveText("300");
    // The first row is the pinned anchor AND the term hit.
    const firstRow = page.getByTestId("audit-detail-row").first();
    await expect(firstRow).toContainText("人工锚点");
    await expect(firstRow).toContainText("术语等价");
    await expect(firstRow).toContainText("left[0]");
    await expect(page.getByTestId("audit-detail-basis").first()).toContainText(
      "免除 3000",
    );
    expect(requests[0]).toContain('"anchors":[{"left":0,"right":0}]');
    expect(requests[0]).toContain(
      '"term_pairs":[{"left_text":"人工智能","right_text":"AI"}]',
    );
  });

  test("changing the notes after a pass retires the passing report but keeps the paste", async ({
    page,
  }) => {
    await alignAndFillCandidate(page);
    await page.getByTestId("audit-submit").click();
    await expect(page.getByTestId("audit-pass")).toBeVisible();

    await page.getByTestId("input-left").fill(JSON.stringify([{ time: 1, text: "新笔记" }]));
    await expect(page.getByTestId("audit-pass")).toHaveCount(0);
    await expect(page.getByTestId("audit-input")).toHaveValue(/.+/);
  });
});

test.describe("audit live API", () => {
  const left = [
    { time: 0, text: "各位媒体朋友下午好" },
    { time: 4200, text: "新产品将于下月上市" },
    { time: 9000, text: "感谢各位的提问" },
  ];
  const right = [
    { time: 150, text: "各位媒体朋友下午好" },
    { time: 4100, text: "新产品将于下月上市" },
    { time: 12000, text: "交接后的补充记录" },
  ];

  async function golden(request: import("@playwright/test").APIRequestContext) {
    const body = (await (
      await request.post("/api/align", { data: { left, right } })
    ).json()) as { steps: Record<string, unknown>[]; total_cost: number };
    return body;
  }

  test("a legal candidate passes with row details", async ({ request }) => {
    const g = await golden(request);
    const resp = await request.post("/api/audit", {
      data: { left, right, candidate: { steps: g.steps, total_cost: g.total_cost } },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.total_cost).toBe(4250);
    expect(body.consumed).toEqual({ left: 3, right: 3 });
    expect(body.steps.map((s: { expected_cost: number }) => s.expected_cost)).toEqual([
      150, 100, 2000, 2000,
    ]);
    expect(
      body.steps.map((s: { expected_cumulative_cost: number }) => s.expected_cumulative_cost),
    ).toEqual([150, 250, 2250, 4250]);
  });

  test("structural failures keep the single-error envelope", async ({ request }) => {
    const missing = await request.post("/api/audit", {
      data: { left, right },
    });
    expect(missing.status()).toBe(422);
    const missingBody = await missing.json();
    expect(Object.keys(missingBody).sort()).toEqual(["error", "path"]);
    expect(missingBody.path).toBe("candidate");

    const bad = await request.post("/api/audit", {
      data: {
        left,
        right,
        candidate: {
          steps: [
            {
              action: "fly",
              left: null,
              right: null,
              cost: 0,
              cumulative_cost: 0,
            },
          ],
          total_cost: 0,
        },
      },
    });
    expect(bad.status()).toBe(422);
    const badBody = await bad.json();
    expect(Object.keys(badBody).sort()).toEqual(["error", "path"]);
    expect(badBody.path).toBe("candidate.steps[0].action");
  });

  test("missing and duplicated notes are localized with expected/actual", async ({
    request,
  }) => {
    const g = await golden(request);

    const dropped = {
      steps: g.steps.slice(0, 3),
      total_cost: g.total_cost,
    };
    const resp1 = await request.post("/api/audit", {
      data: { left, right, candidate: dropped },
    });
    expect(resp1.status()).toBe(422);
    const b1 = await resp1.json();
    expect(Object.keys(b1).sort()).toEqual(["actual", "error", "expected", "path"]);
    expect(b1.path).toBe("candidate.steps[3]");
    expect(b1.expected).toEqual({ time: 12000, text: "交接后的补充记录" });
    expect(b1.actual).toBeNull();

    const repeatedSteps = [...g.steps];
    repeatedSteps.splice(3, 0, { ...g.steps[2] });
    const resp2 = await request.post("/api/audit", {
      data: { left, right, candidate: { steps: repeatedSteps, total_cost: 6250 } },
    });
    expect(resp2.status()).toBe(422);
    const b2 = await resp2.json();
    expect(b2.path).toBe("candidate.steps[3].left");
    expect(b2.actual).toContain("left[2]");
  });

  test("a wrong single-step cost is rejected with both values", async ({ request }) => {
    const g = await golden(request);
    g.steps[2].cost = 9999;
    const resp = await request.post("/api/audit", {
      data: { left, right, candidate: { steps: g.steps, total_cost: g.total_cost } },
    });
    expect(resp.status()).toBe(422);
    const body = await resp.json();
    expect(body.path).toBe("candidate.steps[2].cost");
    expect(body.expected).toBe(2000);
    expect(body.actual).toBe(9999);
  });

  test("anchors and term pairs make the candidate recompute end to end", async ({
    request,
  }) => {
    const data = {
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
      anchors: [{ left: 0, right: 0 }],
      term_pairs: [
        { left_text: "g", right_text: "G" },
        { left_text: "p", right_text: "P" },
      ],
    };
    const aligned = (await (await request.post("/api/align", { data })).json()) as {
      steps: unknown[];
      total_cost: number;
    };
    const resp = await request.post("/api/audit", {
      data: { ...data, candidate: { steps: aligned.steps, total_cost: aligned.total_cost } },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.steps[0].origin).toBe("anchor");
    expect(body.steps[0].expected_term_pair).toEqual({
      left_text: "g",
      right_text: "G",
    });
    expect(body.steps[0].expected_cost).toBe(150);
  });

  test("/api/align is unchanged by the new endpoint", async ({ request }) => {
    const a = await (await request.post("/api/align", { data: { left, right } })).json();
    const g = await golden(request);
    const b = await (await request.post("/api/align", { data: { left, right } })).json();
    expect(a).toEqual(g);
    expect(b).toEqual(a);
    expect("candidate" in a).toBe(false);
  });
});
