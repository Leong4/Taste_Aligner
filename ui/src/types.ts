// ─── /run response types ──────────────────────────────────────────────────────

export interface RunResponse {
  ok: boolean;
  city?: string;
  type?: string;
  explanation?: string;
  bullets?: string[];
  output?: {
    ok: boolean;
    cards?: Card[];
    mix_policy?: unknown;
  };
  decision_trace?: DecisionTrace;
  timing?: unknown;
  errors?: Array<{ code: string; message?: string }>;
}

export interface Card {
  zone?: string;
  title?: string;
  items?: CardItem[];
}

export interface CardItem {
  item_id?: string;
  name?: string;
  city?: string;
  type?: string;
  score_breakdown?: {
    memory_influence?: number;
    tag_similarity?: number;
    location_relevance?: number;
  };
  scores?: { cz?: number; ez?: number };
}

export interface DecisionTrace {
  vision_describe?: {
    used?: boolean;
    vision_type?: string;
    // TODO(contract-cleanup): remove legacy alias after old traces are phased out.
    type?: string;
    cues?: string[];
    tags_count?: number;
    backend?: string;
    fallback_reason?: string;
  };
  tes_builder?: {
    memory_persisted?: boolean;
    memory_write_status?: string;
    fallback_reason?: string;
  };
  profile_vector_node?: {
    anchors?: Anchor[];
    total_memories_considered?: number;
  };
  tag_normalize?: {
    normalized_tags?: string[];
  };
  extract_intent?: {
    city?: string;
    tags?: string[];
  };
  [key: string]: unknown;
}

export interface Anchor {
  memory_id: string;
  final_weight?: number;
  w_time?: number;
  w_sent?: number;
  cosine?: number;
}

// ─── memory service types ─────────────────────────────────────────────────────

export interface SearchResult {
  memory_id: string;
  score?: number;
  sim?: number;
  w_time?: number;
  w_sent?: number;
  w_city?: number;
  timestamp?: string;
  city?: string;
  vision_type?: string;
  normalized_tags?: string[];
  sentiment?: number;
}

export interface MemoryDetail {
  memory_id: string;
  user_id?: string;
  timestamp?: string;
  city?: string;
  raw_tags?: string[];
  normalized_tags?: string[];
  taxonomy?: Record<string, unknown>;
  sentiment?: number;
  source?: string;
  image_path?: string;
  thumbnail_path?: string;
  image_original_path?: string;
  image_preview_path?: string;
  image_thumbnail_path?: string;
  image_vision_input_path?: string;
  caption_text?: string;
  vision_type?: string;
  embedding?: number[];
}
