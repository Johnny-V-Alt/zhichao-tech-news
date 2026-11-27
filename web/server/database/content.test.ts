import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname, basename, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ContentStore, validateBatch } from "./content"
import type { CollectionBatch, CollectedArticle } from "../../shared/content"

const time = "2026-11-25T12:00:00+00:00"
function fixture(id = "batch-1"): CollectionBatch {
  return {
    schema_version: 1, batch_id: id, collected_at: time,
    source_runs: [{ source_id: "media", name: "Test media", kind: "tech_media", url: "https://example.com/", status: "success",
      attempted_at: time, fetched_at: time, last_success_at: time, error: null, items_count: 1, rejected_count: 0 }],
    articles: [{ source_id: "media", source_item_id: "1", canonical_url: "https://example.com/story", original_url: "https://example.com/story?utm_source=test",
      discussion_url: null, title: "Original story", author: null, kind: "tech_media", published_at: "2020-01-01T00:00:00+00:00",
      publication_precision: "second", published_raw: "2020-01-01T00:00:00Z", modified_at: null, crawled_at: time,
      content_status: "full_text", content_text: "Source page text", content_provider: "fixture", content_fetched_at: time, body_error: null, raw: {} }],
  }
}

describe("durable content import", () => {
  let directory: string
  let store: ContentStore
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "content-store-test-"))
    store = await new ContentStore(join(directory, "content.sqlite3")).init()
  })
  afterEach(async () => {
    await store.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("content-store-test-"))
      throw new Error("Refusing to remove an unexpected test directory")
    await rm(directory, { recursive: true, force: true })
  })

  it("merges the same URL across sources while preserving source evidence", async () => {
    const batch = fixture()
    batch.source_runs.push({ ...batch.source_runs[0], source_id: "blog", name: "Test blog", kind: "developer_blog" })
    batch.articles.push({ ...batch.articles[0], source_id: "blog", source_item_id: "different-id", kind: "developer_blog" })
    expect((await store.importBatch(batch)).new_articles).toBe(1)
    const list = await store.articles({ kind: "developer_blog" })
    expect(list.total).toBe(1)
    const article = await store.article((list.items[0] as any).id)
    expect(article!.sources).toHaveLength(2)
    expect(article!.versions).toHaveLength(1)
    expect(article!.published_at).toBe("2020-01-01T00:00:00+00:00")
  })

  it("is idempotent and rejects reuse of a batch ID with changed content", async () => {
    const batch = fixture()
    await store.importBatch(batch)
    expect((await store.importBatch(batch)).duplicate).toBe(true)
    batch.articles[0].title = "Changed payload"
    await expect(store.importBatch(batch)).rejects.toThrow("Batch ID reused")
    expect((await store.status()).articles).toBe(1)
  })

  it("keeps publication and full text through later title-only observations", async () => {
    await store.importBatch(fixture())
    const next = fixture("batch-2")
    const item = next.articles[0]
    item.title = "Updated title"
    item.published_at = null
    item.publication_precision = "unknown"
    item.content_status = "title_only"
    item.content_text = null
    item.crawled_at = "2026-11-25T13:00:00+00:00"
    expect((await store.importBatch(next)).new_versions).toBe(1)
    const list = await store.articles()
    const article = await store.article((list.items[0] as any).id)
    expect(article!.content_text).toBe("Source page text")
    expect(article!.published_at).toBe("2020-01-01T00:00:00+00:00")
    expect(article!.title).toBe("Updated title")
    expect(article!.versions).toHaveLength(2)
  })

  it("retains last successful fetch on partial failure and persists after restart", async () => {
    await store.importBatch(fixture())
    const failed = fixture("batch-failed")
    failed.articles = []
    Object.assign(failed.source_runs[0], { status: "failed", attempted_at: "2026-11-25T14:00:00+00:00", fetched_at: null, last_success_at: null, error: "Connection failed", items_count: 0 })
    await store.importBatch(failed)
    expect((await store.sources())[0]).toMatchObject({ status: "failed", last_success_at: time, error: "Connection failed", stored_items: 1 })
    await store.close()
    store = await new ContentStore(join(directory, "content.sqlite3")).init()
    expect((await store.status()).articles).toBe(1)
  })

  it("rejects malformed batches before committing any content", async () => {
    const batch = fixture()
    batch.articles[0].published_at = "2026-11-25T12:00:00"
    await expect(store.importBatch(batch)).rejects.toThrow("timezone/date")
    expect((await store.status()).articles).toBe(0)
    expect((await store.status()).last_batch).toBeNull()
  })

  it("does not create a version merely because a page was fetched again", async () => {
    await store.importBatch(fixture())
    const next = fixture("batch-2")
    next.articles[0].crawled_at = "2026-11-25T14:00:00+00:00"
    next.articles[0].content_fetched_at = "2026-11-25T14:00:00+00:00"
    expect((await store.importBatch(next)).new_versions).toBe(0)
  })

  it("imports a backfilled body without changing source health or publication metadata", async () => {
    const initial = fixture()
    Object.assign(initial.articles[0], { content_status: "title_only", content_text: null, content_provider: null, content_fetched_at: null })
    await store.importBatch(initial)
    const sources = await store.sources()
    const body = fixture("body-repair")
    body.purpose = "body_backfill"
    body.articles[0].title = "Stale title from a backfill task"
    body.articles[0].crawled_at = "2026-11-27T12:00:00+00:00"
    body.articles[0].content_text = "Recovered publisher body. ".repeat(10)
    body.source_runs[0].attempted_at = body.articles[0].crawled_at
    expect((await store.importBatch(body)).new_articles).toBe(0)
    const article = await store.article((await store.articles()).items[0].id)
    expect(article!.content_status).toBe("full_text")
    expect(article!.content_text).toBe(body.articles[0].content_text)
    expect(article!.title).toBe("Original story")
    expect(article!.published_at).toBe("2020-01-01T00:00:00+00:00")
    expect(await store.sources()).toEqual(sources)
    expect((await store.importBatch(body)).duplicate).toBe(true)
    const unknown = fixture("body-unknown")
    unknown.purpose = "body_backfill"
    unknown.articles[0].canonical_url = "https://example.com/not-in-the-library"
    await expect(store.importBatch(unknown)).rejects.toThrow("Unknown backfill article")
    expect((await store.status()).articles).toBe(1)
  })

  it("persists rich documents across restart, preserves them on text-only observations and invalidates stale markup", async () => {
    await store.importBatch(fixture())
    const id = (await store.articles()).items[0].id
    const rich = fixture("rich-document")
    rich.purpose = "body_backfill"
    Object.assign(rich.articles[0], { content_html: "<p>Source <strong>page</strong> text</p><img src='/api/content/images/" + "a".repeat(64) + "'>", rich_version: 1, image_url: "/api/content/images/" + "a".repeat(64), image_count: 1, image_error_count: 0 })
    expect((await store.importBatch(rich)).new_versions).toBe(0)
    expect(await store.article(id)).toMatchObject({ rich_version: 1, content_html: rich.articles[0].content_html, image_count: 1 })
    expect((await store.articles()).items[0].image_url).toBe(rich.articles[0].image_url)
    await store.close(); store = await new ContentStore(join(directory, "content.sqlite3")).init()
    expect((await store.article(id))!.content_html).toBe(rich.articles[0].content_html)
    const weaker = fixture("plain-repeat")
    await store.importBatch(weaker)
    expect((await store.article(id))!.rich_version).toBe(1)
    const changed = fixture("changed-text")
    changed.articles[0].content_text = "A materially changed source body"
    await store.importBatch(changed)
    expect(await store.article(id)).toMatchObject({ content_html: null, rich_version: 0, image_url: null })
    const malformed = fixture("bad-rich")
    malformed.articles[0].content_html = "<p>text</p>"
    expect(() => validateBatch(malformed)).toThrow("rich article")
  })

  it("binds search parameters instead of treating them as SQL", async () => {
    await store.importBatch(fixture())
    expect((await store.articles({ q: "' OR 1=1; DROP TABLE content_articles; --" })).total).toBe(0)
    expect((await store.status()).articles).toBe(1)
  })

  it("preserves unknown dates and rejects mismatched precision and missing bodies", () => {
    const batch = fixture()
    const item: CollectedArticle = batch.articles[0]
    item.published_at = null
    item.publication_precision = "unknown"
    expect(() => validateBatch(batch)).not.toThrow()
    item.publication_precision = "second"
    expect(() => validateBatch(batch)).toThrow("Unknown publication")
    item.publication_precision = "unknown"
    item.content_text = null
    expect(() => validateBatch(batch)).toThrow("Missing content")
  })
})
