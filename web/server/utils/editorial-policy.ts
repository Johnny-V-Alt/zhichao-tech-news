import { createHash } from "node:crypto"
import { contentTypes, topicIds } from "../../shared/processing"
import type { Assessment, Citation, Curation, EditorialPolicy, EditorialUnit, GroundedText } from "../../shared/editorial"

export function stableJSON(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(",")}}`
  return JSON.stringify(value)
}
export const editorialHash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : stableJSON(value)).digest("hex")
export function editorialCheck(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Invalid editorial data: ${reason}`) }
const check: typeof editorialCheck = editorialCheck
export function explicitDates(text: string) {
  return [...text.matchAll(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日)?/g)].map(m => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`)
}
function dateStart(value: string) {
  const day = value.slice(0, 10), calendar = Date.parse(`${day}T00:00:00Z`)
  check(/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(calendar) && new Date(calendar).toISOString().slice(0, 10) === day, "invalid calendar date")
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T00:00:00+08:00`)
    check(new Date(ms + 8 * 3600000).toISOString().slice(0, 10) === value, "invalid calendar date")
    return ms
  }
  check(/(?:Z|[+-]\d{2}:\d{2})$/.test(value), "date must include timezone")
  const ms = Date.parse(value); check(Number.isFinite(ms), "invalid source date"); return ms
}
export function validateCuration(value: Curation, unit: EditorialUnit, now: Date) {
  check(value.unit_id === unit.id && typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 1000, "curation reason")
  check(typeof value.major_ongoing === "boolean" && typeof value.include_updated_resource === "boolean", "curation flags")
  check(typeof value.verification_note === "string" && value.verification_note.length > 0 && value.verification_note.length <= 1000, "curation verification note")
  check(value.excluded === undefined || typeof value.excluded === "boolean", "curation exclusion")
  if (value.verified_update) {
    const update = value.verified_update
    validateCitation(update.citation, unit)
    check(explicitDates(update.citation.quote).includes(update.date), "update date is not explicit in citation")
    check(dateStart(update.date) <= now.getTime(), "future substantive update")
  }
  check(!value.include_updated_resource || !!value.verified_update, "updated resource needs a verified update")
}
export function claims(a: Assessment): { claim_id: string, claim: GroundedText }[] {
  return [...a.facts.map((c, i) => ({ claim_id: `fact:${i}`, claim: c })),
    ...a.changes.map((c, i) => ({ claim_id: `change:${i}`, claim: c })), { claim_id: "significance", claim: a.significance },
    ...["relevance", "evidence", "impact", "novelty"].map(k => ({ claim_id: `score:${k}`, claim: a.scores[k as keyof Assessment["scores"]].reason }))]
}
export function validateCitation(c: Citation, unit: EditorialUnit) {
  check(c && typeof c.quote === "string" && c.quote.length > 0 && c.quote.length <= 250, "citation quote")
  const article = unit.articles.find(a => a.id === c.article_id)
  check(article && ["full_text", "source_summary"].includes(article.content_status) && article.content_text?.includes(c.quote), "citation is not in source content")
}
function numericTokens(text: string) {
  const normalized = text.replace(/(?<=\d),(?=\d{3}\b)/g, "")
  return [...normalized.replace(/−/g, "-").matchAll(/(?<![A-Za-z0-9])-?\d+(?:\.\d+)*/g)].map(m => m[0])
}
function quantities(text: string) {
  return [...text.toLowerCase().matchAll(/\d+(?:\.\d+)?\s*(?:gb|tb|mb|nm|%|美元|元|倍|ms|秒|小时|watts?)/g)].map(m => m[0].replace(/\s/g, ""))
}
export function validateAssessment(a: Assessment, unit: EditorialUnit) {
  check(a && contentTypes.includes(a.content_type), "assessment content type")
  check(["relevant", "out_of_scope", "uncertain"].includes(a.technology_relevance), "technology relevance")
  check(Array.isArray(a.topics) && a.topics.every(t => topicIds.includes(t as typeof topicIds[number])), "assessment topics")
  check(["source_report", "vendor_claim", "conflicting", "unverified"].includes(a.verification), "verification state")
  check(Array.isArray(a.facts) && a.facts.length > 0 && a.facts.length <= 4 && Array.isArray(a.changes) && a.changes.length <= 2, "facts and changes")
  check([...a.facts, ...a.changes].every(c => c && c.inference !== true), "facts cannot be editorial inference")
  for (const dimension of ["relevance", "evidence", "impact", "novelty"] as const) {
    const d = a.scores?.[dimension]
    check(d && typeof d.value === "number" && Number.isFinite(d.value) && d.value >= 0 && d.value <= 5, "dimension score")
  }
  for (const { claim } of claims(a)) {
    check(claim && typeof claim.text === "string" && claim.text.length > 0 && claim.text.length <= 600 && Array.isArray(claim.citations) && claim.citations.length > 0 && claim.citations.length <= 4, "grounded text")
    check(claim.inference === undefined || typeof claim.inference === "boolean", "inference flag")
    for (const citation of claim.citations) validateCitation(citation, unit)
    const quoted = claim.citations.map(c => c.quote).join("\n")
    const nums = new Set(numericTokens(quoted)), units = new Set(quantities(quoted))
    check(numericTokens(claim.text).every(n => nums.has(n)), "unsupported numeric claim")
    check(quantities(claim.text).every(q => units.has(q)), "unsupported quantity or unit")
  }
  if (a.event_date) {
    validateCitation(a.event_date.citation, unit)
    check(explicitDates(a.event_date.citation.quote).includes(a.event_date.value), "event date lacks explicit source date")
    dateStart(a.event_date.value)
  }
  const expected = new Set(claims(a).map(c => c.claim_id))
  check(a.checker && Array.isArray(a.checker.checks) && a.checker.checks.length === expected.size, "checker must cover every claim")
  for (const row of a.checker.checks) {
    check(expected.delete(row.claim_id) && row.supported === true && typeof row.reason === "string" && row.reason.length > 0 && row.reason.length <= 1000, "claim did not pass source-consistency check")
  }
}

