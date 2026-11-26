export type SourceStatus = "success" | "cached" | "partial" | "failed"
export type ContentStatus = "title_only" | "source_summary" | "full_text" | "unavailable"
export type DatePrecision = "unknown" | "date" | "minute" | "second"

export interface CollectionSourceRun {
  source_id: string
  name: string
  kind: string
  url: string
  status: SourceStatus
  attempted_at: string
  fetched_at: string | null
  last_success_at: string | null
  error: string | null
  items_count: number
  rejected_count: number
}

export interface CollectedArticle {
  source_id: string
  source_item_id: string
  canonical_url: string
  original_url: string
  discussion_url: string | null
  title: string
  author: string | null
  kind: string
  published_at: string | null
  publication_precision: DatePrecision
  published_raw: string | number | null
  modified_at: string | null
  crawled_at: string
  content_status: ContentStatus
  content_text: string | null
  content_provider: string | null
  content_fetched_at: string | null
  body_error: string | null
  raw: unknown
}

export interface CollectionBatch {
  schema_version: 1
  batch_id: string
  collected_at: string
  source_runs: CollectionSourceRun[]
  articles: CollectedArticle[]
}
