export interface Citation { article_id: string, quote: string }
export interface GroundedText { text: string, citations: Citation[], inference?: boolean }
export interface Dimension { value: number, reason: GroundedText }
export interface Assessment {
  content_type: "news" | "tutorial" | "knowledge" | "tool" | "review" | "unknown"
  technology_relevance: "relevant" | "out_of_scope" | "uncertain"
  topics: string[]
  verification: "source_report" | "vendor_claim" | "conflicting" | "unverified"
  facts: GroundedText[]
  changes: GroundedText[]
  significance: GroundedText
  scores: Record<"relevance" | "evidence" | "impact" | "novelty", Dimension>
  event_date: { value: string, citation: Citation } | null
  checker: { checks: { claim_id: string, supported: boolean, reason: string }[] }
}
export interface EditorialPolicy {
  version: string
  timezone: string
  weights: Record<"relevance" | "timeliness" | "evidence" | "impact" | "novelty", number>
  featured_min: number
  recent_min: number
  relevance_min: number
  minimum_content_chars: number
  recent_hours: number
  tracking_days: number
  max_future_skew_minutes: number
  max_featured: number
  max_recent: number
  max_ongoing: number
  ai: { enabled: boolean, max_items_per_run: number, max_calls_per_run: number, context_chars_per_article: number, max_context_chars_per_item: number, max_output_tokens: number, estimated_token_upper_limit: number, timeout_seconds: number }
}
export interface EditorialArticle {
  id: string
  title: string
  canonical_url: string
  content_text: string | null
  content_status: string
  published_at: string | null
  publication_precision: string
  input_hash: string
  sources: { source_id: string, original_url: string, name: string, kind: string }[]
  label: Record<string, any> | null
}
export interface Curation {
  excluded?: boolean
  unit_id: string
  reason: string
  major_ongoing: boolean
  verification_note: string
  verified_update: { date: string, citation: Citation } | null
  include_updated_resource: boolean
}
export interface EditorialUnit {
  id: string
  input_hash: string
  articles: EditorialArticle[]
  dedup_keys: string[]
  curation: Curation | null
  preflight?: { candidate: boolean, reason: string, time_score: number, original_date: string | null, effective_date: string | null, age_hours: number | null }
}
export interface AnalysisRecord {
  analysis_id: string
  unit_id: string
  input_hash: string
  analysis_version: string
  model: string
  assessment: Assessment
}
export interface EditorialResult {
  schema_version: 1
  run_id: string
  snapshot_id: string
  policy_hash: string
  analysis_version: string
  model: string
  generated_at: string
  state: "not_configured" | "disabled" | "processing_required" | "completed" | "budget_limited" | "failed" | "partial_error"
  analyses: AnalysisRecord[]
  reused_analysis_ids: string[]
  pending: { unit_id: string, reason: string }[]
  errors: { unit_id: string, code: string }[]
  metrics: { calls: number, writer_calls: number, checker_calls: number, estimated_token_upper_bound: number, actual_usage_available: boolean }
}