export function evaluateTime(unit: EditorialUnit, policy: EditorialPolicy, now: Date, assessment?: Assessment) {
  const dates = unit.articles.filter(a => a.published_at).map(a => ({ value: a.published_at!, ms: dateStart(a.published_at!) })).sort((a, b) => a.ms - b.ms)
  const original = dates[0] || null
  const dateConflict = !!(assessment?.event_date && original && dateStart(assessment.event_date.value) > original.ms + 86400000)
  let effective = original, basis = "original_publication"
  if (assessment?.event_date && (!effective || dateStart(assessment.event_date.value) < effective.ms)) {
    effective = { value: assessment.event_date.value, ms: dateStart(assessment.event_date.value) }; basis = "explicit_older_event"
  }
  if (unit.curation?.verified_update) {
    validateCuration(unit.curation, unit, now)
    const date = unit.curation.verified_update.date
    check(!original || dateStart(date) >= original.ms - 86400000, "substantive update predates original event")
    effective = { value: date, ms: dateStart(date) }; basis = "verified_substantive_update"
  }
  const age = effective ? (now.getTime() - effective.ms) / 3600000 : null
  const future = age !== null && age < -policy.max_future_skew_minutes / 60
  const timeScore = age === null || future ? 0 : age <= 24 ? 5 : age <= 72 ? 4 : age <= 168 ? 2 : 0
  return { original_date: original?.value || null, effective_date: effective?.value || null, time_basis: basis, age_hours: age, time_score: timeScore, future, date_conflict: dateConflict }
}
export function preflight(unit: EditorialUnit, policy: EditorialPolicy, now: Date) {
  const time = evaluateTime(unit, policy, now)
  let reason = "ready"
  const content = unit.articles.some(a => ["full_text", "source_summary"].includes(a.content_status) && (a.content_text?.trim().length || 0) >= policy.minimum_content_chars)
  const manualBackground = unit.articles.every(a => a.label?.method === "manual" && a.label?.content_type !== "news" && a.label?.content_type !== "unknown")
  const background = unit.articles.every(a => a.label && !["news", "unknown"].includes(a.label.content_type))
  if (unit.curation?.excluded) reason = "manual_exclusion"
  else if (unit.articles.some(a => a.label?.method === "manual" && a.label?.technology_relevance === "out_of_scope")) reason = "manual_exclusion"
  else if (!content) reason = "insufficient_content"
  else if (!time.effective_date) reason = "unknown_publication_date"
  else if (time.future) reason = "future_date"
  else if ((background || manualBackground) && !(unit.curation?.include_updated_resource && unit.curation?.verified_update)) reason = "background_resource"
  else if (time.age_hours! > policy.recent_hours && !(time.age_hours! <= policy.tracking_days * 24 && unit.curation?.major_ongoing)) reason = "outside_recent_window"
  return { ...time, candidate: reason === "ready", reason }
}
export function evaluateAssessment(unit: EditorialUnit, assessment: Assessment, policy: EditorialPolicy, now: Date) {
  validateAssessment(assessment, unit)
  const time = evaluateTime(unit, policy, now, assessment)
  const scores = Object.fromEntries(["relevance", "evidence", "impact", "novelty"].map(k => [k, assessment.scores[k as keyof Assessment["scores"]].value])) as Record<string, number>
  const cited = new Set(claims(assessment).flatMap(c => c.claim.citations.map(s => s.article_id)))
  const citedArticles = unit.articles.filter(a => cited.has(a.id))
  const onlySummary = citedArticles.every(a => a.content_status !== "full_text")
  const allOfficial = citedArticles.every(a => a.sources.length && a.sources.every(s => s.kind === "official_release"))
  scores.evidence = Math.min(scores.evidence, onlySummary || allOfficial || assessment.verification === "vendor_claim" ? 3 : 4)
  scores.timeliness = time.time_score
  const total = Math.round(Object.entries(policy.weights).reduce((sum, [k, w]) => sum + scores[k] / 5 * w, 0) * 100) / 100
  let section = "review", reason = "insufficient_evidence"
  const initial = preflight(unit, policy, now)
  if (initial.reason === "manual_exclusion" || assessment.technology_relevance === "out_of_scope" || scores.relevance < policy.relevance_min) { section = "excluded"; reason = "not_computer_technology" }
  else if (assessment.technology_relevance !== "relevant" || ["conflicting", "unverified"].includes(assessment.verification)) reason = "uncertain_or_conflicting"
  else if (!time.effective_date) reason = "unknown_publication_date"
  else if (time.future) reason = "future_date"
  else if (time.date_conflict && !unit.curation?.verified_update) reason = "event_date_conflicts_with_publication"
  else if (initial.reason === "background_resource" || (!unit.curation?.include_updated_resource && assessment.content_type !== "news")) { section = "background"; reason = "background_resource" }
  else if (initial.reason === "insufficient_content") reason = "insufficient_content"
  else if (time.age_hours! > policy.tracking_days * 24) { section = "history"; reason = "old_event" }
  else if (time.age_hours! > policy.recent_hours) {
    if (unit.curation?.major_ongoing && total >= policy.recent_min) { section = "ongoing"; reason = "major_event_tracking_exception" }
    else { section = "background"; reason = "older_than_recent_window" }
  } else if (total >= policy.featured_min) { section = "featured"; reason = "score_and_evidence_qualified" }
  else if (total >= policy.recent_min) { section = "recent"; reason = "recent_candidate" }
  else { section = "archive"; reason = "below_score_threshold" }
  return { ...time, scores, total, section, reason, tracking_note: section === "ongoing" ? unit.curation?.reason || null : null, verification_note: unit.curation?.verification_note || null }
}
