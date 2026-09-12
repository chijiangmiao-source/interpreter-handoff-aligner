import type { AlignResponse, ApiError, Note } from "./types";

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
 * POST the two raw JSON arrays to the alignment API.
 *
 * - network/non-JSON-HTTP failures become a single Error with an empty path;
 * - API 4xx failures become AlignRequestError carrying exactly one error path
 *   (e.g. `left[2].time`) so the UI can keep the text and mark that spot.
 */
export async function alignNotes(
  left: Note[],
  right: Note[],
  fetchImpl: typeof fetch = fetch,
): Promise<AlignResponse> {
  let resp: Response;
  try {
    resp = await fetchImpl("/api/align", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ left, right }),
    });
  } catch {
    throw new AlignRequestError(
      "无法连接对齐服务，请确认 API 已启动。",
      "",
      0,
    );
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new AlignRequestError(`服务返回了无法解析的响应（HTTP ${resp.status}）。`, "", resp.status);
  }

  if (!resp.ok) {
    const data = body as Partial<ApiError>;
    throw new AlignRequestError(
      typeof data.error === "string" ? data.error : `请求失败（HTTP ${resp.status}）。`,
      typeof data.path === "string" ? data.path : "",
      resp.status,
    );
  }

  return body as AlignResponse;
}
