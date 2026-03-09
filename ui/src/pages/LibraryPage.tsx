import { useState, useEffect } from "react";
import { searchMemory, readMemory } from "../api";
import type { SearchResult, MemoryDetail } from "../types";
import MemoryModal from "../components/MemoryModal";

// Broad tags so we pull back any kind of food/travel memory
const LIBRARY_TAGS = ["food", "travel", "scenery", "ramen", "cafe", "restaurant", "tokyo"];

export default function LibraryPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<MemoryDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await searchMemory({ query_tags: LIBRARY_TAGS, top_k: 50 });
      // sort by timestamp desc
      const sorted = [...data].sort((a, b) => {
        const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
        const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
        return tb - ta;
      });
      setResults(sorted);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(diagnose(msg));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function openDetail(memId: string) {
    setLoadingDetail(true);
    setSelected(null);
    try {
      const detail = await readMemory(memId);
      setSelected(detail);
    } catch (err: unknown) {
      console.error("Failed to read memory:", err);
    }
    setLoadingDetail(false);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>Library</h2>
        <button className="btn btn-ghost" onClick={load} disabled={loading} style={{ fontSize: "0.8rem" }}>
          {loading ? <span className="spinner" /> : "Refresh"}
        </button>
        {results.length > 0 && (
          <span className="status-badge badge-blue">{results.length} memories</span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && results.length === 0 && (
        <div className="empty"><span className="spinner" /></div>
      )}

      {!loading && results.length === 0 && !error && (
        <div className="empty">
          No memories found for user "ui_demo_user".<br />
          Go to Import and upload some photos first.
        </div>
      )}

      <div className="library-grid">
        {results.map((r) => (
          <MemoryTile
            key={r.memory_id}
            result={r}
            onClick={() => openDetail(r.memory_id)}
          />
        ))}
      </div>

      {/* Detail modal */}
      {(selected || loadingDetail) && (
        <MemoryModal
          memory={selected}
          loading={loadingDetail}
          onClose={() => { setSelected(null); }}
        />
      )}
    </div>
  );
}

function MemoryTile({ result, onClick }: { result: SearchResult; onClick: () => void }) {
  const [imageReady, setImageReady] = useState(true);
  const ts = result.timestamp ? new Date(result.timestamp).toLocaleDateString() : "—";
  const tags = result.normalized_tags ?? [];
  // Canonical contract: vision_type. Keep heuristic fallback only for legacy rows.
  const visionType = result.vision_type ?? inferType(tags);
  const imageUrl = `/api/memory/files/${encodeURIComponent(result.memory_id)}?variant=thumb`;

  return (
    <div className="mem-card" onClick={onClick}>
      <div className="mem-thumb">
        {imageReady ? (
          <img
            src={imageUrl}
            alt={`memory-${result.memory_id}`}
            loading="lazy"
            onError={() => setImageReady(false)}
          />
        ) : (
          <div className="mem-thumb-fallback">
            {visionType === "food" ? "🍜" : visionType === "scenery" ? "🏔️" : "📷"}
          </div>
        )}
      </div>
      <div className="mem-city">{result.city ?? "Unknown city"}</div>
      <div className="mem-ts">vision_type: {visionType || "—"}</div>
      <div className="mem-ts">{ts}</div>
      {tags.length > 0 && (
        <div className="tags">
          {tags.slice(0, 4).map((t) => <span key={t} className="tag tag-gray" style={{ fontSize: "0.7rem" }}>{t}</span>)}
          {tags.length > 4 && <span className="tag tag-gray" style={{ fontSize: "0.7rem" }}>+{tags.length - 4}</span>}
        </div>
      )}
    </div>
  );
}

function inferType(tags: string[]): "food" | "scenery" | "other" {
  const joined = tags.join(" ").toLowerCase();
  if (/ramen|sushi|food|cafe|restaurant|noodle|dining|dish/.test(joined)) return "food";
  if (/scenery|mountain|nature|park|view|landscape/.test(joined)) return "scenery";
  return "other";
}

function diagnose(msg: string): string {
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("ECONNREFUSED")) {
    return `Cannot reach memory service (port 5001).\n\nFix: run ./scripts/dev_up.sh then reload.`;
  }
  return msg;
}
