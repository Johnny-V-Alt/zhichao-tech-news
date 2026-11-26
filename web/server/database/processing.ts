import { createHash } from "node:crypto"
import type { Database } from "db0"
import { contentTypes, topicIds, relationKinds } from "../../shared/processing"
import type { ArticleLabel, ContentEvent, ProcessingResult, TextEvidence } from "../../shared/processing"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
type Row = Record<string, any>
export interface ProcessingArticle {
  id: string
  title: string
  canonical_url: string
  content_text: string | null
  content_status: string
  published_at: string | null
  publication_precision: string
  kind: string
  content_sha256: string
  sources: unknown[]
  input_hash: string
}
export interface ProcessingSnapshot {
  schema_version: number
  snapshot_id: string
  articles: ProcessingArticle[]
  overrides: Row[]
  events: ContentEvent[]
  label_cache: Record<string, unknown>
  relation_cache: Row[]
}

const schema = `
CREATE TABLE IF NOT EXISTS processing_runs (
  run_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, rules_version TEXT NOT NULL,
  processed_at TEXT NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_state (id INTEGER PRIMARY KEY CHECK(id=1),run_id TEXT NOT NULL REFERENCES processing_runs(run_id),activated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS article_processing (
  article_id TEXT PRIMARY KEY REFERENCES content_articles(id), input_hash TEXT NOT NULL,
  article_fingerprint TEXT NOT NULL, rules_version TEXT NOT NULL, content_type TEXT NOT NULL,
  status TEXT NOT NULL, method TEXT NOT NULL, body_fingerprint TEXT, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_relations (
  left_id TEXT NOT NULL REFERENCES content_articles(id), right_id TEXT NOT NULL REFERENCES content_articles(id),
  kind TEXT NOT NULL, decision TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(left_id,right_id)
);
CREATE TABLE IF NOT EXISTS content_events (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, active INTEGER NOT NULL, data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_articles (
  article_id TEXT PRIMARY KEY REFERENCES content_articles(id), event_id TEXT NOT NULL REFERENCES content_events(id)
);
CREATE TABLE IF NOT EXISTS processing_overrides (
  override_key TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_override_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, override_key TEXT NOT NULL, action TEXT NOT NULL,
  reason TEXT NOT NULL, data_json TEXT NOT NULL, changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS processing_type ON article_processing(content_type,status);
CREATE INDEX IF NOT EXISTS processing_body ON article_processing(body_fingerprint);
`

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid processing data: ${message}`)
}
function text(value: unknown, name: string, max = 2000): asserts value is string {
  check(typeof value === "string" && value.length > 0 && value.length <= max, name)
}
function sha(value: unknown, name: string) { check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), name) }
function score(value: unknown) { check(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, "score") }
function evidence(entries: TextEvidence[], article: ProcessingArticle, requireQuotes = false) {
  check(Array.isArray(entries) && entries.length <= 30 && (!requireQuotes || entries.length > 0), "evidence list")
  for (const entry of entries) {
    check(entry && ["title", "content_text"].includes(entry.field), "evidence field")
    text(entry.quote, "evidence quote", 250)
    check((article[entry.field] || "").includes(entry.quote), "evidence is not in original article")
  }
}
function validateLabel(label: ArticleLabel, article: ProcessingArticle) {
  check(label && label.article_id === article.id && label.input_hash === article.input_hash, "article input hash")
  text(label.cleaned_title, "cleaned title", 10000)
  text(label.normalized_title, "normalized title", 10000)
  text(label.canonical_url, "canonical URL", 8192)
  if (label.body_fingerprint !== null) sha(label.body_fingerprint, "body fingerprint")
  check(contentTypes.includes(label.content_type), "content type")
  check(Array.isArray(label.topics) && label.topics.every(t => topicIds.includes(t)), "topics")
  check(new Set(label.topics).size === label.topics.length, "duplicate topics")
  check(Array.isArray(label.secondary_types) && label.secondary_types.every(t => contentTypes.includes(t)), "secondary types")
  check(["classified", "provisional", "needs_review"].includes(label.status), "classification status")
  check(["rules", "model", "manual"].includes(label.method), "classification method")
  check(["relevant", "out_of_scope", "uncertain"].includes(label.technology_relevance), "technology relevance")
  score(label.confidence)
  text(label.reason, "classification reason")
  evidence(label.evidence, article, label.method === "model")
}

export class ProcessingStore {
  constructor(private db: Database) {}
  async init() { await this.db.exec(schema) }

  async snapshot(): Promise<ProcessingSnapshot> {
    const rows = await this.db.prepare(`SELECT id,title,canonical_url,content_text,content_status,published_at,
      publication_precision,kind,content_sha256 FROM content_articles ORDER BY id`).all() as Row[]
    check(rows.length <= 10000, "processing snapshot is too large")
    const sourceRows = await this.db.prepare(`SELECT a.article_id,a.source_id,a.original_url,c.name,c.kind
      FROM content_article_sources a JOIN content_sources c ON c.source_id=a.source_id ORDER BY a.article_id,a.source_id,a.source_item_id`).all() as Row[]
    const articles = rows.map((row) => {
      const value = { ...row, sources: sourceRows.filter(s => s.article_id === row.id) }
      return { ...value, input_hash: hash(JSON.stringify(value)) } as ProcessingArticle
    })
    const overrides = (await this.db.prepare("SELECT data_json FROM processing_overrides ORDER BY override_key").all() as Row[]).map(r => JSON.parse(r.data_json))
    const labels = await this.db.prepare("SELECT article_id,rules_version,data_json FROM article_processing ORDER BY article_id").all() as Row[]
    const labelCache = Object.fromEntries(labels.map(r => [r.article_id, { rules_version: r.rules_version, label: JSON.parse(r.data_json) }]))
    const relations = await this.db.prepare(`SELECT r.data_json,a.input_hash AS left_hash,b.input_hash AS right_hash,a.rules_version
      FROM processing_relations r JOIN article_processing a ON a.article_id=r.left_id JOIN article_processing b ON b.article_id=r.right_id`).all() as Row[]
    const events = (await this.db.prepare("SELECT data_json FROM content_events WHERE active=1 ORDER BY id").all() as Row[]).map(r => JSON.parse(r.data_json))
    return { schema_version: 1, snapshot_id: hash(JSON.stringify({ articles, overrides })), articles, overrides, events,
      label_cache: labelCache, relation_cache: relations.map(r => ({ relation: JSON.parse(r.data_json), left_hash: r.left_hash, right_hash: r.right_hash, rules_version: r.rules_version })) }
  }

  async apply(input: unknown) {
    check(input && typeof input === "object", "result object")
    const result = input as ProcessingResult
    check(result.schema_version === 1, "schema version")
    sha(result.run_id, "run id"); sha(result.snapshot_id, "snapshot id")
    text(result.rules_version, "rules version", 200)
    text(result.processed_at, "processed at", 64)
    check(!Number.isNaN(Date.parse(result.processed_at)), "processing date")
    check(Array.isArray(result.labels) && Array.isArray(result.relations) && Array.isArray(result.events), "result arrays")
    check(result.relations.length <= 100000, "too many relation candidates")
    await this.db.exec("BEGIN IMMEDIATE")
    try {
      const snapshot = await this.snapshot()
      check(snapshot.snapshot_id === result.snapshot_id, "stale snapshot; export and retry")
      const byId = new Map(snapshot.articles.map(a => [a.id, a]))
      check(result.labels.length === byId.size, "every article needs exactly one label")
      const ids = new Set<string>()
      for (const label of result.labels) {
        check(!ids.has(label.article_id) && byId.has(label.article_id), "duplicate or unknown label")
        ids.add(label.article_id)
        validateLabel(label, byId.get(label.article_id)!)
        if (label.method === "manual") {
          check(snapshot.overrides.some(o => o.kind === "label" && o.article_id === label.article_id && o.value.content_type === label.content_type && o.value.reason === label.reason), "manual label needs an existing override")
        }
      }
      const pairs = new Set<string>()
      for (const relation of result.relations) {
        check(relation && byId.has(relation.left_id) && byId.has(relation.right_id) && relation.left_id < relation.right_id, "relation endpoints")
        const pair = `${relation.left_id}:${relation.right_id}`
        check(!pairs.has(pair), "duplicate relation"); pairs.add(pair)
        check(relationKinds.includes(relation.kind), "relation kind")
        check(["accepted", "pending", "rejected"].includes(relation.decision), "relation decision")
        check(["rules", "model", "manual"].includes(relation.method), "relation method")
        check(Array.isArray(relation.guards) && relation.guards.every(s => typeof s === "string"), "relation guards")
        score(relation.score); text(relation.reason, "relation reason")
        check(!(relation.guards.length && relation.decision === "accepted" && relation.method !== "manual"), "conflicting identifiers cannot be automatically joined")
        check(relation.kind !== "possible_related" || relation.decision === "pending", "candidate must be pending")
        check(relation.kind !== "not_related" || relation.decision === "rejected", "rejected relation decision")
        if (relation.kind === "follow_up") check(relation.followup_id === relation.left_id || relation.followup_id === relation.right_id, "follow-up direction")
        check(Array.isArray(relation.evidence), "relation evidence")
        for (const e of relation.evidence) {
          check(e.article_id === relation.left_id || e.article_id === relation.right_id, "relation evidence endpoint")
          evidence([e], byId.get(e.article_id!)!)
        }
        if (relation.method === "model") check(new Set(relation.evidence.map(e => e.article_id)).size === 2, "model relation needs evidence from both articles")
        if (relation.method === "manual") check(snapshot.overrides.some(o => o.kind === "relation" && o.left_id === relation.left_id && o.right_id === relation.right_id && o.value.kind === relation.kind && o.value.reason === relation.reason), "manual relation needs an existing override")
      }
      const eventIds = new Set<string>(), memberIds = new Set<string>()
      const joins = new Set(result.relations.filter(r => r.kind === "same_event" && r.decision === "accepted").map(r => `${r.left_id}:${r.right_id}`))
      for (const event of result.events) {
        sha(event.id, "event id"); text(event.title, "event title", 10000); text(event.reason, "event reason")
        check(!eventIds.has(event.id) && Array.isArray(event.article_ids) && event.article_ids.length >= 2, "event membership")
        eventIds.add(event.id)
        for (const id of event.article_ids) {
          check(byId.has(id) && !memberIds.has(id), "article in duplicate or unknown event"); memberIds.add(id)
          check(result.labels.find(l => l.article_id === id)?.content_type === "news", "event members must be news reports")
        }
        for (let i = 0; i < event.article_ids.length; i++) for (let j = i + 1; j < event.article_ids.length; j++)
          check(joins.has([...event.article_ids.slice(i, i + 1), event.article_ids[j]].sort().join(":")), "event lacks pairwise evidence")
      }
      const previous = await this.db.prepare("SELECT data_json FROM processing_runs WHERE run_id=?").get(result.run_id) as Row | undefined
      if (previous) {
        const old = JSON.parse(previous.data_json)
        const signature = (r: ProcessingResult) => JSON.stringify([r.snapshot_id, r.rules_version, r.labels, r.relations, r.events])
        check(signature(old) === signature(result), "run ID reused with different data")
        const active = await this.db.prepare("SELECT run_id FROM processing_state WHERE id=1").get() as Row | undefined
        if (active?.run_id === result.run_id) {
          await this.db.exec("COMMIT")
          return { duplicate: true, run_id: result.run_id, articles: result.labels.length }
        }
      }
      // Rebuild only derived rows. Original articles, source records and dates are untouched.
      await this.db.exec("DELETE FROM processing_relations; DELETE FROM event_articles; UPDATE content_events SET active=0;")
      for (const label of result.labels) {
        await this.db.prepare(`INSERT INTO article_processing VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET
          input_hash=excluded.input_hash,article_fingerprint=excluded.article_fingerprint,rules_version=excluded.rules_version,
          content_type=excluded.content_type,status=excluded.status,method=excluded.method,body_fingerprint=excluded.body_fingerprint,data_json=excluded.data_json`)
          .run(label.article_id, label.input_hash, byId.get(label.article_id)!.content_sha256, result.rules_version, label.content_type, label.status, label.method, label.body_fingerprint, JSON.stringify(label))
      }
      for (const r of result.relations) await this.db.prepare("INSERT INTO processing_relations VALUES (?,?,?,?,?)").run(r.left_id, r.right_id, r.kind, r.decision, JSON.stringify(r))
      for (const e of result.events) {
        await this.db.prepare("INSERT INTO content_events VALUES (?,?,1,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,active=1,data_json=excluded.data_json").run(e.id, e.title, JSON.stringify(e))
        for (const id of e.article_ids) await this.db.prepare("INSERT INTO event_articles VALUES (?,?)").run(id, e.id)
      }
      await this.db.prepare("INSERT OR IGNORE INTO processing_runs VALUES (?,?,?,?,?)").run(result.run_id, result.snapshot_id, result.rules_version, result.processed_at, JSON.stringify(result))
      await this.db.prepare("INSERT INTO processing_state VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,activated_at=excluded.activated_at").run(result.run_id, new Date().toISOString())
      await this.db.exec("COMMIT")
      return { duplicate: false, run_id: result.run_id, articles: result.labels.length, relations: result.relations.length, events: result.events.length }
    } catch (error) { await this.db.exec("ROLLBACK"); throw error }
  }

  async status() {
    const counts = await this.db.prepare(`SELECT COUNT(*) AS processed,SUM(p.status='needs_review') AS needs_review,SUM(p.status='provisional') AS provisional,
      SUM(p.article_fingerprint<>a.content_sha256) AS stale FROM article_processing p JOIN content_articles a ON a.id=p.article_id`).get() as Row
    const types = await this.db.prepare("SELECT content_type,COUNT(*) AS count FROM article_processing GROUP BY content_type ORDER BY content_type").all()
    const relations = await this.db.prepare("SELECT kind,decision,COUNT(*) AS count FROM processing_relations GROUP BY kind,decision ORDER BY kind").all()
    const runs = await this.db.prepare("SELECT r.run_id,r.snapshot_id,r.rules_version,r.processed_at,s.activated_at FROM processing_runs r JOIN processing_state s ON s.run_id=r.run_id WHERE s.id=1").get() as Row | undefined
    const total = await this.db.prepare("SELECT COUNT(*) AS total FROM content_articles").get() as Row
    const events = await this.db.prepare("SELECT COUNT(*) AS count FROM content_events WHERE active=1").get() as Row
    const snapshotChanged = runs ? runs.snapshot_id !== (await this.snapshot()).snapshot_id : true
    return { processed: counts.processed, unprocessed: total.total - counts.processed, needs_review: counts.needs_review || 0,
      provisional: counts.provisional || 0, stale: counts.stale || 0, snapshot_changed: snapshotChanged, types, relations, events: events.count, last_run: runs || null }
  }

  async article(id: string) {
    const label = await this.db.prepare("SELECT p.data_json,(p.article_fingerprint<>a.content_sha256) AS stale FROM article_processing p JOIN content_articles a ON a.id=p.article_id WHERE p.article_id=?").get(id) as Row | undefined
    const relations = (await this.db.prepare("SELECT data_json FROM processing_relations WHERE left_id=? OR right_id=? ORDER BY decision,kind").all(id, id) as Row[]).map(r => JSON.parse(r.data_json))
    const event = await this.db.prepare("SELECT e.data_json FROM event_articles a JOIN content_events e ON e.id=a.event_id WHERE a.article_id=? AND e.active=1").get(id) as Row | undefined
    return { label: label ? { ...JSON.parse(label.data_json), stale: !!label.stale } : null, relations, event: event ? JSON.parse(event.data_json) : null }
  }

  async events(limit = 30, offset = 0) {
    const total = await this.db.prepare("SELECT COUNT(*) AS count FROM content_events WHERE active=1").get() as Row
    const items = (await this.db.prepare("SELECT data_json FROM content_events WHERE active=1 ORDER BY id LIMIT ? OFFSET ?").all(limit, offset) as Row[]).map(r => JSON.parse(r.data_json))
    return { total: total.count, items }
  }
  async event(id: string) {
    const row = await this.db.prepare("SELECT active,data_json FROM content_events WHERE id=?").get(id) as Row | undefined
    return row ? { ...JSON.parse(row.data_json), active: !!row.active } : null
  }

  async override(value: Row) {
    text(value.reason, "override reason")
    let key: string, entry: Row
    if (value.kind === "label") {
      const article = await this.db.prepare("SELECT id FROM content_articles WHERE id=?").get(value.article_id)
      check(article, "override article")
      check(contentTypes.includes(value.content_type) && Array.isArray(value.topics) && value.topics.every((t: any) => topicIds.includes(t)) && new Set(value.topics).size === value.topics.length, "override labels")
      check(["relevant", "out_of_scope", "uncertain"].includes(value.technology_relevance), "override relevance")
      key = `label:${value.article_id}`
      entry = { kind: "label", article_id: value.article_id, value: { content_type: value.content_type, topics: value.topics,
        technology_relevance: value.technology_relevance, reason: value.reason } }
    } else {
      check(value.kind === "relation" && value.left_id !== value.right_id && relationKinds.includes(value.relation), "override relation")
      const ids = [value.left_id, value.right_id].sort()
      for (const id of ids) check(await this.db.prepare("SELECT id FROM content_articles WHERE id=?").get(id), "override endpoint")
      key = `relation:${ids.join(":")}`
      entry = { kind: "relation", left_id: ids[0], right_id: ids[1], value: { kind: value.relation, reason: value.reason } }
      if (value.relation === "follow_up") {
        check(ids.includes(value.followup_id), "manual follow-up direction")
        entry.value.followup_id = value.followup_id
      }
    }
    await this.db.exec("BEGIN IMMEDIATE")
    try {
      await this.db.prepare("INSERT INTO processing_overrides VALUES (?,?,?) ON CONFLICT(override_key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at").run(key, JSON.stringify(entry), new Date().toISOString())
      await this.db.prepare("INSERT INTO processing_override_audit(override_key,action,reason,data_json,changed_at) VALUES (?,?,?,?,?)").run(key, "set", value.reason, JSON.stringify(entry), new Date().toISOString())
      await this.db.exec("COMMIT")
    } catch (error) { await this.db.exec("ROLLBACK"); throw error }
    return { override_key: key, requires_reprocess: true }
  }
  async clearOverride(key: string, reason: string) {
    text(reason, "clear override reason"); text(key, "override key")
    await this.db.exec("BEGIN IMMEDIATE")
    try {
      const prior = await this.db.prepare("SELECT data_json FROM processing_overrides WHERE override_key=?").get(key) as Row | undefined
      check(prior, "override key not found")
      await this.db.prepare("DELETE FROM processing_overrides WHERE override_key=?").run(key)
      await this.db.prepare("INSERT INTO processing_override_audit(override_key,action,reason,data_json,changed_at) VALUES (?,?,?,?,?)").run(key, "clear", reason, prior.data_json, new Date().toISOString())
      await this.db.exec("COMMIT")
      return { override_key: key, cleared: true, requires_reprocess: true }
    } catch (error) { await this.db.exec("ROLLBACK"); throw error }
  }
}
