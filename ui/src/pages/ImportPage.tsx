import { useState, useRef, DragEvent, ChangeEvent } from "react";
import { runPipeline, pollForNewMemory } from "../api";
import type { RunResponse } from "../types";

type Phase = "idle" | "uploading" | "polling" | "done";
const VISION_INPUT_MAX_WIDTH = 1024;
const VISION_INPUT_WEBP_QUALITY = 0.82;

interface UploadResult {
  visionType?: string;
  cues: string[];
  memoryStatus?: string;
  memoryId: string | null;
  city?: string;
  normalizedTags: string[];
}

function buildVisionInputDataUrl(
  originalDataUrl: string,
  maxWidth: number = VISION_INPUT_MAX_WIDTH,
  webpQuality: number = VISION_INPUT_WEBP_QUALITY,
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.width || 1;
      const height = img.height || 1;
      const scale = Math.min(1, maxWidth / width);
      const targetW = Math.max(1, Math.round(width * scale));
      const targetH = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(originalDataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);
      try {
        const converted = canvas.toDataURL("image/webp", webpQuality);
        resolve(converted && converted.startsWith("data:image/") ? converted : originalDataUrl);
      } catch {
        resolve(originalDataUrl);
      }
    };
    img.onerror = () => resolve(originalDataUrl);
    img.src = originalDataUrl;
  });
}

export default function ImportPage() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [city, setCity] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function loadFile(file: File) {
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);
    setResult(null);
    setError(null);
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) loadFile(f);
  }

  async function handleUpload() {
    if (!imageFile || !imagePreview) {
      setError("Please select an image first.");
      return;
    }
    setError(null);
    setResult(null);
    setPhase("uploading");

    const uploadStartMs = Date.now();
    let runResp: RunResponse;
    try {
      const caption = note.trim();
      const explicitCity = city.trim();
      const text = note.trim()
        ? note.trim()
        : `Please remember this photo for my taste profile${city ? ` from ${city}` : ""}.`;
      const visionInputDataUrl = await buildVisionInputDataUrl(imagePreview);
      runResp = await runPipeline({
        text,
        image_base64: visionInputDataUrl,
        image_original_base64: imagePreview,
        caption: caption || undefined,
        city: explicitCity || undefined,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(diagnose(msg));
      setPhase("idle");
      return;
    }

    if (!runResp.ok) {
      const errCode = runResp.errors?.[0]?.code ?? "unknown";
      setError(`Pipeline returned ok=false. Error: ${errCode}`);
      setPhase("idle");
      return;
    }

    const dt = runResp.decision_trace ?? {};
    const vd = dt.vision_describe;
    const tb = dt.tes_builder;
    const tn = dt.tag_normalize;

    const normalizedTags: string[] = Array.isArray(tn?.normalized_tags)
      ? (tn.normalized_tags as string[])
      : [];
    const detectedCity: string =
      typeof (dt.extract_intent as { city?: string })?.city === "string"
        ? (dt.extract_intent as { city: string }).city
        : city || "tokyo";

    const partial: UploadResult = {
      // Canonical contract is vision_type; legacy .type fallback kept temporarily
      // for compatibility with historical traces.
      visionType: vd?.vision_type ?? vd?.type,
      cues: Array.isArray(vd?.cues) ? (vd.cues as string[]) : [],
      memoryStatus: tb?.memory_write_status,
      memoryId: null,
      city: detectedCity,
      normalizedTags,
    };
    setResult(partial);

    // Poll for memory_id
    if (tb?.memory_persisted) {
      setPhase("polling");
      const tags = normalizedTags.length > 0 ? normalizedTags : ["food", "travel"];
      const memId = await pollForNewMemory(uploadStartMs, tags, detectedCity).catch(() => null);
      setResult({ ...partial, memoryId: memId });
    }

    setPhase("done");
  }

  const busy = phase === "uploading" || phase === "polling";
  const typeEmoji = result?.visionType === "food" ? "🍜" : result?.visionType === "scenery" ? "🏔️" : "📷";

  return (
    <div>
      <h2>Import Memory</h2>
      <p style={{ color: "#6b7280", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
        Upload a photo — vision analyzes it, TES builds an embedding, and it's saved to your taste memory.
      </p>

      <div className="card">
        {/* Dropzone */}
        <div
          className={`dropzone ${dragOver ? "drag-over" : ""}`}
          onClick={() => fileRef.current?.click()}
          onDrop={onDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
        >
          {imagePreview ? (
            <>
              <img src={imagePreview} alt="preview" />
              <div style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}>
                {imageFile?.name} — click to change
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>📸</div>
              <div>Drag & drop or click to select (jpg / png / webp)</div>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: "none" }}
            onChange={onFileChange}
          />
        </div>

        {/* Optional fields */}
        <label>Note / travel journal (optional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Best ramen I've had in Tokyo — thick tonkotsu broth..."
          disabled={busy}
        />
        <label>City (optional)</label>
        <input
          type="text"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="e.g. tokyo, kyoto, paris..."
          disabled={busy}
        />

        <button
          className="btn btn-primary"
          onClick={handleUpload}
          disabled={busy || !imageFile}
        >
          {busy ? <span className="spinner" /> : null}
          {phase === "uploading" ? "Uploading..." : phase === "polling" ? "Saving to memory..." : "Upload"}
        </button>
      </div>

      {/* Error */}
      {error && <div className="error-banner">{error}</div>}

      {/* Result */}
      {result && (
        <div className="card">
          <h3>Upload Result</h3>

          <div className="result-row">
            <span className="label">Vision type</span>
            <span className="value">{typeEmoji} {result.visionType ?? "—"}</span>
          </div>

          <div className="result-row">
            <span className="label">Memory write</span>
            <span>
              <span className={`status-badge ${result.memoryStatus === "queued" ? "badge-green" : "badge-gray"}`}>
                {result.memoryStatus ?? "—"}
              </span>
            </span>
          </div>

          <div className="result-row">
            <span className="label">Memory ID</span>
            <span className="value mono" style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
              {phase === "polling" ? (
                <><span className="spinner" style={{ marginRight: "0.4rem" }} />polling...</>
              ) : result.memoryId ?? (
                <span style={{ color: "#9ca3af" }}>not detected (check library later)</span>
              )}
            </span>
          </div>

          <div className="result-row">
            <span className="label">Detected city</span>
            <span className="value">{result.city ?? "—"}</span>
          </div>

          {result.cues.length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <div style={{ fontSize: "0.8rem", color: "#6b7280", marginBottom: "0.35rem", fontWeight: 600 }}>
                VISION CUES
              </div>
              <div className="tags">
                {result.cues.map((c) => <span key={c} className="tag">{c}</span>)}
              </div>
            </div>
          )}

          {result.normalizedTags.length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <div style={{ fontSize: "0.8rem", color: "#6b7280", marginBottom: "0.35rem", fontWeight: 600 }}>
                NORMALIZED TAGS
              </div>
              <div className="tags">
                {result.normalizedTags.map((t) => <span key={t} className="tag tag-gray">{t}</span>)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function diagnose(msg: string): string {
  if (msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED") || msg.includes("NetworkError")) {
    return `Cannot reach agent_runtime (http://localhost:8787).\n\nFix: run ./scripts/dev_up.sh from the repo root, then retry.`;
  }
  if (msg.includes("text_required")) {
    return "text field is required by the agent. Please add a note or let the default text be used.";
  }
  return msg;
}
