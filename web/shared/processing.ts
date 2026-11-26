export const contentTypes = ["news", "tutorial", "knowledge", "tool", "review", "unknown"] as const
export const topicIds = ["ai", "hardware", "systems", "software", "networks", "databases", "security", "research", "industry", "ai_science"] as const
export const relationKinds = ["duplicate", "same_event", "follow_up", "possible_related", "not_related"] as const
export type ContentType = typeof contentTypes[number]
export type Topic = typeof topicIds[number]
export type RelationKind = typeof relationKinds[number]
export interface TextEvidence { field: "title" | "content_text", quote: string, article_id?: string, label?: string }
export interface ArticleLabel {
  article_id: string
  input_hash: string
  cleaned_title: string
  normalized_title: string
  canonical_url: string
  body_fingerprint: string | null
  content_type: ContentType
  secondary_types: ContentType[]
  topics: Topic[]
  technology_relevance: "relevant" | "out_of_scope" | "uncertain"
  status: "classified" | "provisional" | "needs_review"
  method: "rules" | "model" | "manual"
  confidence: number
  reason: string
  evidence: TextEvidence[]
}
export interface ArticleRelation {
  left_id: string
  right_id: string
  kind: RelationKind
  decision: "accepted" | "pending" | "rejected"
  reason: string
  score: number
  method: "rules" | "model" | "manual"
  guards: string[]
  evidence: TextEvidence[]
  followup_id?: string
}
export interface ContentEvent { id: string, title: string, article_ids: string[], reason: string }
export interface ProcessingResult {
  schema_version: 1
  run_id: string
  snapshot_id: string
  rules_version: string
  processed_at: string
  labels: ArticleLabel[]
  relations: ArticleRelation[]
  events: ContentEvent[]
  metrics: { ai_state: string, classification_calls: number, pair_calls: number, errors: string[] }
}
