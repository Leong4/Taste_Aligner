import { useEffect, useState } from "react";
import type { MemoryDetail } from "../types";

interface Props {
  memory: MemoryDetail | null;
  loading: boolean;
  onClose: () => void;
}

export default function MemoryModal({ memory, loading, onClose }: Props) {
  const [imageReady, setImageReady] = useState(true);
  const imageUrl = memory ? `/api/memory/files/${encodeURIComponent(memory.memory_id)}?variant=preview` : "";
  const originalUrl = memory ? `/api/memory/files/${encodeURIComponent(memory.memory_id)}?variant=original` : "";

  useEffect(() => {
    setImageReady(true);
  }, [memory?.memory_id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>

        {loading && (
          <div style={{ textAlign: "center", padding: "2rem" }}>
            <span className="spinner" />
          </div>
        )}

        {!loading && !memory && (
          <div className="empty">Memory not found.</div>
        )}

        {memory && (
          <>
            <div className="modal-title">Memory Detail</div>

            {imageReady && (
              <>
                <img
                  src={imageUrl}
                  alt={`memory-${memory.memory_id}`}
                  className="modal-image"
                  onError={() => setImageReady(false)}
                />
                <div style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
                  <a href={originalUrl} target="_blank" rel="noreferrer">Open original</a>
                </div>
              </>
            )}

            <DetailRow label="memory_id">
              <span className="mono" style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
                {memory.memory_id}
              </span>
            </DetailRow>

            <DetailRow label="timestamp">
              {memory.timestamp ? new Date(memory.timestamp).toLocaleString() : "—"}
            </DetailRow>

            <DetailRow label="city">{memory.city ?? "—"}</DetailRow>
            <DetailRow label="source">{memory.source ?? "—"}</DetailRow>
            <DetailRow label="vision_type">{memory.vision_type ?? "—"}</DetailRow>

            <DetailRow label="sentiment">
              {typeof memory.sentiment === "number" ? memory.sentiment.toFixed(3) : "—"}
            </DetailRow>

            {memory.caption_text && (
              <DetailRow label="caption_text">
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{memory.caption_text}</div>
              </DetailRow>
            )}

            {memory.normalized_tags && memory.normalized_tags.length > 0 && (
              <DetailRow label="normalized_tags">
                <div className="tags" style={{ marginTop: "0.25rem" }}>
                  {memory.normalized_tags.map((t) => (
                    <span key={t} className="tag">{t}</span>
                  ))}
                </div>
              </DetailRow>
            )}

            {memory.raw_tags && memory.raw_tags.length > 0 && (
              <DetailRow label="raw_tags">
                <div className="tags" style={{ marginTop: "0.25rem" }}>
                  {memory.raw_tags.map((t) => (
                    <span key={t} className="tag tag-gray">{t}</span>
                  ))}
                </div>
              </DetailRow>
            )}

            {memory.taxonomy && Object.keys(memory.taxonomy).length > 0 && (
              <DetailRow label="taxonomy">
                <pre style={{ fontSize: "0.75rem", overflow: "auto", maxHeight: 120, marginTop: "0.25rem" }}>
                  {JSON.stringify(memory.taxonomy, null, 2)}
                </pre>
              </DetailRow>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="detail-row">
      <div className="detail-label">{label}</div>
      <div>{children}</div>
    </div>
  );
}
