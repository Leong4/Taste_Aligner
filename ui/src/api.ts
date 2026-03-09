import type { RunResponse, SearchResult, MemoryDetail } from "./types";

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

// GET /read/{memory_id}  — read single memory
export async function readMemory(memoryId: string): Promise<MemoryDetail | null> {
  const res = await fetch(`${MEMORY}/read/${encodeURIComponent(memoryId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} reading memory ${memoryId}`);
  return res.json() as Promise<MemoryDetail>;
}

// Poll /search until a newly-written memory is visible (max 5 s)
export async function pollForNewMemory(
  uploadStartMs: number,
  queryTags: string[],
  city?: string,
): Promise<string | null> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await delay(300);
    const results = await searchMemory({ query_tags: queryTags, city, top_k: 10 });
    for (const row of results) {
      const mem = await readMemory(row.memory_id);
      if (!mem) continue;
      if (mem.user_id !== USER_ID) continue;
      if (mem.source !== "upload") continue;
      const ts = mem.timestamp ? Date.parse(mem.timestamp) : 0;
      if (ts >= uploadStartMs - 5000) return mem.memory_id;
    }
  }
  return null;
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
