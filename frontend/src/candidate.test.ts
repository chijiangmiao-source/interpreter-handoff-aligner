import { describe, expect, it } from "vitest";
import {
  stepIndexFromPath,
  toCandidateRows,
  validateCandidate,
} from "./candidate";

const matchStep = {
  action: "match",
  left: { time: 0, text: "a" },
  right: { time: 100, text: "a" },
  cost: 100,
  cumulative_cost: 100,
};

function candidate(steps: unknown[], totalCost: unknown = 0) {
  return { steps, total_cost: totalCost };
}

describe("validateCandidate", () => {
  it("accepts an empty timeline", () => {
    expect(validateCandidate(candidate([], 0))).toBeNull();
  });

  it("accepts the full golden candidate with origins and term pairs", () => {
    const full = {
      steps: [
        { ...matchStep, origin: "anchor", term_pair: { left_text: "a", right_text: "b" } },
        {
          action: "left_gap",
          left: null,
          right: { time: 200, text: "b" },
          cost: 2000,
          cumulative_cost: 2100,
          origin: "auto",
        },
        {
          action: "right_gap",
          left: { time: 300, text: "c" },
          right: null,
          cost: 2000,
          cumulative_cost: 4100,
          term_pair: null,
        },
      ],
      total_cost: 4100,
    };
    expect(validateCandidate(full)).toBeNull();
  });

  it("rejects a non-object candidate", () => {
    const issue = validateCandidate([]);
    expect(issue?.path).toBe("candidate");
    expect(issue?.stepIndex).toBe(-1);
  });

  it("rejects missing/non-array steps", () => {
    expect(validateCandidate({ total_cost: 0 })?.path).toBe("candidate.steps");
    expect(validateCandidate({ steps: {}, total_cost: 0 })?.path).toBe(
      "candidate.steps",
    );
  });

  it("rejects a missing or bad total_cost", () => {
    expect(validateCandidate({ steps: [] })?.path).toBe("candidate.total_cost");
    expect(validateCandidate(candidate([], "0"))?.path).toBe(
      "candidate.total_cost",
    );
    expect(validateCandidate(candidate([], -1))?.path).toBe(
      "candidate.total_cost",
    );
  });

  it("rejects a non-object step", () => {
    const issue = validateCandidate(candidate([1], 0));
    expect(issue?.path).toBe("candidate.steps[0]");
    expect(issue?.stepIndex).toBe(0);
  });

  it("rejects unknown step fields", () => {
    const issue = validateCandidate(
      candidate([{ ...matchStep, who: 1 }], 100),
    );
    expect(issue?.path).toBe("candidate.steps[0].who");
    expect(issue?.stepIndex).toBe(0);
  });

  it("rejects a missing or unknown action", () => {
    const { action: _omitted, ...noAction } = matchStep;
    expect(validateCandidate(candidate([noAction], 100))?.path).toBe(
      "candidate.steps[0].action",
    );
    expect(
      validateCandidate(candidate([{ ...matchStep, action: "delete" }], 100))
        ?.path,
    ).toBe("candidate.steps[0].action");
  });

  it("requires both side slots, null when blank", () => {
    const { left: _omitted, ...noLeft } = matchStep;
    expect(validateCandidate(candidate([noLeft], 100))?.path).toBe(
      "candidate.steps[0].left",
    );
  });

  it("validates note slots structurally", () => {
    expect(
      validateCandidate(candidate([{ ...matchStep, left: "x" }], 100))?.path,
    ).toBe("candidate.steps[0].left");
    expect(
      validateCandidate(
        candidate([{ ...matchStep, left: { time: 1.5, text: "a" } }], 100),
      )?.path,
    ).toBe("candidate.steps[0].left.time");
    expect(
      validateCandidate(
        candidate([{ ...matchStep, left: { time: 1, text: "" } }], 100),
      )?.path,
    ).toBe("candidate.steps[0].left.text");
    expect(
      validateCandidate(
        candidate([{ ...matchStep, left: { time: 1, text: "a", x: 2 } }], 100),
      )?.path,
    ).toBe("candidate.steps[0].left.x");
  });

  it("accepts bigint note timestamps", () => {
    expect(
      validateCandidate(
        candidate(
          [
            {
              ...matchStep,
              left: { time: 9007199254740993n, text: "a" },
              right: { time: 9007199254740994n, text: "a" },
              cost: 1n,
              cumulative_cost: 1n,
            },
          ],
          1n,
        ),
      ),
    ).toBeNull();
  });

  it("rejects non-integer/negative costs", () => {
    expect(
      validateCandidate(candidate([{ ...matchStep, cost: -1 }], 100))?.path,
    ).toBe("candidate.steps[0].cost");
    expect(
      validateCandidate(candidate([{ ...matchStep, cost: "1" }], 100))?.path,
    ).toBe("candidate.steps[0].cost");
    expect(
      validateCandidate(
        candidate([{ ...matchStep, cumulative_cost: true }], 100),
      )?.path,
    ).toBe("candidate.steps[0].cumulative_cost");
  });

  it("rejects a bad origin", () => {
    expect(
      validateCandidate(candidate([{ ...matchStep, origin: "human" }], 100))
        ?.path,
    ).toBe("candidate.steps[0].origin");
  });

  it("validates the embedded term_pair", () => {
    expect(
      validateCandidate(
        candidate([{ ...matchStep, term_pair: "x" }], 100),
      )?.path,
    ).toBe("candidate.steps[0].term_pair");
    expect(
      validateCandidate(
        candidate([{ ...matchStep, term_pair: { left_text: "a" } }], 100),
      )?.path,
    ).toBe("candidate.steps[0].term_pair.right_text");
    expect(
      validateCandidate(
        candidate(
          [{ ...matchStep, term_pair: { left_text: "a", right_text: "" } }],
          100,
        ),
      )?.path,
    ).toBe("candidate.steps[0].term_pair.right_text");
    // An explicit null marker is fine.
    expect(
      validateCandidate(candidate([{ ...matchStep, term_pair: null }], 100)),
    ).toBeNull();
  });

  it("always points at the first step only", () => {
    const issue = validateCandidate(
      candidate(
        [
          matchStep,
          { ...matchStep, cost: "bad" },
          { action: "nope", left: null, right: null, cost: 0, cumulative_cost: 0 },
        ],
        100,
      ),
    );
    expect(issue?.path).toBe("candidate.steps[1].cost");
  });
});

describe("stepIndexFromPath", () => {
  it("extracts the step index", () => {
    expect(stepIndexFromPath("candidate.steps[2].cost")).toBe(2);
    expect(stepIndexFromPath("candidate.steps[0]")).toBe(0);
    expect(stepIndexFromPath("candidate.total_cost")).toBe(-1);
    expect(stepIndexFromPath("left[1].time")).toBe(-1);
  });
});

describe("toCandidateRows", () => {
  it("extracts best-effort rows for the preview", () => {
    const rows = toCandidateRows(
      candidate([
        matchStep,
        { action: "left_gap", left: null, right: null, cost: 0, cumulative_cost: 0 },
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe("match");
    expect(rows[0].left).toEqual({ time: 0, text: "a" });
    expect(rows[1].right).toBeNull();
  });

  it("returns nothing for a non-candidate value", () => {
    expect(toCandidateRows(null)).toEqual([]);
    expect(toCandidateRows({})).toEqual([]);
  });
});
