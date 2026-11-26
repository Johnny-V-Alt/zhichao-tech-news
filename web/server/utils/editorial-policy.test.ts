import { describe, expect, it } from "vitest"
import { evaluateAssessment, evaluateTime, preflight, validateAssessment, validateCuration } from "./editorial-policy"
import { NOW, assessment, policy, unit } from "../../test/editorial-fixtures"

describe("editorial time and evidence policy", () => {
  it.each([[24, 5], [24.001, 4], [72, 4], [72.001, 2], [168, 2], [168.001, 0]])("computes conservative time score at %s hours", (hours, expected) => {
    const u = unit(new Date(NOW.getTime() - hours * 3600000).toISOString())
    expect(evaluateTime(u, policy, NOW).time_score).toBe(expected)
  })
  it("computes weighted score in code and caps source evidence", () => {
    const u = unit(), a = assessment(u)
    expect(evaluateAssessment(u, a, policy, NOW)).toMatchObject({ total: 96, section: "featured" })
    u.articles[0].content_status = "source_summary"
    expect(evaluateAssessment(u, a, policy, NOW).total).toBe(92)
    a.verification = "vendor_claim"
    expect(evaluateAssessment(u, a, policy, NOW).scores.evidence).toBe(3)
  })
  it("does not refresh old news using crawl/modified dates or scores", () => {
    const u = unit("2020-01-01T00:00:00Z")
    Object.assign(u.articles[0], { crawled_at: NOW.toISOString(), modified_at: NOW.toISOString() })
    expect(evaluateAssessment(u, assessment(u), policy, NOW).section).toBe("history")
  })
  it("leaves missing/future dates and title-only input unqualified", () => {
    const u = unit()
    u.articles[0].published_at = null
    expect(preflight(u, policy, NOW).reason).toBe("unknown_publication_date")
    u.articles[0].published_at = "2026-11-27T00:00:00Z"
    expect(evaluateAssessment(u, assessment(u), policy, NOW).reason).toBe("future_date")
    u.articles[0].content_status = "title_only"
    expect(preflight(u, policy, NOW).candidate).toBe(false)
  })
  it("allows an explicitly curated 5-day major story without pretending it is new", () => {
    const u = unit(new Date(NOW.getTime() - 5 * 86400000).toISOString())
    expect(evaluateAssessment(u, assessment(u), policy, NOW).section).toBe("background")
    u.curation = { unit_id: u.id, reason: "持续关注的重要研究事件", major_ongoing: true, verification_note: "仍按来源报道状态追踪", verified_update: null, include_updated_resource: false }
    expect(evaluateAssessment(u, assessment(u), policy, NOW)).toMatchObject({ total: 78, section: "ongoing", reason: "major_event_tracking_exception" })
  })
  it("keeps old tutorials in background unless a dated update is explicitly curated", () => {
    const u = unit("2020-01-01T00:00:00Z"), a = assessment(u)
    u.articles[0].label = { content_type: "tutorial", method: "rules" }; a.content_type = "tutorial"
    expect(preflight(u, policy, NOW).reason).toBe("background_resource")
    u.curation = { unit_id: u.id, reason: "正文有明确的实质更新", major_ongoing: false, verification_note: "已核对来源更新文字", verified_update: { date: "2026-11-26", citation: { article_id: "a", quote: "Python 4.0 was released on 2026-11-26." } }, include_updated_resource: true }
    expect(evaluateAssessment(u, a, policy, NOW)).toMatchObject({ section: "featured", time_basis: "verified_substantive_update", original_date: "2020-01-01T00:00:00Z" })
  })
  it("rejects fabricated quotes, quantities, and a fake checker pass", () => {
    const u = unit(), a = assessment(u)
    a.facts[0].text = "软件发布了 8.0 版本。"
    expect(() => validateAssessment(a, u)).toThrow("numeric")
    a.facts[0].text = "软件发布了预览版。"; a.facts[0].citations[0].quote = "Not in the source"
    expect(() => validateAssessment(a, u)).toThrow("citation")
    const b = assessment(u); b.checker.checks[0].supported = false
    expect(() => validateAssessment(b, u)).toThrow("consistency")
  })
  it("honors manual exclusions and unverified/conflicting content", () => {
    const u = unit(), a = assessment(u)
    a.verification = "conflicting"
    expect(evaluateAssessment(u, a, policy, NOW).section).toBe("review")
    a.verification = "source_report"; u.articles[0].label = { method: "manual", technology_relevance: "out_of_scope", content_type: "news" }
    expect(evaluateAssessment(u, a, policy, NOW).section).toBe("excluded")
  })
  it("accepts date precision without inventing hours and rejects impossible dates", () => {
    const u = unit("2026-11-26")
    expect(evaluateTime(u, policy, NOW)).toMatchObject({ original_date: "2026-11-26", time_score: 5 })
    u.articles[0].published_at = "2026-02-30"
    expect(() => evaluateTime(u, policy, NOW)).toThrow("calendar")
    u.curation = { unit_id: u.id, reason: "x", major_ongoing: false, verification_note: "x", verified_update: null, include_updated_resource: true }
    expect(() => validateCuration(u.curation!, u, NOW)).toThrow("verified update")
  })
  it("uses an explicit older event date instead of a fresh repost date", () => {
    const u = unit(), a = assessment(u)
    u.articles[0].content_text += " The event happened on 2026-10-01."
    a.event_date = { value: "2026-10-01", citation: { article_id: "a", quote: "The event happened on 2026-10-01." } }
    expect(evaluateAssessment(u, a, policy, NOW)).toMatchObject({ section: "history", time_basis: "explicit_older_event", effective_date: "2026-10-01" })
  })
})
