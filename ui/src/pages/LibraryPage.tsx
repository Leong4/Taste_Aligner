import { useMemo, useRef, useState, useEffect, type PointerEvent } from "react";
import { searchMemory, readMemory, deleteMemory } from "../api";
import type { SearchResult, MemoryDetail } from "../types";

// Broad tags so we pull back any kind of food/travel memory
const LIBRARY_TAGS = ["food", "travel", "scenery", "ramen", "cafe", "restaurant", "tokyo"];
const FILTERS = [
  { id: "all", label: "All" },
  { id: "scenery", label: "Scenery" },
  { id: "food", label: "Food" },
  { id: "architecture", label: "Architecture" },
] as const;
const SORT_OPTIONS = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
] as const;

type LibraryFilter = (typeof FILTERS)[number]["id"];
type ViewMode = "gallery" | "detail";
type SortMode = (typeof SORT_OPTIONS)[number]["id"];

export default function LibraryPage({ onNavigate }: { onNavigate?: (tab: "import") => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<MemoryDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("gallery");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [cityQuery, setCityQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [sortOpen, setSortOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[] | null>(null);
  const sortRef = useRef<HTMLDivElement | null>(null);

  const visibleResults = useMemo(() => {
    const normalizedQuery = cityQuery.trim().toLowerCase();
    const filtered = results.filter((result) => {
      const matchesType = filter === "all" || getVisionType(result) === filter;
      const matchesCity = !normalizedQuery || (result.city ?? "").toLowerCase().includes(normalizedQuery);
      return matchesType && matchesCity;
    });

    return [...filtered].sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return sortMode === "newest" ? tb - ta : ta - tb;
    });
  }, [cityQuery, filter, results, sortMode]);

  useEffect(() => {
    if (!sortOpen) return;

    function closeSort(event: MouseEvent) {
      const target = event.target as Node;
      if (!sortRef.current?.contains(target)) setSortOpen(false);
    }

    document.addEventListener("mousedown", closeSort);
    return () => document.removeEventListener("mousedown", closeSort);
  }, [sortOpen]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await searchMemory({ query_tags: LIBRARY_TAGS, top_k: 50 });
      setResults(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(diagnose(msg));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function openDetail(memId: string) {
    setSelectedId(memId);
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

  async function removeMemories(memIds: string[]) {
    setError(null);
    try {
      for (const memId of memIds) {
        await deleteMemory(memId);
      }
      setDeleteTargetIds(null);
      setSelectedIds([]);
      setSelectMode(false);
      setSelectedId(null);
      setSelected(null);
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(diagnose(msg));
    }
  }

  function requestDelete(memIds: string[]) {
    setDeleteTargetIds(memIds);
  }

  function toggleSelected(memId: string) {
    setSelectedIds((current) => {
      if (current.includes(memId)) {
        const next = current.filter((id) => id !== memId);
        if (next.length === 0) setSelectMode(false);
        return next;
      }
      return [...current, memId];
    });
  }

  function enterSelectMode(memId: string) {
    setSelectMode(true);
    setSelectedIds((current) => current.includes(memId) ? current : [...current, memId]);
  }

  function clearSelection() {
    setSelectedIds([]);
    setSelectMode(false);
  }

  function navigateDetail(direction: -1 | 1) {
    if (!selectedId || visibleResults.length === 0) return;
    const index = visibleResults.findIndex((result) => result.memory_id === selectedId);
    if (index === -1) return;
    const next = visibleResults[index + direction];
    if (next) openDetail(next.memory_id);
  }

  const activeFilterLabel = FILTERS.find((item) => item.id === filter)?.label.toLowerCase() ?? "all";
  const emptyLabel = filter === "all" ? "memories" : `${activeFilterLabel} memories`;
  const selectedIndex = selectedId ? visibleResults.findIndex((result) => result.memory_id === selectedId) : -1;
  const sortLabel = SORT_OPTIONS.find((item) => item.id === sortMode)?.label ?? "Newest first";

  return (
    <div
      className="library-page"
      onClick={(event) => {
        if (!selectMode) return;
        const target = event.target as HTMLElement;
        if (target.closest(".mem-card, .library-select-bar, .confirm-dialog, .library-controls")) return;
        clearSelection();
      }}
    >
      <div className="library-header">
        <div>
          <h2 className="library-title">Your Collection</h2>
          <div className="library-count">
            {loading && results.length === 0 ? "Loading memories" : `${visibleResults.length} memories`}
          </div>
        </div>

        <div className="library-view-toggle" aria-label="Library view">
          <button
            className={viewMode === "gallery" ? "active" : ""}
            type="button"
            onClick={() => setViewMode("gallery")}
          >
            Gallery View
          </button>
          <button
            className={viewMode === "detail" ? "active" : ""}
            type="button"
            onClick={() => setViewMode("detail")}
          >
            Detail View
          </button>
        </div>
      </div>

      <div className="library-controls">
        <div className="library-filters" aria-label="Memory filters">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              className={`tag-chip filter-chip ${filter === item.id ? "active" : ""}`}
              type="button"
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="sort-control" ref={sortRef}>
          <span>Sort</span>
          <button className="sort-trigger" type="button" onClick={() => setSortOpen((open) => !open)}>
            <span>{sortLabel}</span>
            <ChevronIcon />
          </button>
          {sortOpen && (
            <div className="sort-menu">
              {SORT_OPTIONS.map((item) => (
                <button
                  key={item.id}
                  className={`sort-option ${sortMode === item.id ? "active" : ""}`}
                  type="button"
                  onClick={() => {
                    setSortMode(item.id);
                    setSortOpen(false);
                  }}
                >
                  <span className="sort-check">{sortMode === item.id ? "✓" : ""}</span>
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && results.length === 0 && (
        <div className="empty"><span className="spinner" /></div>
      )}

      {!loading && visibleResults.length === 0 && !error && (
        <div className="empty library-empty">
          <div>No {emptyLabel} yet. Import some photos to get started.</div>
          <button className="btn btn-primary" type="button" onClick={() => onNavigate?.("import")}>
            Go to Import
          </button>
        </div>
      )}

      <div className={`library-grid ${viewMode === "gallery" ? "gallery-view" : "detail-view"}`}>
        {visibleResults.map((r) => (
          <MemoryTile
            key={r.memory_id}
            result={r}
            viewMode={viewMode}
            selectMode={selectMode}
            selected={selectedIds.includes(r.memory_id)}
            onClick={() => openDetail(r.memory_id)}
            onDelete={() => requestDelete([r.memory_id])}
            onLongPress={() => enterSelectMode(r.memory_id)}
            onToggleSelect={() => toggleSelected(r.memory_id)}
          />
        ))}
      </div>

      <div className="city-search-bar" role="search">
        <SearchIcon />
        <input
          type="text"
          value={cityQuery}
          placeholder="Search cities..."
          onChange={(event) => setCityQuery(event.target.value)}
        />
        {cityQuery && (
          <button type="button" aria-label="Clear city search" onClick={() => setCityQuery("")}>
            ×
          </button>
        )}
      </div>

      {selectMode && selectedIds.length > 0 && (
        <div className="library-select-bar">
          <span>{selectedIds.length} selected</span>
          <button className="btn danger-btn" type="button" onClick={() => requestDelete(selectedIds)}>
            Delete selected
          </button>
        </div>
      )}

      {selectedId && (
        <LibraryDetailModal
          memoryId={selectedId}
          memory={selected}
          loading={loadingDetail}
          onClose={() => {
            setSelectedId(null);
            setSelected(null);
          }}
          onDelete={() => requestDelete([selectedId])}
          onNavigate={navigateDetail}
          hasPrevious={selectedIndex > 0}
          hasNext={selectedIndex >= 0 && selectedIndex < visibleResults.length - 1}
        />
      )}

      {deleteTargetIds && (
        <ConfirmDeleteDialog
          count={deleteTargetIds.length}
          onCancel={() => setDeleteTargetIds(null)}
          onConfirm={() => removeMemories(deleteTargetIds)}
        />
      )}
    </div>
  );
}

function MemoryTile({
  result,
  viewMode,
  selectMode,
  selected,
  onClick,
  onDelete,
  onLongPress,
  onToggleSelect,
}: {
  result: SearchResult;
  viewMode: ViewMode;
  selectMode: boolean;
  selected: boolean;
  onClick: () => void;
  onDelete: () => void;
  onLongPress: () => void;
  onToggleSelect: () => void;
}) {
  const [imageReady, setImageReady] = useState(true);
  const pressTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const ts = result.timestamp ? new Date(result.timestamp).toLocaleDateString() : "—";
  const tags = result.normalized_tags ?? [];
  // Canonical contract: vision_type. Keep heuristic fallback only for legacy rows.
  const visionType = getVisionType(result);
  const imageUrl = `/api/memory/files/${encodeURIComponent(result.memory_id)}?variant=thumb`;

  function clearPressTimer() {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  function handleCardClick() {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (selectMode) {
      onToggleSelect();
      return;
    }
    onClick();
  }

  return (
    <div
      className={`mem-card ${viewMode === "gallery" ? "mem-card-gallery" : "mem-card-detail"} ${selected ? "selected" : ""}`}
      onClick={handleCardClick}
      onPointerDown={() => {
        clearPressTimer();
        pressTimer.current = window.setTimeout(() => {
          suppressClick.current = true;
          onLongPress();
        }, 500);
      }}
      onPointerLeave={clearPressTimer}
      onPointerCancel={clearPressTimer}
      onPointerUp={clearPressTimer}
    >
      {selectMode && (
        <span className={`mem-checkbox ${selected ? "checked" : ""}`} aria-hidden="true">
          {selected ? "✓" : ""}
        </span>
      )}
      <button
        className="mem-delete"
        type="button"
        title="Delete memory"
        aria-label="Delete memory"
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <TrashIcon />
      </button>
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
        {viewMode === "gallery" && (
          <div className="mem-hover-overlay">
            <div className="mem-city">{result.city ?? "Unknown city"}</div>
          </div>
        )}
      </div>
      {viewMode === "detail" && (
        <>
          <div className="mem-city">{result.city ?? "Unknown city"}</div>
          <div className="mem-ts">vision_type: {visionType || "—"}</div>
          <div className="mem-ts">{ts}</div>
          {tags.length > 0 && (
            <div className="tags">
              {tags.slice(0, 4).map((t) => <span key={t} className="tag-chip" style={{ fontSize: "0.7rem" }}>{t}</span>)}
              {tags.length > 4 && <span className="tag-chip" style={{ fontSize: "0.7rem" }}>+{tags.length - 4}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LibraryDetailModal({
  memoryId,
  memory,
  loading,
  onClose,
  onDelete,
  onNavigate,
  hasPrevious,
  hasNext,
}: {
  memoryId: string;
  memory: MemoryDetail | null;
  loading: boolean;
  onClose: () => void;
  onDelete: () => void;
  onNavigate: (direction: -1 | 1) => void;
  hasPrevious: boolean;
  hasNext: boolean;
}) {
  const [immersive, setImmersive] = useState(false);
  const [favourites, setFavourites] = useState<Record<string, true>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ta-favourites") ?? "{}") as Record<string, true>;
    } catch {
      return {};
    }
  });
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const suppressTap = useRef(false);
  const imageUrl = `/api/memory/files/${encodeURIComponent(memoryId)}?variant=preview`;
  const tags = memory?.normalized_tags ?? memory?.raw_tags ?? [];
  const ts = formatDate(memory?.timestamp);
  const isFavourite = Boolean(favourites[memoryId]);
  const userCaption = getUserCaption(memory?.caption_text);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && hasPrevious) onNavigate(-1);
      if (event.key === "ArrowRight" && hasNext) onNavigate(1);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hasNext, hasPrevious, onClose, onNavigate]);

  function toggleFavourite() {
    setFavourites((current) => {
      const next = { ...current };
      if (next[memoryId]) {
        delete next[memoryId];
      } else {
        next[memoryId] = true;
      }
      localStorage.setItem("ta-favourites", JSON.stringify(next));
      return next;
    });
  }

  function handlePointerUp(event: PointerEvent) {
    if (!pointerStart.current) return;
    const dx = event.clientX - pointerStart.current.x;
    const dy = event.clientY - pointerStart.current.y;
    pointerStart.current = null;

    if (Math.abs(dy) > 70 && dy > 0) {
      suppressTap.current = true;
      onClose();
      return;
    }
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) {
      suppressTap.current = true;
      if (dx < 0 && hasNext) onNavigate(1);
      if (dx > 0 && hasPrevious) onNavigate(-1);
    }
  }

  function toggleImmersive() {
    if (suppressTap.current) {
      suppressTap.current = false;
      return;
    }
    setImmersive((current) => !current);
  }

  return (
    <div className={`library-modal-overlay ${immersive ? "immersive" : ""}`}>
      <div
        className="library-modal"
        onPointerDown={(event) => {
          pointerStart.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={handlePointerUp}
      >
        <img className="library-modal-backdrop-image" src={imageUrl} alt="" aria-hidden="true" />

        <div className="library-modal-topbar">
          <button className="library-modal-close" type="button" aria-label="Close detail" onClick={onClose}>
            <ArrowLeftIcon />
          </button>
          <div className="library-modal-heading">
            {memory?.city ?? "Loading"} · {ts}
          </div>
          <div />
        </div>

        {loading && !memory && <div className="library-modal-loading"><span className="spinner" /></div>}

        <img
          className="library-modal-image"
          src={imageUrl}
          alt={`memory-${memoryId}`}
          onClick={toggleImmersive}
        />

        <div className="library-modal-toolbar">
          <button className="viewer-icon muted" type="button" aria-label="Share coming soon">
            <ShareIcon />
          </button>
          <button
            className={`viewer-icon favourite ${isFavourite ? "active" : ""}`}
            type="button"
            aria-label={isFavourite ? "Remove favourite" : "Add favourite"}
            onClick={toggleFavourite}
          >
            <HeartIcon filled={isFavourite} />
          </button>
          <button className="viewer-icon danger" type="button" aria-label="Delete memory" onClick={onDelete}>
            <TrashIcon />
          </button>
        </div>

        <div className="immersive-info-panel">
          <h2>{memory?.city ?? "Unknown city"}</h2>
          <div className="immersive-type">{memory?.vision_type ?? "memory"}</div>
          {tags.length > 0 && (
            <div className="immersive-tags">
              {tags.map((tag) => <span key={tag}>{tag}</span>)}
            </div>
          )}
          {userCaption && <p>{userCaption}</p>}
        </div>
      </div>
    </div>
  );
}

function ConfirmDeleteDialog({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="confirm-overlay">
      <div className="confirm-dialog">
        <h3>Delete {count} memory?</h3>
        <p>This cannot be undone.</p>
        <div className="confirm-actions">
          <button className="btn btn-ghost" type="button" onClick={onCancel}>Cancel</button>
          <button className="btn danger-btn" type="button" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 14v5h14v-5" />
    </svg>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.8 8.8c0 5.4-8.8 10.2-8.8 10.2S3.2 14.2 3.2 8.8A4.6 4.6 0 0 1 12 6.9a4.6 4.6 0 0 1 8.8 1.9Z"
        fill={filled ? "currentColor" : "none"}
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 11v6m4-6v6" />
      <path d="M6 7l1 14h10l1-14" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

function getVisionType(result: SearchResult): string {
  return result.vision_type ?? inferType(result.normalized_tags ?? []);
}

function formatDate(timestamp?: string): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function getUserCaption(caption?: string | null): string | null {
  const trimmed = caption?.trim();
  if (!trimmed) return null;

  const blockedSubstrings = [
    "please",
    "taste profile",
    "remember this photo",
    "from my",
    "this photo is",
  ];
  const normalized = trimmed.toLowerCase();
  if (blockedSubstrings.some((blocked) => normalized.includes(blocked))) return null;

  return trimmed;
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
