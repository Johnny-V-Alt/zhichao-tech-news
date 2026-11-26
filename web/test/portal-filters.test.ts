import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, dirname, basename } from "node:path"
import { describe, it, expect } from "vitest"
import { ContentStore } from "../server/database/content"
import { seed, NOW } from "./editorial-fixtures"

describe("portal temporal filters", () => {
  it("filters original dates across timezone offsets, retains unknowns separately, and filters saved IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "portal-filter-test-")), store = await new ContentStore(join(directory, "db.sqlite3")).init()
    try {
      await seed(store, 5, ["2026-11-26T17:00:00+08:00", "2026-11-24T10:00:00Z", "2026-11-20T10:00:00Z", "2020-01-01T00:00:00Z", null])
      expect((await store.articles({ window: "24h", now: NOW })).total).toBe(1)
      expect((await store.articles({ window: "72h", now: NOW })).total).toBe(2)
      expect((await store.articles({ window: "7d", now: NOW })).total).toBe(3)
      expect((await store.articles({ window: "history", now: NOW })).total).toBe(1)
      expect((await store.articles({ window: "unknown", now: NOW })).total).toBe(1)
      expect((await store.articles({ relevance: "relevant", now: NOW })).total).toBe(5)
      const latest = (await store.articles({ window: "24h", now: NOW })).items[0]
      expect((await store.articles({ ids: [latest.id] })).total).toBe(1)
      expect((await store.articles({ ids: [] })).total).toBe(0)
    } finally {
      await store.close()
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("portal-filter-test-")) throw new Error("Unexpected test path")
      await rm(directory, { recursive: true, force: true })
    }
  })
})

