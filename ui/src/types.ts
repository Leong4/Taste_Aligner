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
    fallback_reason?: string;
  };
  caption_sentiment?: {
    sentiment?: number;
    confidence?: number;
    available?: boolean;
    source?: string;
    fallback_reason?: string;
  };
  persist_memory?: {
    status?: "skipped" | "persisted" | "failed";
    memory_persisted?: boolean;
    memory_id?: string;
    attempts?: number;
    http_status?: number;
    error_code?: string;
    error_message?: string;
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
  sentiment_source?: string;
  sentiment_confidence?: number;
  sentiment_available?: boolean | number;
}

export interface AtlasMemory extends SearchResult {
  country_code?: string | null;
  image_url?: string;
  preview_url?: string;
}

export interface AtlasSummaryResponse {
  user_id: string;
  total_memories: number;
  country_count: number;
  city_count: number;
  mapped_memories: number;
  unmapped_cities: string[];
  taste_profile: Record<string, number>;
  countries: Array<{
    country_code: string;
    memory_count: number;
    cities: Array<{ city: string; memory_count: number }>;
  }>;
  memories: AtlasMemory[];
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
  sentiment_scale?: "signed_v1";
  sentiment_source?: string;
  sentiment_confidence?: number;
  sentiment_available?: boolean | number;
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
