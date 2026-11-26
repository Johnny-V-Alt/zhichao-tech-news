// Local administration and orchestration around the existing PowerShell pipeline.
// Uses Node built-ins; collection and analysis stay in the reused upstream modules.
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto"
import { readFile, writeFile, mkdir, rename, readdir, open, unlink } from "node:fs/promises"
import { existsSync, openSync, closeSync } from "node:fs"
import { resolve, join } from "node:path"
import { spawn } from "node:child_process"
import process from "node:process"
import { getContentStore } from "../database/content"

type Row = Record<string, any>
const valid = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
export const digestKey = (key: string) => createHash("sha256").update(key).digest()
export function equalKeys(a: string, b: string) { return timingSafeEqual(digestKey(a), digestKey(b)) }
export function signSession(key: string, expires = Date.now() + 8 * 3600000) {
  const payload = Buffer.from(JSON.stringify({ expires, nonce: randomBytes(12).toString("hex") })).toString("base64url")
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`
}
export function verifySession(token: string | undefined, key: string, now = Date.now()) {
  try {
    const [payload, signature, extra] = (token || "").split(".")
    if (extra || !payload || !signature || token!.length > 1000) return false
    const expected = createHmac("sha256", key).update(payload).digest("base64url")
    return equalKeys(expected, signature) && JSON.parse(Buffer.from(payload, "base64url").toString()).expires > now
  } catch { return false }
}
export function validateSources(config: Row) {
  valid(config && Array.isArray(config.sources) && config.sources.length > 0 && config.sources.length <= 60, "需要1–60个来源")
  valid(Number.isInteger(config.interval_seconds) && config.interval_seconds >= 60 && config.interval_seconds <= 86400, "采集间隔为60–86400秒")
  valid(Number.isInteger(config.max_body_reads) && config.max_body_reads >= 0 && config.max_body_reads <= 20, "每轮正文读取数为0–20")
  const ids = new Set()
  for (const source of config.sources) {
    valid(/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id) && !ids.has(source.id), "来源ID无效或重复")
    ids.add(source.id)
    valid(typeof source.name === "string" && source.name.trim().length > 0 && source.name.length <= 100, "来源名称无效")
    valid(["rss", "newsnow"].includes(source.adapter), "仅支持RSS和现有NewsNow适配器")
    valid(["tech_media", "tech_hotlist", "official_release", "developer_blog", "tutorial", "research"].includes(source.kind), "来源类型无效")
    const url = new URL(source.url)
    valid(url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && url.hostname.includes(".") && !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\[|\.local$/.test(url.hostname), "来源必须是公开HTTPS地址")
    valid(Number.isInteger(source.max_items) && source.max_items >= 1 && source.max_items <= 100, "每源采集数量为1–100")
    valid(source.enabled === undefined || typeof source.enabled === "boolean", "启用状态无效")
    valid(source.read_body === undefined || typeof source.read_body === "boolean", "正文状态无效")
    if (source.adapter === "newsnow") valid(typeof source.upstream_id === "string" && /^[a-z0-9-]{1,80}$/.test(source.upstream_id), "需要有效的NewsNow适配器ID")
  }
  return config
}

export class Operations {
  readonly directory: string
  private secretPromise?: Promise<string>
  private timer?: ReturnType<typeof setInterval>
  private pending: Promise<unknown> = Promise.resolve()
  constructor(readonly root = process.env.PORTAL_APP_ROOT || resolve("..")) { this.directory = join(root, "data", "operations") }
  async init() { await mkdir(join(this.directory, "jobs"), { recursive: true }); return this }
  async read(name: string, fallback: any = null): Promise<any> { try { return JSON.parse(await readFile(join(this.directory, name), "utf-8")) } catch (e: any) { if (e.code === "ENOENT") return fallback; throw e } }
  async save(name: string, value: unknown) {
    await this.init()
    const target = join(this.directory, name), temporary = `${target}.${randomBytes(5).toString("hex")}.partial`
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 }); await rename(temporary, target)
  }
  serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action, action); this.pending = result.catch(() => {}); return result
  }
  async key() {
    this.secretPromise ??= (async () => {
      await this.init()
      const path = join(this.directory, "admin-key.txt")
      try { await writeFile(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }) } catch (e: any) { if (e.code !== "EEXIST") throw e }
      const key = (await readFile(path, "utf-8")).trim(); valid(/^[a-f0-9]{64}$/.test(key), "本机管理码文件损坏"); return key
    })()
    return this.secretPromise
  }
  async audit(action: string, detail: Row) {
    const history = await this.read("audit.json", [])
    history.unshift({ id: randomBytes(12).toString("hex"), at: new Date().toISOString(), action, ...detail })
    await this.save("audit.json", history.slice(0, 1000))
  }
  async sourceConfig() { return JSON.parse(await readFile(join(this.root, "config", "sources.json"), "utf-8")) }
  async settings() { return this.read("settings.json", { auto_collect: true, retry_seconds: 300 }) }
  async changeSettings(value: Row) {
    valid(typeof value.auto_collect === "boolean" && Number.isInteger(value.retry_seconds) && value.retry_seconds >= 60 && value.retry_seconds <= 86400, "运行设置无效")
    const next = { auto_collect: value.auto_collect, retry_seconds: value.retry_seconds }
    await this.save("settings.json", next); await this.audit("settings", next); return next
  }
  async changeSources(value: Row) {
    // Keep local collection endpoint/timeouts unchanged; never accept arbitrary commands.
    const current = await this.sourceConfig()
    const next = validateSources({ ...current, sources: value.sources, interval_seconds: value.interval_seconds, max_body_reads: value.max_body_reads })
    await this.save(`sources-backup-${Date.now()}.json`, current)
    const target = join(this.root, "config", "sources.json")
    await writeFile(`${target}.partial`, JSON.stringify(next, null, 2)); await rename(`${target}.partial`, target)
    await this.audit("sources", { source_ids: next.sources.map((s: Row) => s.id), interval_seconds: next.interval_seconds })
    return { saved: true }
  }
  async jobs() {
    await this.init()
    const files = (await readdir(join(this.directory, "jobs"))).filter(f => /^[a-f0-9]{24}\.json$/.test(f))
    const jobs: Row[] = await Promise.all(files.map(async f => JSON.parse((await readFile(join(this.directory, "jobs", f), "utf-8")).replace(/^\uFEFF/, ""))))
    for (const job of jobs) if (["queued", "running"].includes(job.state) && Date.now() - Date.parse(job.started_at) > 15000) {
      let alive = false
      try { if (job.pid) { process.kill(job.pid, 0); alive = true } } catch {}
      if (!alive) { job.state = "interrupted"; job.finished_at = new Date().toISOString(); await this.save(`jobs/${job.id}.json`, job) }
    }
    return jobs.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 50)
  }
  async startJob(kind: string, trigger = "manual") {
    valid(["collect", "process", "editorial"].includes(kind), "未知任务类型")
    const jobs = await this.jobs()
    valid(!jobs.some(j => ["queued", "running"].includes(j.state)), "已有任务运行中，请等待完成")
    const lockPath = join(this.directory, "job.lock")
    let lock
    try { lock = await open(lockPath, "wx") } catch (e: any) {
      if (e.code !== "EEXIST") throw e
      await unlink(lockPath); lock = await open(lockPath, "wx")
    }
    const id = randomBytes(12).toString("hex"), stamp = new Date().toISOString()
    const job: Row = { id, kind, trigger, state: "queued", started_at: stamp, finished_at: null, exit_code: null, pid: null }
    await lock.writeFile(id); await lock.close()
    await this.save(`jobs/${id}.json`, job)
    const logPath = join(this.directory, "jobs", `${id}.log`), out = openSync(logPath, "a")
    const shell = process.env.PORTAL_POWERSHELL || (existsSync("C:/Program Files/PowerShell/7/pwsh.exe") ? "C:/Program Files/PowerShell/7/pwsh.exe" : "powershell.exe")
    try {
      const child = spawn(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(this.root, "scripts", "job-runner.ps1"), "-JobId", id, "-Kind", kind], { cwd: this.root, windowsHide: true, stdio: ["ignore", out, out], env: { ...process.env, PORTAL_JOB_ROOT: this.root } })
      child.on("error", async () => { await this.save(`jobs/${id}.json`, { ...job, state: "failed", finished_at: new Date().toISOString(), exit_code: -1 }); await unlink(lockPath).catch(() => {}) })
      job.pid = child.pid || null
      // Runner owns subsequent state writes, including completion after a web restart.
      await this.audit("job", { id, kind, trigger })
      return { ...job, pid: child.pid || null }
    } finally { closeSync(out) }
  }
  async publicState() {
    const settings = await this.settings(), config = await this.sourceConfig(), jobs = await this.jobs()
    let collected = null
    try { collected = JSON.parse((await readFile(join(this.root, "data", "last-run.json"), "utf-8")).replace(/^\uFEFF/, "")) } catch {}
    const previous = jobs.find(j => j.kind === "collect")
    const base = previous?.finished_at || previous?.started_at || collected?.checked_at
    const interval = previous && ["failed", "interrupted"].includes(previous.state) ? settings.retry_seconds : config.interval_seconds
    const next = settings.auto_collect && process.env.PORTAL_AUTOMATION_DISABLED !== "1" ? new Date(Math.max(Date.now(), base ? Date.parse(base) + interval * 1000 : Date.now())).toISOString() : null
    return { auto_collect: settings.auto_collect, scheduler_active: !!this.timer && process.env.PORTAL_AUTOMATION_DISABLED !== "1", interval_seconds: config.interval_seconds, retry_seconds: settings.retry_seconds, next_run_at: next,
      jobs: jobs.slice(0, 10).map(({ pid: _pid, ...job }) => job), configured_sources: config.sources.map(({ id, name, enabled = true, kind, url }: Row) => ({ id, name, enabled, kind, url })) }
  }
  async tick() {
    if (process.env.PORTAL_AUTOMATION_DISABLED === "1") return
    await this.serial(async () => {
      const state = await this.publicState()
      if (!state.auto_collect || state.jobs.some(j => ["queued", "running"].includes(j.state))) return
      if (state.next_run_at && Date.parse(state.next_run_at) <= Date.now() + 1000) await this.startJob("collect", "schedule")
    })
  }
  startScheduler() {
    if (this.timer) return
    this.timer = setInterval(() => { this.tick().catch(() => {}) }, 15000); this.timer.unref()
    const initial = setTimeout(() => { this.tick().catch(() => {}) }, 5000); initial.unref()
  }
  stopScheduler() { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  async picks() { return this.read("picks.json", []) }
  async pick(value: Row) {
    const store = await getContentStore(), article = await store.article(value.article_id, false)
    valid(article, "文章不存在")
    valid(article!.published_at && (article!.content_text?.length || 0) >= 120, "需要可靠发布日期及足够的正文材料")
    const published = article!.published_at!.length === 10 ? `${article!.published_at}T00:00:00+08:00` : article!.published_at!
    const age = (Date.now() - Date.parse(published)) / 3600000
    valid(Number.isFinite(age) && age >= -5 / 60 && age <= (value.ongoing ? 168 : 72), "日期超出推荐范围；重大跟踪也限7天")
    valid(article!.processing?.label?.technology_relevance !== "out_of_scope", "内容已被排除为非计算机科技")
    valid(!article!.processing?.label || ["news", "unknown"].includes(article!.processing.label.content_type), "普通教程、知识等背景资源不进入近期精选")
    valid(typeof value.reason === "string" && value.reason.trim().length >= 5 && value.reason.length <= 1000, "请填写至少5字的推荐理由")
    valid(typeof value.verification_note === "string" && value.verification_note.trim().length >= 5 && value.verification_note.length <= 1000, "请填写核验说明")
    valid(typeof value.quote === "string" && value.quote.trim().length >= 5 && value.quote.length <= 250 && article!.content_text?.includes(value.quote), "引文须来自已保存正文（5–250字）")
    valid(typeof value.ongoing === "boolean", "跟踪标记无效")
    const entry = { article_id: article!.id, reason: value.reason, verification_note: value.verification_note, quote: value.quote, ongoing: value.ongoing, created_at: new Date().toISOString() }
    const active = (await this.picks()).filter((p: Row) => p.article_id !== entry.article_id)
    valid(active.length < 50, "人工推荐最多保留50条，请先撤下旧条目")
    await this.save("picks.json", [entry, ...active]); await this.audit("pick", entry); return { saved: true }
  }
  async unpick(id: string, reason: string) {
    valid(typeof reason === "string" && reason.trim().length > 0 && reason.length <= 1000, "需要撤下原因")
    await this.save("picks.json", (await this.picks()).filter((p: Row) => p.article_id !== id)); await this.audit("unpick", { article_id: id, reason }); return { removed: true }
  }
  async recommendations() {
    const store = await getContentStore(), result: Row[] = [], seen = new Set<string>()
    for (const pick of await this.picks()) {
      const article = await store.article(pick.article_id, false)
      if (!article || !article.published_at || !article.content_text?.includes(pick.quote) || article.processing?.label?.technology_relevance === "out_of_scope" || (article.processing?.label && !["news", "unknown"].includes(article.processing.label.content_type))) continue
      const date = article.published_at.length === 10 ? `${article.published_at}T00:00:00+08:00` : article.published_at
      const age = (Date.now() - Date.parse(date)) / 3600000
      if (!Number.isFinite(age) || age < -5 / 60 || age > (pick.ongoing ? 168 : 72)) continue
      const key = article.processing.event?.id || article.id
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ ...pick, title: article.title, published_at: article.published_at, publication_precision: article.publication_precision, sources: article.sources.map((s: Row) => ({ name: s.name, url: s.original_url })), topics: article.processing.label?.topics || [], method: "manual", score: null })
    }
    return { items: result.slice(0, 10), message: "人工推荐，不代表已完成AI分析或独立事实核验" }
  }
  async adminState() {
    const store = await getContentStore()
    return { ...await this.publicState(), sources: await this.sourceConfig(), settings: await this.settings(), audit: (await this.read("audit.json", [])).slice(0, 100), picks: await this.picks(), overrides: (await store.processing.snapshot()).overrides,
      model_configured: !!(process.env.AI_API_KEY && process.env.AI_MODEL), model_enabled: process.env.EDITORIAL_AI_ENABLED === "1" || (await store.editorial.policy()).ai.enabled }
  }
  async jobLog(id: string) {
    valid(/^[a-f0-9]{24}$/.test(id), "任务ID无效")
    let text = ""
    try { text = (await readFile(join(this.directory, "jobs", `${id}.log`), "utf-8")).slice(-16000) } catch (e: any) { if (e.code !== "ENOENT") throw e }
    if (process.env.AI_API_KEY) text = text.replaceAll(process.env.AI_API_KEY, "[REDACTED]")
    return { text }
  }
}
let operations: Operations | undefined
export const getOperations = () => operations ??= new Operations()
