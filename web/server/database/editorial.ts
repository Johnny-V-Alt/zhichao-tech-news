import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"
import type { Database } from "db0"
import type { ProcessingStore } from "./processing"
import type { AnalysisRecord, Curation, EditorialArticle, EditorialPolicy, EditorialResult, EditorialUnit } from "../../shared/editorial"
import { editorialCheck as check, editorialHash as hash, evaluateAssessment, preflight, stableJSON, validateAssessment, validateCuration } from "../utils/editorial-policy"

type Row = Record<string, any>
const schema = `
CREATE TABLE IF NOT EXISTS editorial_analyses (analysis_id TEXT PRIMARY KEY,unit_id TEXT NOT NULL,input_hash TEXT NOT NULL,analysis_version TEXT NOT NULL,model TEXT NOT NULL,created_at TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS editorial_runs (run_id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,state TEXT NOT NULL,generated_at TEXT NOT NULL,recorded_at TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS editorial_drafts (run_id TEXT PRIMARY KEY REFERENCES editorial_runs(run_id),data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS editorial_evaluations (unit_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES editorial_runs(run_id),data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS editorial_publications (id TEXT PRIMARY KEY,published_at TEXT NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS editorial_state (id INTEGER PRIMARY KEY CHECK(id=1),last_run_id TEXT REFERENCES editorial_runs(run_id),publication_id TEXT REFERENCES editorial_publications(id));
CREATE TABLE IF NOT EXISTS editorial_curations (unit_id TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS editorial_curation_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,unit_id TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,data_json TEXT NOT NULL,changed_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS editorial_analysis_input ON editorial_analyses(unit_id,input_hash);
`

export class EditorialStore {
  constructor(private db: Database, private processing: ProcessingStore, private policyPath = process.env.EDITORIAL_POLICY_PATH || resolve("..", "config", "editorial.json")) {}
  async init() { await this.db.exec(schema) }
  async policy(): Promise<EditorialPolicy> {
    const p = JSON.parse(await readFile(this.policyPath, "utf-8")) as EditorialPolicy
    check(p.version && p.timezone === "Asia/Shanghai", "policy version/timezone")
    check(stableJSON(p.weights) === stableJSON({ relevance: 25, timeliness: 30, evidence: 20, impact: 15, novelty: 10 }), "unapproved scoring weights")
    for (const key of ["featured_min", "recent_min", "relevance_min", "minimum_content_chars", "recent_hours", "tracking_days", "max_future_skew_minutes", "max_featured", "max_recent", "max_ongoing"] as const)
      check(typeof p[key] === "number" && Number.isFinite(p[key]) && p[key] > 0, `policy ${key}`)
    check(p.featured_min <= 100 && p.recent_min <= p.featured_min && p.relevance_min <= 5 && p.recent_hours === 72 && p.tracking_days === 7, "policy limits")
    check(p.ai && typeof p.ai.enabled === "boolean", "AI policy")
    for (const [key, value] of Object.entries(p.ai)) if (key !== "enabled") check(Number.isInteger(value) && Number(value) > 0, `AI budget ${key}`)
    return p
  }
  async snapshot(now = new Date()) {
    const base = await this.processing.snapshot(), processingState = await this.processing.status(), policy = await this.policy()
    const policyHash = hash(policy)
    const articles = base.articles.map(a => ({ ...a, sources: a.sources, label: (base.label_cache[a.id] as Row | undefined)?.label || null })) as EditorialArticle[]
    const parent = new Map(articles.map(a => [a.id, a.id]))
    const find = (id: string): string => { const p = parent.get(id)!; if (p === id) return id; const root = find(p); parent.set(id, root); return root }
    for (const cached of base.relation_cache) {
      const r = cached.relation
      if (r.kind === "duplicate" && r.decision === "accepted" && parent.has(r.left_id) && parent.has(r.right_id)) {
        const roots = [find(r.left_id), find(r.right_id)].sort(); parent.set(roots[1], roots[0])
      }
    }
    const used = new Set<string>(), bare: Row[] = []
    for (const event of base.events) {
      const roots = new Set(event.article_ids.filter(id => parent.has(id)).map(find))
      const members = articles.filter(a => roots.has(find(a.id)))
      if (members.length >= 2) { members.forEach(a => used.add(a.id)); bare.push({ id: `event:${event.id}`, articles: members }) }
    }
    for (const article of articles) if (!used.has(article.id)) {
      const root = find(article.id), members = articles.filter(a => find(a.id) === root)
      members.forEach(a => used.add(a.id)); bare.push({ id: `article:${root}`, articles: members })
    }
    const storedCurations = (await this.db.prepare("SELECT data_json FROM editorial_curations ORDER BY unit_id").all() as Row[]).map(r => JSON.parse(r.data_json) as Curation)
    const warnings: Row[] = []
    const units = bare.map((item) => {
      const members = item.articles as EditorialArticle[]
      const unit = { id: item.id, articles: members, dedup_keys: [...new Set(members.map(a => `content:${find(a.id)}`))].sort(), curation: null,
        input_hash: hash({ id: item.id, articles: members.map(a => ({ id: a.id, input_hash: a.input_hash, label: a.label })) }) } as EditorialUnit
      const curation = storedCurations.find(c => c.unit_id === unit.id)
      if (curation) { try { validateCuration(curation, unit, now); unit.curation = curation } catch { warnings.push({ unit_id: unit.id, code: "curation_source_changed" }) } }
      unit.preflight = preflight(unit, policy, now)
      return unit
    }).sort((a, b) => a.id.localeCompare(b.id))
    const cache = (await this.db.prepare("SELECT data_json FROM editorial_analyses ORDER BY created_at,analysis_id").all() as Row[])
      .map(r => JSON.parse(r.data_json) as AnalysisRecord).filter(r => units.some(u => u.id === r.unit_id && u.input_hash === r.input_hash))
    const snapshotId = hash({ processing_snapshot_id: base.snapshot_id, policy_hash: policyHash, units: units.map(u => ({ id: u.id, input_hash: u.input_hash, dedup_keys: u.dedup_keys })), curations: storedCurations })
    return { schema_version: 1, snapshot_id: snapshotId, generated_at: now.toISOString(), policy, policy_hash: policyHash, units, cache,
      processing_ready: processingState.unprocessed === 0 && processingState.stale === 0 && !processingState.snapshot_changed, warnings }
  }

