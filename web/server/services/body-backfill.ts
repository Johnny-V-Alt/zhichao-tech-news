// Read-only projection of the Python/Huey worker's atomic public status files.
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"

type Row = Record<string, any>
async function json(path: string, fallback: Row | null) {
  try { return JSON.parse(await readFile(path, "utf-8")) as Row }
  catch { return fallback }
}
export async function bodyBackfillStatus(id?: string, root = process.env.PORTAL_APP_ROOT || resolve(".."), data = process.env.CONTENT_DATA_DIR || join(root, "data")) {
  if (id && !/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid article id")
  const policy = await json(join(root, "config", "body-backfill.json"), { enabled: false })
  const status = await json(join(data, "body-backfill", id ? `articles/${id}.json` : "status.json"), null)
  if (policy?.enabled === false) return { ...status, enabled: false, state: "disabled" }
  return status || (id ? { state: "pending", attempts: 0, enabled: true } : { enabled: true, counts: {}, queued: 0, scheduled: 0, updated_at: null })
}
