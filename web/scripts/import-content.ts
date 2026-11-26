import { readFile, readdir, mkdir, rename, stat, writeFile } from "node:fs/promises"
import { resolve, join, basename } from "node:path"
import process from "node:process"
import { ContentStore } from "../server/database/content"

const root = resolve(process.env.CONTENT_DATA_DIR || "../data")
const singleFile = process.argv.indexOf("--file")
const outbox = join(root, "outbox")
await mkdir(outbox, { recursive: true })
await mkdir(join(root, "imported"), { recursive: true })
await mkdir(join(root, "rejected"), { recursive: true })
const files = singleFile >= 0 ? [resolve(process.argv[singleFile + 1])] : (await readdir(outbox)).filter(x => x.endsWith(".json")).sort().map(x => join(outbox, x))
const store = await new ContentStore(process.env.CONTENT_DB_PATH || join(root, "content.sqlite3")).init()
const results = []
try {
  for (const path of files) {
    try {
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("Batch file too large")
      const result = await store.importBatch(JSON.parse(await readFile(path, "utf-8")))
      results.push({ file: basename(path), ...result })
      if (singleFile < 0) await rename(path, join(root, "imported", basename(path)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ file: basename(path), error: message })
      process.exitCode = 1
      // Only malformed data is quarantined. Transient I/O/SQLite errors remain pending for retry.
      if (singleFile < 0 && (error instanceof SyntaxError || /Invalid |Unsupported |Missing |Unknown |Duplicate |Unsafe |mismatch|Batch ID|Batch too|Expected |cannot mark|does not match|batch file too/i.test(message))) {
        const target = join(root, "rejected", basename(path))
        await rename(path, target)
        await writeFile(`${target}.error.txt`, message, "utf-8")
      }
    }
  }
  console.log(JSON.stringify({ results, database: await store.status() }, null, 2))
} finally {
  await store.close()
}
