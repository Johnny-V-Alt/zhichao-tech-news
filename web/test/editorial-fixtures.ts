import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { editorialHash, claims } from "../server/utils/editorial-policy"
import type { Assessment, EditorialPolicy, EditorialResult, EditorialUnit } from "../shared/editorial"
import type { CollectionBatch } from "../shared/content"
import type { ProcessingResult } from "../shared/processing"
import type { ContentStore } from "../server/database/content"

export const NOW = new Date("2026-11-26T10:00:00Z")
export const policy = JSON.parse(readFileSync(resolve("..", "config", "editorial.json"), "utf-8")) as EditorialPolicy
export const sourceText = "Python 4.0 was released on 2026-11-26. It improves networking and remains in preview. " + "This is source material about software, networking and the limits of a preview release. ".repeat(4)
export function unit(published = "2026-11-26T02:00:00Z"): EditorialUnit {
  return { id: "article:a", input_hash: "a".repeat(64), dedup_keys: ["a"], curation: null, articles: [{
    id: "a", title: "Python release", canonical_url: "https://example.com/a", content_text: sourceText, content_status: "full_text", published_at: published,
    publication_precision: published.length === 10 ? "date" : "second", input_hash: "b".repeat(64), sources: [{ source_id: "media", original_url: "https://example.com/a", name: "Test media", kind: "tech_media" }], label: { content_type: "news", method: "rules", technology_relevance: "relevant" },
  }] }
}
export function assessment(u: EditorialUnit): Assessment {
  const citation = { article_id: u.articles[0].id, quote: "Python 4.0 was released on 2026-11-26. It improves networking and remains in preview." }
  const reason = { text: "材料介绍了软件及网络技术。", citations: [citation] }
  const a: Assessment = { content_type: "news", technology_relevance: "relevant", topics: ["software", "networks"], verification: "source_report",
    facts: [{ text: "软件发布了预览版本。", citations: [citation] }], changes: [], significance: { text: "网络开发者可以关注此次变化。", citations: [citation], inference: true },
    scores: { relevance: { value: 5, reason }, evidence: { value: 5, reason }, impact: { value: 5, reason }, novelty: { value: 5, reason } }, event_date: null, checker: { checks: [] } }
  a.checker.checks = claims(a).map(c => ({ claim_id: c.claim_id, supported: true, reason: "Synthetic consistency check" }))
  return a
}
export async function seed(store: ContentStore, count = 1, dates?: (string | null)[]) {
  const time = "2026-11-26T02:00:00Z"
  const batch: CollectionBatch = { schema_version: 1, batch_id: "editorial-fixture", collected_at: time,
    source_runs: [{ source_id: "test", name: "Test media", kind: "tech_media", url: "https://example.com/", status: "success", attempted_at: time, fetched_at: time, last_success_at: time, error: null, items_count: count, rejected_count: 0 }],
    articles: Array.from({ length: count }, (_, i) => ({ source_id: "test", source_item_id: String(i), canonical_url: `https://example.com/${i}`, original_url: `https://example.com/${i}`, discussion_url: null,
      title: `Python release ${i}`, author: null, kind: "tech_media", published_at: dates ? dates[i] : time, publication_precision: dates?.[i] === null ? "unknown" : "second", published_raw: dates ? dates[i] : time, modified_at: null, crawled_at: time,
      content_status: "full_text", content_text: sourceText, content_provider: "fixture", content_fetched_at: time, body_error: null, raw: {} })) }
  await store.importBatch(batch)
  const snap = await store.processing.snapshot()
  const p: ProcessingResult = { schema_version: 1, run_id: "1".repeat(64), snapshot_id: snap.snapshot_id, rules_version: "fixture", processed_at: time,
    labels: snap.articles.map(a => ({ article_id: a.id, input_hash: a.input_hash, cleaned_title: a.title, normalized_title: a.title.toLowerCase(), canonical_url: a.canonical_url, body_fingerprint: null,
      content_type: "news", secondary_types: [], topics: ["software"], technology_relevance: "relevant", status: "classified", method: "rules", confidence: 0.8, reason: "Synthetic fixture", evidence: [] })),
    relations: [], events: [], metrics: { ai_state: "disabled", classification_calls: 0, pair_calls: 0, errors: [] } }
  await store.processing.apply(p)
}
export function readyResult(snapshot: Awaited<ReturnType<ContentStore["editorial"]["snapshot"]>>, digit = "2"): EditorialResult {
  const u = snapshot.units[0], version = "fixture-v1", model = "fixture/model"
  return { schema_version: 1, run_id: digit.repeat(64), snapshot_id: snapshot.snapshot_id, policy_hash: snapshot.policy_hash, analysis_version: version, model, generated_at: NOW.toISOString(), state: "completed",
    analyses: [{ analysis_id: editorialHash(`${u.id}:${u.input_hash}:${version}:${model}`), unit_id: u.id, input_hash: u.input_hash, analysis_version: version, model, assessment: assessment(u) }],
    reused_analysis_ids: [], pending: [], errors: [], metrics: { calls: 2, writer_calls: 1, checker_calls: 1, estimated_token_upper_bound: 4000, actual_usage_available: false } }
}

