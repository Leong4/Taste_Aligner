import { useState } from "react";
import { runPipeline } from "../api";
import type { RunResponse, Card, CardItem, Anchor } from "../types";
import AnchorTable from "../components/AnchorTable";

interface ExploreResult {
  city?: string;
  explanation?: string;
  bullets?: string[];
  comfortZone: CardItem[];
  explorationZone: CardItem[];
  anchors: Anchor[];
  rawCards: Card[];
}

export default function ExplorePage() {
  const [query, setQuery] = useState("I want ramen in tokyo");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExploreResult | null>(null);

  async function handleRun() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    let resp: RunResponse;
    try {
      resp = await runPipeline({ text: query.trim() });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(diagnose(msg));
      setLoading(false);
      return;
    }

    if (!resp.ok) {
      const errCode = resp.errors?.[0]?.code ?? "pipeline_error";
      const errMsg = resp.errors?.[0]?.message ?? "";
      setError(`Pipeline error: ${errCode}${errMsg ? " — " + errMsg : ""}`);
      setLoading(false);
      return;
    }

    const cards: Card[] = resp.output?.cards ?? [];
    const comfort: CardItem[] = [];
    const exploration: CardItem[] = [];
    for (const card of cards) {
      const items = card.items ?? [];
      const zone = (card.zone ?? "").toLowerCase();
      if (zone.includes("comfort") || zone === "cz") comfort.push(...items);
      else if (zone.includes("explor") || zone === "ez") exploration.push(...items);
      else comfort.push(...items); // fallback
    }

    const anchors: Anchor[] =
      (resp.decision_trace?.profile_vector_node?.anchors as Anchor[]) ?? [];

    setResult({
      city: resp.city,
      explanation: resp.explanation ?? undefined,
      bullets: Array.isArray(resp.bullets) ? (resp.bullets as string[]) : [],
      comfortZone: comfort,
      explorationZone: exploration,
      anchors,
      rawCards: cards,
    });
    setLoading(false);
  }

  return (
    <div>
      <h2>Explore</h2>
      <p style={{ color: "#6b7280", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
        Enter a query — the pipeline recalls your memories, builds a profile vector, and reranks recommendations.
      </p>

      <div className="card">
        <label>Query</label>
        <div className="flex-row">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. I want ramen in tokyo"
            onKeyDown={(e) => e.key === "Enter" && handleRun()}
            disabled={loading}
          />
          <button className="btn btn-primary" onClick={handleRun} disabled={loading || !query.trim()}>
            {loading ? <span className="spinner" /> : null}
            {loading ? "Running..." : "Run"}
          </button>
        </div>
        <div style={{ fontSize: "0.8rem", color: "#9ca3af", marginTop: "-0.5rem" }}>
          user_id: ui_demo_user &nbsp;|&nbsp; Press Enter or click Run
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <>
          {/* City + memory anchor count */}
          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
            {result.city && (
              <span className="status-badge badge-blue">
                City: {result.city}
              </span>
            )}
            <span className={`status-badge ${result.anchors.length > 0 ? "badge-green" : "badge-gray"}`}>
              {result.anchors.length} memory anchor{result.anchors.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Recommendation zones */}
          {(result.comfortZone.length > 0 || result.explorationZone.length > 0) && (
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "1rem 1.25rem 0.5rem", borderBottom: "1px solid #f3f4f6" }}>
                <h3 style={{ margin: 0 }}>Recommendations</h3>
              </div>
              <div className="zones" style={{ padding: "1rem 1.25rem" }}>
                <div className="zone-card zone-comfort">
                  <div className="zone-label">Comfort Zone</div>
                  {result.comfortZone.length === 0 ? (
                    <div className="empty" style={{ padding: "1rem 0" }}>—</div>
                  ) : result.comfortZone.map((item, i) => (
                    <ItemRow key={i} item={item} />
                  ))}
                </div>
                <div className="zone-card zone-explore">
                  <div className="zone-label">Exploration Zone</div>
                  {result.explorationZone.length === 0 ? (
                    <div className="empty" style={{ padding: "1rem 0" }}>—</div>
                  ) : result.explorationZone.map((item, i) => (
                    <ItemRow key={i} item={item} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Anchors */}
          <div className="card">
            <h3>Memory Anchors</h3>
            {result.anchors.length === 0 ? (
              <div className="empty" style={{ padding: "1rem 0" }}>
                No anchors — upload some photos first, then query again.
              </div>
            ) : (
              <AnchorTable anchors={result.anchors} />
            )}
          </div>

          {/* Explanation */}
          {(result.explanation || (result.bullets && result.bullets.length > 0)) && (
            <div className="card">
              <h3>Explanation</h3>
              {result.explanation && (
                <p className="explanation">{result.explanation}</p>
              )}
              {result.bullets && result.bullets.length > 0 && (
                <ul className="bullet-list">
                  {result.bullets.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Debug: raw cards if zones were empty */}
          {result.comfortZone.length === 0 && result.explorationZone.length === 0 && result.rawCards.length > 0 && (
            <div className="card">
              <h3>Raw Cards (debug)</h3>
              <pre style={{ fontSize: "0.75rem", overflow: "auto", maxHeight: 300 }}>
                {JSON.stringify(result.rawCards, null, 2)}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ItemRow({ item }: { item: CardItem }) {
  const score = item.scores?.cz ?? item.scores?.ez;
  const mem = item.score_breakdown?.memory_influence;
  return (
    <div className="item-row">
      <div className="item-name">{item.name ?? item.item_id ?? "—"}</div>
      <div className="item-meta">
        {item.city && <span>{item.city}</span>}
        {item.type && <span> · {item.type}</span>}
        {typeof score === "number" && <span> · score {score.toFixed(3)}</span>}
        {typeof mem === "number" && <span> · mem_influence {mem.toFixed(3)}</span>}
      </div>
    </div>
  );
}

function diagnose(msg: string): string {
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("ECONNREFUSED")) {
    return `Cannot reach agent_runtime (port 8787).\n\nFix: run ./scripts/dev_up.sh then retry.`;
  }
  return msg;
}
