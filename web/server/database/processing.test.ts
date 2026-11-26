import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ContentStore } from "./content"
import type { ProcessingSnapshot } from "./processing"
import type { CollectionBatch } from "../../shared/content"
import type { ArticleRelation, ProcessingResult } from "../../shared/processing"

function collection(count = 2, batchId = "batch-1", titlePrefix = "Python release"): CollectionBatch {
  const time = "2026-11-26T00:00:00+00:00"
  return { schema_version: 1, batch_id: batchId, collected_at: time,
    source_runs: [{ source_id: "test", name: "Test publisher", kind: "tech_media", url: "https://example.com/", status: "success",
      attempted_at: time, fetched_at: time, last_success_at: time, error: null, items_count: count, rejected_count: 0 }],
    articles: Array.from({ length: count }, (_, i) => ({ source_id: "test", source_item_id: String(i), canonical_url: `https://example.com/${i}`, original_url: `https://example.com/${i}`,
      discussion_url: null, title: `${titlePrefix} ${i}`, author: null, kind: "tech_media", published_at: "2020-01-01T00:00:00+00:00", publication_precision: "second",
      published_raw: "2020-01-01", modified_at: null, crawled_at: time, content_status: "source_summary", content_text: "Original source content.", content_provider: "fixture", content_fetched_at: time, body_error: null, raw: {} })),
  }
}

function result(snapshot: ProcessingSnapshot, digit = "1"): ProcessingResult {
  return { schema_version: 1, run_id: digit.repeat(64), snapshot_id: snapshot.snapshot_id, rules_version: "fixture-rules-v1", processed_at: "2026-11-26T01:00:00+00:00",
    labels: snapshot.articles.map(a => ({ article_id: a.id, input_hash: a.input_hash, cleaned_title: a.title, normalized_title: a.title.toLowerCase(), canonical_url: a.canonical_url,
      body_fingerprint: null, content_type: "news", secondary_types: [], topics: ["software"], technology_relevance: "relevant", status: "classified", method: "rules", confidence: 0.8, reason: "Synthetic test fixture", evidence: [] })),
    relations: [], events: [], metrics: { ai_state: "disabled", classification_calls: 0, pair_calls: 0, errors: [] } }
}
function relation(ids: string[]): ArticleRelation {
  return { left_id: ids[0], right_id: ids[1], kind: "same_event", decision: "accepted", reason: "Synthetic matching event", score: 0.9, method: "rules", guards: [], evidence: [] }
}
function addEvent(payload: ProcessingResult) {
  const ids = payload.labels.slice(0, 2).map(l => l.article_id).sort()
  payload.relations = [relation(ids)]
  payload.events = [{ id: "a".repeat(64), title: "Synthetic event", article_ids: ids, reason: "Synthetic pairwise evidence" }]
}

