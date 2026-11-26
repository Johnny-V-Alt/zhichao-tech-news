import { describe, it, expect } from "vitest"
import { equalKeys, signSession, verifySession, validateSources } from "./operations"

const config = () => ({ interval_seconds: 1800, max_body_reads: 5, sources: [{ id: "media", name: "Media", adapter: "rss", url: "https://example.com/feed.xml", kind: "tech_media", max_items: 12, enabled: true }] })
describe("local management access and configuration", () => {
  it("rejects forged, expired and other-key sessions", () => {
    const key = "a".repeat(64), token = signSession(key, 5000)
    expect(verifySession(token, key, 4000)).toBe(true)
    expect(verifySession(token, key, 5000)).toBe(false)
    expect(verifySession(token, "b".repeat(64), 4000)).toBe(false)
    expect(verifySession(token + "x", key, 4000)).toBe(false)
    expect(verifySession(undefined, key)).toBe(false)
    expect(equalKeys(key, "short")).toBe(false)
  })
  it.each(["http://example.com/feed", "https://127.0.0.1/feed", "https://10.0.0.1/feed", "https://user:pass@example.com/feed", "file:///tmp/feed", "https://example.com:999/feed", "https://x.local/feed"])("rejects non-public or credential-bearing source %s", url => {
    const value = config(); value.sources[0].url = url; expect(() => validateSources(value)).toThrow()
  })
  it("accepts public RSS configuration, rejects duplicate IDs and invalid budgets", () => {
    expect(validateSources(config()).sources).toHaveLength(1)
    const value = config(); value.sources.push({ ...value.sources[0] }); expect(() => validateSources(value)).toThrow()
    value.sources.pop(); value.interval_seconds = 0; expect(() => validateSources(value)).toThrow()
    value.interval_seconds = 1800; value.max_body_reads = 999; expect(() => validateSources(value)).toThrow()
  })
})
