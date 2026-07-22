import type { RunResponse, SearchResult, MemoryDetail, AtlasSummaryResponse } from "./types";

// All requests go through Vite proxy:
//   /api/agent  ->  http://localhost:8787
//   /api/memory ->  http://localhost:5001
const AGENT = "/api/agent";
const MEMORY = "/api/memory";

export const USER_ID = "ui_demo_user";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// POST /run  — agent pipeline entry point
export async function runPipeline(payload: {
  text: string;
  user_id?: string;
  image_base64?: string;
  image_original_base64?: string;
  image_url?: string;
  caption?: string;
  city?: string;
  memory_id?: string;
}): Promise<RunResponse> {
  return postJson<RunResponse>(`${AGENT}/run`, {
    user_id: USER_ID,
    ...payload,
  });
}

// POST /search  — memory search (requires query_tags OR query_embedding)
export async function searchMemory(opts: {
  user_id?: string;
  query_tags: string[];
  city?: string;
  top_k?: number;
}): Promise<SearchResult[]> {
  const resp = await postJson<{ results?: SearchResult[] }>(`${MEMORY}/search`, {
    data: {
      user_id: opts.user_id ?? USER_ID,
      query_tags: opts.query_tags,
      city: opts.city,
      top_k: opts.top_k ?? 20,
      now_ts: new Date().toISOString(),
    },
  });
  return resp.results ?? [];
}

export async function getAtlasSummary(userId: string = USER_ID): Promise<AtlasSummaryResponse> {
  const res = await fetch(`${MEMORY}/atlas/summary?user_id=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} loading Atlas summary`);
  return res.json() as Promise<AtlasSummaryResponse>;
}

export async function resolveUkLocation(city: string, validLocations: string[]): Promise<string | null> {
  const resp = await postJson<{ location?: string | null }>(`${AGENT}/geocode/uk-location`, {
    city,
    valid_locations: validLocations,
  });
  return typeof resp.location === "string" ? resp.location : null;
}

// GET /read/{memory_id}  — read single memory
export async function readMemory(memoryId: string): Promise<MemoryDetail | null> {
  const res = await fetch(`${MEMORY}/read/${encodeURIComponent(memoryId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} reading memory ${memoryId}`);
  return res.json() as Promise<MemoryDetail>;
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const res = await fetch(`${MEMORY}/memories/${encodeURIComponent(memoryId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`HTTP ${res.status} deleting memory ${memoryId}: ${text.slice(0, 200)}`);
  }
}
