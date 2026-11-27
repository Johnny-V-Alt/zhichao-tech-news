// Uses the same db0 + better-sqlite3 stack as upstream NewsNow. New tables hold
// durable content; upstream's source cache remains a separate concern.
import { EditorialStore } from "./editorial"
import { ProcessingStore } from "./processing"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import process from "node:process"
import { createDatabase } from "db0"
import sqliteConnector from "db0/connectors/better-sqlite3"
import type { CollectionBatch, ContentStatus, DatePrecision } from "../../shared/content"

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS content_schema (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO content_schema VALUES (1);
CREATE TABLE IF NOT EXISTS collection_batches (
  batch_id TEXT PRIMARY KEY, collected_at TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL, item_count INTEGER NOT NULL, source_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_sources (
  source_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
  status TEXT NOT NULL, last_attempt_at TEXT NOT NULL, last_success_at TEXT,
  fetched_at TEXT, error TEXT, items_count INTEGER NOT NULL, rejected_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_source_runs (
  batch_id TEXT NOT NULL REFERENCES collection_batches(batch_id),
  source_id TEXT NOT NULL REFERENCES content_sources(source_id),
  data_json TEXT NOT NULL, PRIMARY KEY(batch_id, source_id)
);
CREATE TABLE IF NOT EXISTS content_articles (
  id TEXT PRIMARY KEY, canonical_url TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  author TEXT, kind TEXT NOT NULL, published_at TEXT, publication_precision TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, modified_at TEXT,
  content_status TEXT NOT NULL, content_text TEXT, content_provider TEXT, content_fetched_at TEXT,
  content_sha256 TEXT NOT NULL, body_error TEXT
);
CREATE TABLE IF NOT EXISTS content_article_sources (
  source_id TEXT NOT NULL REFERENCES content_sources(source_id), source_item_id TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES content_articles(id), original_url TEXT NOT NULL,
  discussion_url TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  data_json TEXT NOT NULL, PRIMARY KEY(source_id, source_item_id)
);
CREATE TABLE IF NOT EXISTS content_article_versions (
  article_id TEXT NOT NULL REFERENCES content_articles(id), fingerprint TEXT NOT NULL,
  observed_at TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES collection_batches(batch_id),
  data_json TEXT NOT NULL, PRIMARY KEY(article_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS content_article_published ON content_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS content_article_source ON content_article_sources(article_id);
`

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const levels = { unavailable: 0, title_only: 0, source_summary: 1, full_text: 2 }
type Row = Record<string, any>
export interface ArticleRecord {
  id: string
  canonical_url: string
  title: string
  author: string | null
  kind: string
  published_at: string | null
  publication_precision: DatePrecision
  first_seen_at: string
  last_seen_at: string
  modified_at: string | null
  content_status: ContentStatus
  content_text: string | null
  content_provider: string | null
  content_fetched_at: string | null
  content_sha256: string
  body_error: string | null
}
export interface StorageStatus {
  schema_version: number
  articles: number
  with_publication_date: number
  with_content: number
  page_texts: number
  sources: number
  failed_sources: number
  last_batch: unknown
  processing: Awaited<ReturnType<ProcessingStore["status"]>>
  editorial: Awaited<ReturnType<EditorialStore["status"]>>
}

function requireString(value: unknown, key: string, max = 2048): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${key}`)
}

function nullableString(value: unknown, key: string, max = 2048) {
  if (value !== null) requireString(value, key, max)
}

function requireDate(value: unknown, key: string, nullable = false, dateOnly = false) {
  if (value === null && nullable) return
  requireString(value, key, 64)
  if (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))) return
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new Error(`Invalid timezone/date: ${key}`)
}

function requireURL(value: unknown, key: string) {
  requireString(value, key, 8192)
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error(`Unsafe ${key}`)
}

export function validateBatch(input: unknown): asserts input is CollectionBatch {
  if (!input || typeof input !== "object") throw new Error("Expected batch object")
  const batch = input as CollectionBatch
  if (batch.purpose !== undefined && batch.purpose !== "body_backfill") throw new Error("Invalid batch purpose")
  if (batch.schema_version !== 1 || !Array.isArray(batch.source_runs) || !Array.isArray(batch.articles))
    throw new Error("Unsupported batch schema")
  requireString(batch.batch_id, "batch_id", 128)
  requireDate(batch.collected_at, "collected_at")
  if (batch.articles.length > 10000 || batch.source_runs.length > 200) throw new Error("Batch too large")
  const sources = new Set<string>()
  for (const run of batch.source_runs) {
    if (!run || typeof run !== "object") throw new Error("Invalid source row")
    requireString(run.source_id, "source_id", 128)
    requireString(run.name, "source name", 256)
    requireString(run.kind, "source kind", 128)
    requireURL(run.url, "source URL")
    if (sources.has(run.source_id)) throw new Error("Duplicate source run")
    sources.add(run.source_id)
    if (!["success", "cached", "partial", "failed"].includes(run.status)) throw new Error("Invalid source status")
    requireDate(run.attempted_at, "attempted_at")
    requireDate(run.fetched_at, "fetched_at", true)
    requireDate(run.last_success_at, "last_success_at", true)
    nullableString(run.error, "source error", 4000)
    for (const value of [run.items_count, run.rejected_count])
      if (!Number.isInteger(value) || value < 0) throw new Error("Invalid source count")
    if (run.status === "failed" && run.fetched_at !== null) throw new Error("Failed run cannot mark a fetch as successful")
  }
  const keys = new Set<string>()
  for (const item of batch.articles) {
    if (!item || typeof item !== "object") throw new Error("Invalid article row")
    if (!sources.has(item.source_id)) throw new Error("Article references an unknown source")
    requireString(item.source_item_id, "source_item_id", 8192)
    requireString(item.title, "title", 10000)
    requireString(item.kind, "kind", 128)
    requireURL(item.canonical_url, "canonical_url")
    requireURL(item.original_url, "original_url")
    if (item.discussion_url !== null) requireURL(item.discussion_url, "discussion_url")
    if (!["unknown", "date", "minute", "second"].includes(item.publication_precision)) throw new Error("Invalid date precision")
    requireDate(item.published_at, "published_at", true, item.publication_precision === "date")
    if ((item.published_at === null) !== (item.publication_precision === "unknown")) throw new Error("Unknown publication must be null")
    if (item.publication_precision === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(item.published_at!)) throw new Error("Date precision mismatch")
    requireDate(item.crawled_at, "crawled_at")
    requireDate(item.modified_at, "modified_at", true, true)
    requireDate(item.content_fetched_at, "content_fetched_at", true)
    nullableString(item.author, "author", 2000)
    nullableString(item.content_provider, "content provider", 128)
    nullableString(item.body_error, "body error", 4000)
    if (batch.purpose === "body_backfill" && item.content_status !== "full_text") throw new Error("Invalid body backfill content")
    if (!(item.content_status in levels)) throw new Error("Invalid content status")
    nullableString(item.content_text, "content_text", 200000)
    if (["full_text", "source_summary"].includes(item.content_status) && !item.content_text) throw new Error("Missing content")
    const key = JSON.stringify([item.source_id, item.source_item_id])
    if (keys.has(key)) throw new Error("Duplicate source item in batch")
    keys.add(key)
  }
  for (const run of batch.source_runs) {
    if (batch.articles.filter(x => x.source_id === run.source_id).length !== run.items_count)
      throw new Error("Source count does not match articles")
  }
}

export class ContentStore {
  private db
  processing: ProcessingStore
  editorial: EditorialStore
  constructor(path = process.env.CONTENT_DB_PATH || resolve("..", "data", "content.sqlite3")) {
    this.db = createDatabase(sqliteConnector({ path }))
    this.processing = new ProcessingStore(this.db)
    this.editorial = new EditorialStore(this.db, this.processing)
  }

  async init() {
    await this.db.exec(schema)
    await this.processing.init()
    await this.editorial.init()
    return this
  }

  async close() { await this.db.dispose() }

  async importBatch(input: unknown) {
    validateBatch(input)
    const batch = input
    const digest = hash(JSON.stringify(batch))
    const result = { batch_id: batch.batch_id, duplicate: false, new_articles: 0, changed_articles: 0, new_versions: 0, observations: batch.articles.length }
    await this.db.exec("BEGIN IMMEDIATE")
    try {
      const previous = await this.db.prepare("SELECT payload_sha256 FROM collection_batches WHERE batch_id=?").get(batch.batch_id) as Row | undefined
      if (previous) {
        if (previous.payload_sha256 !== digest) throw new Error("Batch ID reused with different payload")
        await this.db.exec("COMMIT")
        return { ...result, duplicate: true, observations: 0 }
      }
      await this.db.prepare("INSERT INTO collection_batches VALUES (?, ?, ?, ?, ?, ?)")
        .run(batch.batch_id, batch.collected_at, digest, new Date().toISOString(), batch.articles.length, batch.source_runs.length)
      for (const run of batch.source_runs) {
        if (batch.purpose === "body_backfill") {
          if (!await this.db.prepare("SELECT 1 FROM content_sources WHERE source_id=?").get(run.source_id)) throw new Error("Unknown backfill source")
          await this.db.prepare("INSERT INTO content_source_runs VALUES (?, ?, ?)").run(batch.batch_id, run.source_id, JSON.stringify({ ...run, purpose: "body_backfill" }))
          continue // Body retrieval does not change feed health, counts or feed-fetch dates.
        }
        await this.db.prepare(`INSERT INTO content_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id) DO UPDATE SET name=excluded.name, kind=excluded.kind, url=excluded.url,
          status=excluded.status, last_attempt_at=excluded.last_attempt_at,
          last_success_at=COALESCE(NULLIF(MAX(COALESCE(content_sources.last_success_at,''), COALESCE(excluded.last_success_at,'')),''),NULL),
          fetched_at=COALESCE(excluded.fetched_at,content_sources.fetched_at),error=excluded.error,
          items_count=excluded.items_count,rejected_count=excluded.rejected_count
          WHERE excluded.last_attempt_at>=content_sources.last_attempt_at`)
          .run(run.source_id, run.name, run.kind, run.url, run.status, run.attempted_at, run.last_success_at,
            run.fetched_at, run.error, run.items_count, run.rejected_count)
        await this.db.prepare("INSERT INTO content_source_runs VALUES (?, ?, ?)").run(batch.batch_id, run.source_id, JSON.stringify(run))
      }
      for (const article of batch.articles) {
        const id = hash(article.canonical_url)
        const existing = await this.db.prepare("SELECT * FROM content_articles WHERE id=?").get(id) as ArticleRecord | undefined
        if (batch.purpose === "body_backfill" && !existing) throw new Error("Unknown backfill article")
        const bodyOnly = batch.purpose === "body_backfill"
        const later = !existing || article.crawled_at >= existing.last_seen_at
        const newLevel = levels[article.content_status]
        const oldLevel = existing ? levels[existing.content_status as keyof typeof levels] : -1
        const takeBody = !existing || newLevel > oldLevel || (later && newLevel === oldLevel && !!article.content_text)
        const value = {
          title: bodyOnly ? existing!.title : later ? article.title : existing!.title,
          author: bodyOnly ? existing!.author : later ? (article.author || existing?.author || null) : existing!.author,
          kind: existing?.kind || article.kind,
          published_at: existing?.published_at || article.published_at,
          publication_precision: existing?.published_at ? existing.publication_precision : article.publication_precision,
          modified_at: bodyOnly ? existing!.modified_at : later ? (article.modified_at || existing?.modified_at || null) : existing!.modified_at,
          content_status: takeBody ? article.content_status : existing!.content_status,
          content_text: takeBody ? article.content_text : existing!.content_text,
          content_provider: takeBody ? article.content_provider : existing!.content_provider,
          content_fetched_at: takeBody ? article.content_fetched_at : existing!.content_fetched_at,
        }
        // Retrieval/observation time does not create a new article version.
        const fingerprint = hash(JSON.stringify({ ...value, content_fetched_at: undefined }))
        if (!existing) result.new_articles++
        else if (existing.content_sha256 !== fingerprint) result.changed_articles++
        await this.db.prepare(`INSERT INTO content_articles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,
          published_at=excluded.published_at,publication_precision=excluded.publication_precision,
          first_seen_at=MIN(content_articles.first_seen_at,excluded.first_seen_at),
          last_seen_at=MAX(content_articles.last_seen_at,excluded.last_seen_at),modified_at=excluded.modified_at,
          content_status=excluded.content_status,content_text=excluded.content_text,content_provider=excluded.content_provider,
          content_fetched_at=excluded.content_fetched_at,content_sha256=excluded.content_sha256,body_error=excluded.body_error`)
          .run(id, article.canonical_url, value.title, value.author, value.kind, value.published_at, value.publication_precision,
            article.crawled_at, article.crawled_at, value.modified_at, value.content_status, value.content_text,
            value.content_provider, value.content_fetched_at, fingerprint, article.body_error)
        const versionExists = await this.db.prepare("SELECT 1 FROM content_article_versions WHERE article_id=? AND fingerprint=?").get(id, fingerprint)
        if (!versionExists) {
          await this.db.prepare("INSERT INTO content_article_versions VALUES (?, ?, ?, ?, ?)")
            .run(id, fingerprint, article.crawled_at, batch.batch_id, JSON.stringify(value))
          result.new_versions++
        }
        await this.db.prepare(`INSERT INTO content_article_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id,source_item_id) DO UPDATE SET article_id=excluded.article_id,
          original_url=excluded.original_url,discussion_url=excluded.discussion_url,
          first_seen_at=MIN(content_article_sources.first_seen_at,excluded.first_seen_at),
          last_seen_at=MAX(content_article_sources.last_seen_at,excluded.last_seen_at),
          data_json=CASE WHEN excluded.last_seen_at>=content_article_sources.last_seen_at THEN excluded.data_json ELSE content_article_sources.data_json END`)
          .run(article.source_id, article.source_item_id, id, article.original_url, article.discussion_url,
            article.crawled_at, article.crawled_at, JSON.stringify(article))
      }
      await this.db.exec("COMMIT")
      return result
    } catch (error) {
      await this.db.exec("ROLLBACK")
      throw error
    }
  }

  async status(): Promise<StorageStatus> {
    const counts = await this.db.prepare(`SELECT COUNT(*) AS articles,
      COALESCE(SUM(published_at IS NOT NULL),0) AS with_publication_date,
      COALESCE(SUM(content_text IS NOT NULL),0) AS with_content,
      COALESCE(SUM(content_status='full_text'),0) AS page_texts FROM content_articles`).get() as Pick<StorageStatus, "articles" | "with_publication_date" | "with_content" | "page_texts">
    const lastBatch = await this.db.prepare("SELECT batch_id,collected_at,imported_at,item_count,source_count FROM collection_batches ORDER BY collected_at DESC LIMIT 1").get()
    const sources = await this.db.prepare("SELECT COUNT(*) AS sources,COALESCE(SUM(status='failed'),0) AS failed_sources FROM content_sources").get() as Pick<StorageStatus, "sources" | "failed_sources">
    return { schema_version: 1, ...counts, ...sources, last_batch: lastBatch || null, processing: await this.processing.status(), editorial: await this.editorial.status() }
  }

  async sources() {
    return this.db.prepare(`SELECT s.*,(SELECT COUNT(*) FROM content_article_sources a WHERE a.source_id=s.source_id) AS stored_items
      FROM content_sources s ORDER BY s.kind,s.name`).all()
  }

  async articles(options: { source?: string, kind?: string, q?: string, limit?: number, offset?: number, contentType?: string, topic?: string, review?: boolean, window?: string, relevance?: string, ids?: string[], now?: Date } = {}): Promise<{ total: number, items: Row[] }> {
    const filters: string[] = []
    const params: (string | number)[] = []
    if (options.source) { filters.push("EXISTS(SELECT 1 FROM content_article_sources s WHERE s.article_id=a.id AND s.source_id=?)"); params.push(options.source) }
    if (options.kind) { filters.push("EXISTS(SELECT 1 FROM content_article_sources s JOIN content_sources c ON s.source_id=c.source_id WHERE s.article_id=a.id AND c.kind=?)"); params.push(options.kind) }
    if (options.q) { filters.push("(a.title LIKE ? OR a.content_text LIKE ?)"); params.push(`%${options.q}%`, `%${options.q}%`) }
    if (options.contentType) { filters.push("p.content_type=?"); params.push(options.contentType) }
    if (options.topic) { filters.push("EXISTS(SELECT 1 FROM json_each(p.data_json,'$.topics') WHERE value=?)"); params.push(options.topic) }
    if (options.review !== undefined) filters.push(options.review ? "COALESCE(p.status,'needs_review')<>'classified'" : "p.status='classified'")
    if (options.relevance && options.relevance !== "all") {
      if (options.relevance === "uncertain") filters.push("(p.data_json IS NULL OR p.article_fingerprint<>a.content_sha256 OR json_extract(p.data_json,'$.technology_relevance')='uncertain')")
      else { filters.push("json_extract(p.data_json,'$.technology_relevance')=? AND p.article_fingerprint=a.content_sha256"); params.push(options.relevance) }
    }
    const dateSql = "julianday(CASE WHEN length(a.published_at)=10 THEN a.published_at || 'T00:00:00+08:00' ELSE a.published_at END)"
    const current = (options.now || new Date()).toISOString()
    if (options.window && options.window !== "all") {
      if (options.window === "unknown") filters.push("a.published_at IS NULL")
      else if (options.window === "history") { filters.push(`${dateSql}<julianday(?)-7`); params.push(current) }
      else {
        const days = { "24h": 1, "72h": 3, "7d": 7 }[options.window]
        if (!days) throw new Error("Invalid time window")
        filters.push(`${dateSql}>=julianday(?)-? AND ${dateSql}<=julianday(?)+5.0/1440`); params.push(current, days, current)
      }
    }
    if (options.ids) {
      if (!options.ids.length) return { total: 0, items: [] }
      filters.push(`a.id IN (${options.ids.map(() => "?").join(",")})`); params.push(...options.ids)
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : ""
    const count = await this.db.prepare(`SELECT COUNT(*) AS total FROM content_articles a LEFT JOIN article_processing p ON p.article_id=a.id ${where}`).get(...params) as Row
    const items = await this.db.prepare(`SELECT a.id,a.canonical_url,a.title,a.kind,a.published_at,a.publication_precision,
      a.first_seen_at,a.last_seen_at,a.content_status,SUBSTR(a.content_text,1,300) AS source_excerpt,
      (SELECT COUNT(*) FROM content_article_sources s WHERE s.article_id=a.id) AS source_count,
      (SELECT group_concat(c.name, ' · ') FROM content_article_sources s JOIN content_sources c ON c.source_id=s.source_id WHERE s.article_id=a.id) AS source_names, p.data_json AS processing_json, p.article_fingerprint AS analyzed_fingerprint,a.content_sha256,
      (SELECT event_id FROM event_articles ea WHERE ea.article_id=a.id) AS event_id
      FROM content_articles a LEFT JOIN article_processing p ON p.article_id=a.id ${where} ORDER BY (a.published_at IS NULL),julianday(a.published_at) DESC,a.id
      LIMIT ? OFFSET ?`).all(...params, options.limit ?? 30, options.offset ?? 0) as Row[]
    return { total: count.total, items: items.map(({processing_json,analyzed_fingerprint,content_sha256,...item}) => ({...item,
      classification: processing_json ? {...JSON.parse(processing_json),stale:analyzed_fingerprint!==content_sha256} : null})) }
  }

  async article(id: string, includeEditorial = true) {
    const article = await this.db.prepare("SELECT * FROM content_articles WHERE id=?").get(id) as ArticleRecord | undefined
    if (!article) return null
    const observations = await this.db.prepare(`SELECT s.source_id,c.name,s.original_url,s.discussion_url,s.first_seen_at,s.last_seen_at,s.data_json
      FROM content_article_sources s JOIN content_sources c ON c.source_id=s.source_id WHERE article_id=?`).all(id) as Row[]
    const versions = await this.db.prepare("SELECT fingerprint,observed_at,batch_id FROM content_article_versions WHERE article_id=? ORDER BY observed_at DESC").all(id)
    return { ...article, processing: await this.processing.article(id), editorial: includeEditorial ? await this.editorial.article(id) : null, sources: observations.map(({ data_json, ...rest }) => ({ ...rest, observation: JSON.parse(data_json) })), versions }
  }
}

let store: Promise<ContentStore> | undefined
export function getContentStore() {
  store ??= new ContentStore().init().catch((error) => { store = undefined; throw error })
  return store
}