  private async evaluated(snapshot: Awaited<ReturnType<EditorialStore["snapshot"]>>, version: string, model: string, now: Date) {
    const rows = await this.db.prepare("SELECT data_json FROM editorial_analyses WHERE analysis_version=? AND model=?").all(version, model) as Row[]
    const cache = rows.map(r => JSON.parse(r.data_json) as AnalysisRecord)
    return snapshot.units.map(unit => {
      const record = cache.find(r => r.unit_id === unit.id && r.input_hash === unit.input_hash)
      if (!record) return { unit_id: unit.id, analysis_id: null, section: unit.preflight?.candidate ? "pending_model" : "not_analyzed", reason: unit.preflight?.reason || "not_analyzed" }
      const evaluation = evaluateAssessment(unit, record.assessment, snapshot.policy, now)
      return { unit_id: unit.id, analysis_id: record.analysis_id, ...evaluation }
    })
  }
  private selected(snapshot: Awaited<ReturnType<EditorialStore["snapshot"]>>, evaluations: Row[], records: AnalysisRecord[]) {
    const caps: Record<string, number> = { featured: snapshot.policy.max_featured, recent: snapshot.policy.max_recent, ongoing: snapshot.policy.max_ongoing }
    const counts: Record<string, number> = {}, seen = new Set<string>(), items: Row[] = []
    for (const evaluation of [...evaluations].sort((a, b) => (b.total || 0) - (a.total || 0) || a.unit_id.localeCompare(b.unit_id))) {
      if (!(evaluation.section in caps) || (counts[evaluation.section] || 0) >= caps[evaluation.section]) continue
      const unit = snapshot.units.find(u => u.id === evaluation.unit_id)!
      if (unit.dedup_keys.some(k => seen.has(k))) continue
      const record = records.find(r => r.analysis_id === evaluation.analysis_id)!
      unit.dedup_keys.forEach(k => seen.add(k)); counts[evaluation.section] = (counts[evaluation.section] || 0) + 1
      const { age_hours: _age, future: _future, ...stableEvaluation } = evaluation
      items.push({ ...stableEvaluation, input_hash: unit.input_hash, title: unit.articles[0].title,
        assessment: record.assessment, sources: unit.articles.map(a => ({ article_id: a.id, title: a.title, url: a.canonical_url, published_at: a.published_at, publication_precision: a.publication_precision })) })
    }
    return items
  }
  async apply(input: unknown, now = new Date()) {
    check(input && typeof input === "object", "result object")
    const result = input as EditorialResult
    check(result.schema_version === 1 && /^[a-f0-9]{64}$/.test(result.run_id), "run ID/schema")
    check(["not_configured", "disabled", "processing_required", "completed", "budget_limited", "failed", "partial_error"].includes(result.state), "job state")
    check(typeof result.analysis_version === "string" && result.analysis_version.length > 0 && result.analysis_version.length <= 250 && typeof result.model === "string" && result.model.length <= 150, "analysis version/model")
    check(Array.isArray(result.analyses) && Array.isArray(result.reused_analysis_ids) && Array.isArray(result.pending) && Array.isArray(result.errors), "result arrays")
    check(result.metrics && result.metrics.actual_usage_available === false, "usage must not pretend to be actual tokens")
    await this.db.exec("BEGIN IMMEDIATE")
    try {
      const previous = await this.db.prepare("SELECT data_json FROM editorial_runs WHERE run_id=?").get(result.run_id) as Row | undefined
      if (previous) { check(stableJSON(JSON.parse(previous.data_json).result) === stableJSON(result), "run ID payload conflict"); await this.db.exec("COMMIT"); return { duplicate: true, published: false, run_id: result.run_id } }
      const snapshot = await this.snapshot(now)
      check(snapshot.snapshot_id === result.snapshot_id && snapshot.policy_hash === result.policy_hash, "stale snapshot or policy")
      check(Number.isFinite(Date.parse(result.generated_at)) && Math.abs(now.getTime() - Date.parse(result.generated_at)) <= 15 * 60000, "result generation time")
      check(result.analyses.length <= snapshot.policy.ai.max_items_per_run, "item budget exceeded")
      check(Number.isInteger(result.metrics.calls) && result.metrics.calls >= 0 && result.metrics.calls <= snapshot.policy.ai.max_calls_per_run && result.metrics.calls === result.metrics.writer_calls + result.metrics.checker_calls, "call budget")
      check(Number.isInteger(result.metrics.writer_calls) && Number.isInteger(result.metrics.checker_calls) && result.metrics.writer_calls >= result.analyses.length && result.metrics.checker_calls >= result.analyses.length && result.metrics.checker_calls <= result.metrics.writer_calls, "analysis requires writer and checker calls")
      check(Number.isInteger(result.metrics.estimated_token_upper_bound) && result.metrics.estimated_token_upper_bound >= 0 && result.metrics.estimated_token_upper_bound <= snapshot.policy.ai.estimated_token_upper_limit, "estimated token budget")
      if (["not_configured", "disabled", "processing_required"].includes(result.state)) check(!result.analyses.length && result.metrics.calls === 0, "blocked job cannot fabricate analysis")
      if (!snapshot.processing_ready) check(result.state === "processing_required", "classification input is stale")
      const ids = new Set<string>()
      for (const record of result.analyses) {
        const unit = snapshot.units.find(u => u.id === record.unit_id)
        check(unit && unit.input_hash === record.input_hash && !ids.has(record.unit_id), "analysis input")
        ids.add(record.unit_id)
        check(record.analysis_version === result.analysis_version && record.model === result.model && result.model.length > 0, "analysis provenance")
        check(record.analysis_id === hash(`${record.unit_id}:${record.input_hash}:${record.analysis_version}:${record.model}`), "analysis cache identity")
        validateAssessment(record.assessment, unit)
        const prior = await this.db.prepare("SELECT data_json FROM editorial_analyses WHERE analysis_id=?").get(record.analysis_id) as Row | undefined
        if (prior) check(stableJSON(JSON.parse(prior.data_json)) === stableJSON(record), "analysis cache conflict")
        else await this.db.prepare("INSERT INTO editorial_analyses VALUES (?,?,?,?,?,?,?)").run(record.analysis_id, record.unit_id, record.input_hash, record.analysis_version, record.model, now.toISOString(), JSON.stringify(record))
      }
      for (const id of result.reused_analysis_ids) check(await this.db.prepare("SELECT 1 FROM editorial_analyses WHERE analysis_id=?").get(id), "unknown reused analysis")
      const evaluations = await this.evaluated(snapshot, result.analysis_version, result.model, now)
      const records = (await this.db.prepare("SELECT data_json FROM editorial_analyses WHERE analysis_version=? AND model=?").all(result.analysis_version, result.model) as Row[]).map(r => JSON.parse(r.data_json) as AnalysisRecord)
      const items = this.selected(snapshot, evaluations, records)
      const coverage = { candidate_units: snapshot.units.filter(u => u.preflight?.candidate).length, analyzed_units: evaluations.filter(e => e.analysis_id).length, pending_units: evaluations.filter(e => e.section === "pending_model").length }
      const mayPublish = snapshot.processing_ready && ["completed", "budget_limited"].includes(result.state) && result.errors.length === 0 && items.length > 0
      const state = await this.db.prepare("SELECT publication_id FROM editorial_state WHERE id=1").get() as Row | undefined
      let publicationId = state?.publication_id || null, published = false
      const draft = { generated_at: now.toISOString(), state: result.state, coverage, items, evaluations }
      if (mayPublish) {
        const id = hash({ policy_hash: result.policy_hash, items })
        if (id !== publicationId) {
          const publication = { id, published_at: now.toISOString(), state: result.state, partial: result.state === "budget_limited" || coverage.pending_units > 0, coverage, items, policy_hash: result.policy_hash, analysis_version: result.analysis_version, model: result.model }
          await this.db.prepare("INSERT OR IGNORE INTO editorial_publications VALUES (?,?,?)").run(id, now.toISOString(), JSON.stringify(publication))
          publicationId = id; published = true
        }
      }
      await this.db.prepare("INSERT INTO editorial_runs VALUES (?,?,?,?,?,?)").run(result.run_id, result.snapshot_id, result.state, result.generated_at, now.toISOString(), JSON.stringify({ result, coverage, publication_id: publicationId, published, selected_count: items.length }))
      await this.db.prepare("INSERT INTO editorial_drafts VALUES (?,?)").run(result.run_id, JSON.stringify(draft))
      for (const evaluation of evaluations) await this.db.prepare("INSERT INTO editorial_evaluations VALUES (?,?,?) ON CONFLICT(unit_id) DO UPDATE SET run_id=excluded.run_id,data_json=excluded.data_json").run(evaluation.unit_id, result.run_id, JSON.stringify(evaluation))
      await this.db.prepare("INSERT INTO editorial_state VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET last_run_id=excluded.last_run_id,publication_id=excluded.publication_id").run(result.run_id, publicationId)
      await this.db.exec("COMMIT")
      return { duplicate: false, run_id: result.run_id, state: result.state, published, publication_id: publicationId, selected: items.length, coverage }
    } catch (error) { await this.db.exec("ROLLBACK"); throw error }
  }
  async status() {
    const state = await this.db.prepare(`SELECT r.data_json,r.recorded_at,p.published_at FROM editorial_state s
      LEFT JOIN editorial_runs r ON r.run_id=s.last_run_id LEFT JOIN editorial_publications p ON p.id=s.publication_id WHERE s.id=1`).get() as Row | undefined
    if (!state) return { state: "never_run", last_attempt: null, published_at: null, message: "尚未运行 AI 编辑任务" }
    const record = JSON.parse(state.data_json)
    return { state: record.result.state, last_attempt: state.recorded_at, published_at: state.published_at || null, published: record.published,
      selected_count: record.selected_count, coverage: record.coverage, metrics: record.result.metrics, errors: record.result.errors,
      message: record.result.state === "not_configured" ? "模型尚未配置；没有生成新的AI精选" : "请结合任务状态与发布日期查看结果" }
  }
  async latest(now = new Date()) {
    const row = await this.db.prepare("SELECT p.data_json FROM editorial_state s JOIN editorial_publications p ON p.id=s.publication_id WHERE s.id=1").get() as Row | undefined
    if (!row) return { id: null, published_at: null, items: [], message: "尚无已发布简报", task: await this.status() }
    const publication = JSON.parse(row.data_json), snapshot = await this.snapshot(now)
    const items: Row[] = [], outdated: Row[] = []
    for (const item of publication.items) {
      const unit = snapshot.units.find(u => u.id === item.unit_id)
      if (!unit || unit.input_hash !== item.input_hash) { outdated.push({ unit_id: item.unit_id, reason: "source_changed" }); continue }
      const evaluation = evaluateAssessment(unit, item.assessment, snapshot.policy, now)
      if (!["featured", "recent", "ongoing"].includes(evaluation.section)) { outdated.push({ unit_id: item.unit_id, reason: evaluation.reason }); continue }
      items.push({ ...item, current_evaluation: evaluation })
    }
    return { id: publication.id, published_at: publication.published_at, coverage: publication.coverage, partial: publication.partial, items, outdated, task: await this.status() }
  }
  async history(limit = 20, offset = 0) {
    const total = await this.db.prepare("SELECT COUNT(*) AS count FROM editorial_publications").get() as Row
    const rows = await this.db.prepare("SELECT id,published_at,data_json FROM editorial_publications ORDER BY published_at DESC,id LIMIT ? OFFSET ?").all(limit, offset) as Row[]
    return { total: total.count, items: rows.map(r => { const p = JSON.parse(r.data_json); return { id: r.id, published_at: r.published_at, partial: p.partial, count: p.items.length, coverage: p.coverage } }) }
  }
  async article(id: string) {
    const snapshot = await this.snapshot()
    const unit = snapshot.units.find(u => u.articles.some(a => a.id === id))
    if (!unit) return null
    const record = [...snapshot.cache].reverse().find(r => r.unit_id === unit.id && r.input_hash === unit.input_hash)
    return { unit_id: unit.id, curation: unit.curation, preflight: unit.preflight, analysis: record ? { assessment: record.assessment, model: record.model, analysis_version: record.analysis_version, ...evaluateAssessment(unit, record.assessment, snapshot.policy, new Date()) } : null }
  }
  async publication(id: string) { const row = await this.db.prepare("SELECT data_json FROM editorial_publications WHERE id=?").get(id) as Row | undefined; return row ? { ...JSON.parse(row.data_json), archive: true } : null }
  async draft() { const row = await this.db.prepare("SELECT d.data_json FROM editorial_state s JOIN editorial_drafts d ON d.run_id=s.last_run_id WHERE s.id=1").get() as Row | undefined; return row ? JSON.parse(row.data_json) : null }
  async curate(value: Curation, now = new Date()) {
    const snapshot = await this.snapshot(now), unit = snapshot.units.find(u => u.id === value.unit_id)
    check(unit, "curation unit not found"); validateCuration(value, unit, now)
    await this.db.exec("BEGIN IMMEDIATE")
    try {
      await this.db.prepare("INSERT INTO editorial_curations VALUES (?,?,?) ON CONFLICT(unit_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at").run(value.unit_id, JSON.stringify(value), now.toISOString())
      await this.db.prepare("INSERT INTO editorial_curation_audit(unit_id,action,reason,data_json,changed_at) VALUES (?,?,?,?,?)").run(value.unit_id, "set", value.reason, JSON.stringify(value), now.toISOString())
      await this.db.exec("COMMIT"); return { unit_id: value.unit_id, requires_rerun: true }
    } catch (error) { await this.db.exec("ROLLBACK"); throw error }
  }
  async clearCuration(id: string, reason: string, now = new Date()) {
    check(typeof reason === "string" && reason.length > 0 && reason.length <= 1000, "curation removal reason")
    await this.db.exec("BEGIN IMMEDIATE")
    try {
      const prior = await this.db.prepare("SELECT data_json FROM editorial_curations WHERE unit_id=?").get(id) as Row | undefined
      check(prior, "curation not found")
      await this.db.prepare("DELETE FROM editorial_curations WHERE unit_id=?").run(id)
      await this.db.prepare("INSERT INTO editorial_curation_audit(unit_id,action,reason,data_json,changed_at) VALUES (?,?,?,?,?)").run(id, "clear", reason, prior.data_json, now.toISOString())
      await this.db.exec("COMMIT"); return { unit_id: id, removed: true }
    } catch (error) { await this.db.exec("ROLLBACK"); throw error }
  }
}
