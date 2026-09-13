import { parseLocated } from "./jsonLocations";
import type { AlignResponse, Anchor, ApiError } from "./types";

export class AlignRequestError extends Error {
  path: string;
  status: number;

  constructor(message: string, path: string, status: number) {
    super(message);
    this.name = "AlignRequestError";
    this.path = path;
    this.status = status;
  }
}

/**
 * Extract the exact source text of the root JSON value (the array),
 * trimming surrounding whitespace. Keeping the raw digits is what lets
 * timestamps above Number.MAX_SAFE_INTEGER reach the server unrounded;
 * re-serializing through `JSON.stringify` would either throw on bigint or
 * silently lose precision.
 */
export function rootRawText(text: string): string {
  const doc = parseLocated(text);
  const range = doc.ranges.get("");
  if (!range) throw new Error("empty JSON document");
  return text.slice(range.start, range.end);
}

/**
 * POST the two raw JSON array texts to the alignment API.
 *
 * - `anchors` are optional human-confirmed pairs of 0-based record indices;
 *   they are ordinary small integers, so safe to serialize with the normal
 *   JSON serializer (unlike the raw, possibly huge-integer array text);
 * - `compareAlternative` adds `compare_alternative: true`, asking the server
 *   for the strictly second-best complete path; it is omitted entirely when
 *   false/undefined, keeping the legacy request byte-for-byte identical;
 * - network/non-JSON-HTTP failures become a single AlignRequestError with an
 *   empty path;
 * - API 4xx failures become AlignRequestError carrying exactly one error path
 *   (e.g. `left[2].time` or `anchors[1].left`) so the UI can keep the text,
 *   keep the selected anchors, and mark that one spot.
 *
 * The response is parsed with the BigInt-aware parser so huge integer
 * timestamps survive the round trip without precision loss.
 */
export async function alignNotes(
  leftRawArray: string,
  rightRawArray: string,
  fetchImpl: typeof fetch = fetch,
  anchors?: Anchor[],
  compareAlternative = false,
): Promise<AlignResponse> {
  // Anchors are omitted entirely for a legacy request; when present (even an
  // empty list) they are spliced in after the raw arrays. The comparison
  // flag is only sent when switched on, so false/undefined adds no bytes.
  const anchorsFragment =
    anchors === undefined ? "" : `,"anchors":${JSON.stringify(anchors)}`;
  const compareFragment = compareAlternative
    ? ',"compare_alternative":true'
    : "";
  const body = `{"left":${leftRawArray},"right":${rightRawArray}${anchorsFragment}${compareFragment}}`;

  let resp: Response;
  try {
    resp = await fetchImpl("/api/align", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch {
    throw new AlignRequestError(
      "无法连接对齐服务，请确认 API 已启动。",
      "",
      0,
    );
  }

  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = parseLocated(text).value;
  } catch {
    throw new AlignRequestError(
      `服务返回了无法解析的响应（HTTP ${resp.status}）。`,
      "",
      resp.status,
    );
  }

  if (!resp.ok) {
    const data = parsed as Partial<ApiError>;
    throw new AlignRequestError(
      typeof data?.error === "string"
        ? data.error
        : `请求失败（HTTP ${resp.status}）。`,
      typeof data?.path === "string" ? data.path : "",
      resp.status,
    );
  }

  const result = parsed as AlignResponse;
  // Anchor indices are small (0..199); the BigInt-aware parser turns them
  // into bigints, so normalize them back to plain numbers for the UI.
  if (Array.isArray(result.anchors)) {
    result.anchors = result.anchors.map((a) => ({
      left: Number(a.left),
      right: Number(a.right),
    }));
  }
  // Same for the alternative's first-divergence note indices (null on the
  // side the alternative leaves blank at that row).
  if (result.alternative) {
    const d = result.alternative.first_divergence;
    result.alternative.first_divergence = {
      left: d.left === null ? null : Number(d.left),
      right: d.right === null ? null : Number(d.right),
    };
  }
  return result;
}
