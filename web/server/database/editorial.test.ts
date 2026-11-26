import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ContentStore } from "./content"
import { NOW, seed, readyResult } from "../../test/editorial-fixtures"
import { editorialHash } from "../utils/editorial-policy"
import type { ProcessingResult } from "../../shared/processing"

describe("editorial publication boundaries", () => {
  let directory: string, store: ContentStore
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "editorial-test-")); store = await new ContentStore(join(directory, "content.sqlite3")).init(); await seed(store) })
  afterEach(async () => {
    await store.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("editorial-test-")) throw new Error("Unexpected cleanup path")
    await rm(directory, { recursive: true, force: true })
  })
  it("records missing configuration without creating any AI publication", async () => {
    const r = readyResult(await store.editorial.snapshot(NOW))
    Object.assign(r, { state: "not_configured", model: "", analyses: [], metrics: { calls: 0, writer_calls: 0, checker_calls: 0, estimated_token_upper_bound: 0, actual_usage_available: false } })
    expect((await store.editorial.apply(r, NOW)).published).toBe(false)
    expect((await store.editorial.status()).state).toBe("not_configured")
    expect((await store.editorial.latest(NOW)).items).toEqual([])
    expect((await store.editorial.history()).total).toBe(0)
    expect((await store.editorial.apply(r, NOW)).duplicate).toBe(true)
  })
  it("publishes only validated claims and does not refresh an identical digest", async () => {
    const snapshot = await store.editorial.snapshot(NOW), r = readyResult(snapshot)
    expect((await store.editorial.apply(r, NOW)).published).toBe(true)
    const first = await store.editorial.latest(NOW)
    expect(first.items).toHaveLength(1)
    const next = readyResult(await store.editorial.snapshot(NOW), "3")
    next.reused_analysis_ids = [r.analyses[0].analysis_id]; next.analyses = []
    next.metrics = { calls: 0, writer_calls: 0, checker_calls: 0, estimated_token_upper_bound: 0, actual_usage_available: false }
    expect((await store.editorial.apply(next, NOW)).published).toBe(false)
    expect((await store.editorial.latest(NOW)).published_at).toBe(first.published_at)
    expect((await store.editorial.history()).total).toBe(1)
  })
  it("retains the previous publication on model failure or missing configuration", async () => {
    const r = readyResult(await store.editorial.snapshot(NOW)); await store.editorial.apply(r, NOW)
    const before = await store.editorial.latest(NOW)
    const failure = readyResult(await store.editorial.snapshot(NOW), "4")
    Object.assign(failure, { state: "failed", analyses: [], errors: [{ unit_id: r.analyses[0].unit_id, code: "model_request_failed" }], metrics: { calls: 1, writer_calls: 1, checker_calls: 0, estimated_token_upper_bound: 1000, actual_usage_available: false } })
    await store.editorial.apply(failure, NOW)
    expect((await store.editorial.latest(NOW)).id).toBe(before.id)
    expect((await store.editorial.status()).state).toBe("failed")
    const missing = { ...failure, run_id: "5".repeat(64), state: "not_configured" as const, errors: [], metrics: { calls: 0, writer_calls: 0, checker_calls: 0, estimated_token_upper_bound: 0, actual_usage_available: false } }
    await store.editorial.apply(missing, NOW)
    expect((await store.editorial.latest(NOW)).published_at).toBe(before.published_at)
  })
  it("keeps an archive but removes expired items from the current feed", async () => {
    const r = readyResult(await store.editorial.snapshot(NOW)); await store.editorial.apply(r, NOW)
    const first = await store.editorial.latest(NOW)
    const later = await store.editorial.latest(new Date(NOW.getTime() + 8 * 86400000))
    expect(later.items).toEqual([])
    expect(later.published_at).toBe(first.published_at)
    expect((await store.editorial.publication(first.id!))!.archive).toBe(true)
  })
  it("rejects forged evidence, stale snapshots and over-budget reports atomically", async () => {
    const r = readyResult(await store.editorial.snapshot(NOW))
    r.analyses[0].assessment.facts[0].citations[0].quote = "Fabricated quote"
    await expect(store.editorial.apply(r, NOW)).rejects.toThrow("citation")
    expect((await store.editorial.history()).total).toBe(0)
    const stale = readyResult(await store.editorial.snapshot(NOW), "6"); stale.snapshot_id = "0".repeat(64)
    await expect(store.editorial.apply(stale, NOW)).rejects.toThrow("stale")
    const budget = readyResult(await store.editorial.snapshot(NOW), "7"); budget.metrics.calls = 100
    await expect(store.editorial.apply(budget, NOW)).rejects.toThrow("budget")
    expect((await store.editorial.history()).total).toBe(0)
  })
  it("does not make an old copied article new through a second URL", async () => {
    const first = await store.processing.snapshot(), original = first.articles[0]
    // A second synthetic source record links to the same long content; its own
    // publication time is recent but the original is historical.
    const db = (store as any).db
    const copyId = editorialHash("https://example.com/copy")
    await db.prepare("UPDATE content_articles SET published_at=? WHERE id=?").run("2020-01-01T00:00:00Z", original.id)
    await db.prepare(`INSERT INTO content_articles SELECT ?,?,title,author,kind,?,publication_precision,first_seen_at,last_seen_at,modified_at,content_status,content_text,content_provider,content_fetched_at,content_sha256,body_error FROM content_articles WHERE id=?`)
      .run(copyId, "https://example.com/copy", "2026-11-26T02:00:00Z", original.id)
    const snapshot = await store.processing.snapshot()
    const p: ProcessingResult = { schema_version: 1, run_id: "8".repeat(64), snapshot_id: snapshot.snapshot_id, rules_version: "duplicate-fixture", processed_at: NOW.toISOString(),
      labels: snapshot.articles.map(a => ({ article_id: a.id, input_hash: a.input_hash, cleaned_title: a.title, normalized_title: a.title, canonical_url: a.canonical_url,
        body_fingerprint: null, content_type: "news", secondary_types: [], topics: ["software"], technology_relevance: "relevant", status: "classified", method: "rules", confidence: 0.8, reason: "Fixture", evidence: [] })),
      relations: [{ left_id: [original.id, copyId].sort()[0], right_id: [original.id, copyId].sort()[1], kind: "duplicate", decision: "accepted", reason: "Same source text", score: 1, method: "rules", guards: [], evidence: [] }], events: [],
      metrics: { ai_state: "disabled", classification_calls: 0, pair_calls: 0, errors: [] } }
    await store.processing.apply(p)
    const editorial = await store.editorial.snapshot(NOW)
    expect(editorial.units).toHaveLength(1)
    expect(editorial.units[0].articles).toHaveLength(2)
    expect(editorial.units[0].preflight).toMatchObject({ candidate: false, original_date: "2020-01-01T00:00:00Z" })
  })
})