describe("derived processing storage", () => {
  let directory: string
  let store: ContentStore
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "processing-store-test-"))
    store = await new ContentStore(join(directory, "content.sqlite3")).init()
    await store.importBatch(collection())
  })
  afterEach(async () => {
    await store.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("processing-store-test-")) throw new Error("Unexpected test cleanup directory")
    await rm(directory, { recursive: true, force: true })
  })

  it("backfills derived labels, exposes filters and leaves original data unchanged", async () => {
    const snapshot = await store.processing.snapshot()
    const id = snapshot.articles[0].id
    const before = await store.article(id)
    const payload = result(snapshot)
    await store.processing.apply(payload)
    expect((await store.processing.apply(payload)).duplicate).toBe(true)
    expect((await store.processing.status()).processed).toBe(2)
    expect((await store.articles({ contentType: "news", topic: "software", review: false })).total).toBe(2)
    const after = await store.article(id)
    for (const key of ["title", "canonical_url", "published_at", "first_seen_at", "content_text", "content_sha256"])
      expect((after as any)[key]).toEqual((before as any)[key])
    expect(after!.processing.label).toMatchObject({ content_type: "news", stale: false })
  })

  it("rejects hallucinated model evidence without writing partial results", async () => {
    const payload = result(await store.processing.snapshot())
    payload.labels[0].method = "model"
    payload.labels[0].evidence = [{ field: "title", quote: "invented fact" }]
    await expect(store.processing.apply(payload)).rejects.toThrow("evidence is not")
    expect((await store.processing.status()).processed).toBe(0)
  })

  it("rejects a stale input snapshot and flags previous labels as stale", async () => {
    const payload = result(await store.processing.snapshot())
    await store.processing.apply(payload)
    const changed = collection(2, "batch-changed", "Updated title")
    changed.articles.forEach(a => a.crawled_at = "2026-11-26T04:00:00+00:00")
    await store.importBatch(changed)
    await expect(store.processing.apply(payload)).rejects.toThrow("stale snapshot")
    expect((await store.processing.status()).stale).toBe(2)
    expect((await store.processing.status()).snapshot_changed).toBe(true)
  })

  it("requires pairwise evidence instead of merging a similarity chain", async () => {
    await store.importBatch(collection(3, "batch-extra"))
    const payload = result(await store.processing.snapshot())
    const ids = payload.labels.map(l => l.article_id).sort()
    payload.relations = [relation(ids.slice(0, 2)), relation(ids.slice(1, 3))]
    payload.events = [{ id: "a".repeat(64), title: "Chain", article_ids: ids, reason: "Invalid chain" }]
    await expect(store.processing.apply(payload)).rejects.toThrow("pairwise evidence")
    expect((await store.processing.status()).events).toBe(0)
  })

  it("supports a manual split and clearing it restores an already-known processing result", async () => {
    const baseline = result(await store.processing.snapshot())
    addEvent(baseline)
    await store.processing.apply(baseline)
    const [left, right] = baseline.events[0].article_ids
    const override = await store.processing.override({ kind: "relation", left_id: left, right_id: right, relation: "not_related", reason: "Human checked: different events" })
    expect((await store.processing.status()).snapshot_changed).toBe(true)
    const split = result(await store.processing.snapshot(), "2")
    split.relations = [{ ...relation([left, right]), kind: "not_related", decision: "rejected", method: "manual", reason: "Human checked: different events", score: 1 }]
    await store.processing.apply(split)
    expect((await store.processing.events()).total).toBe(0)
    expect((await store.processing.event(baseline.events[0].id))!.active).toBe(false)
    await store.processing.clearOverride(override.override_key, "Undo test correction")
    expect((await store.processing.apply(baseline)).duplicate).toBe(false)
    expect((await store.processing.events()).total).toBe(1)
    expect((await store.processing.status()).snapshot_changed).toBe(false)
  })

  it("rejects automatic conflicts and forged manual decisions while retaining previous results", async () => {
    const payload = result(await store.processing.snapshot())
    await store.processing.apply(payload)
    const conflict = result(await store.processing.snapshot(), "2")
    addEvent(conflict)
    conflict.relations[0].guards = ["Different version numbers"]
    await expect(store.processing.apply(conflict)).rejects.toThrow("conflicting identifiers")
    conflict.relations[0].guards = []
    conflict.relations[0].method = "manual"
    await expect(store.processing.apply(conflict)).rejects.toThrow("existing override")
    expect((await store.processing.status()).last_run!.run_id).toBe(payload.run_id)
  })

  it("requires an explicit follow-up direction and audits classification overrides", async () => {
    const snapshot = await store.processing.snapshot()
    const payload = result(snapshot)
    payload.relations = [{ ...relation(snapshot.articles.map(a => a.id)), kind: "follow_up" }]
    await expect(store.processing.apply(payload)).rejects.toThrow("direction")
    const id = snapshot.articles[0].id
    const change = await store.processing.override({ kind: "label", article_id: id, content_type: "knowledge", topics: ["software"], technology_relevance: "relevant", reason: "Explains concepts" })
    const updated = result(await store.processing.snapshot(), "2")
    Object.assign(updated.labels.find(l => l.article_id === id)!, { content_type: "knowledge", method: "manual", reason: "Explains concepts" })
    await store.processing.apply(updated)
    expect((await store.articles({ contentType: "knowledge" })).total).toBe(1)
    await store.processing.clearOverride(change.override_key, "Restore automatic classification")
    expect((await store.processing.status()).snapshot_changed).toBe(true)
  })
})
