import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"
import { ContentStore } from "../server/database/content"

const root = resolve(process.env.CONTENT_DATA_DIR || "../data")
const directory = join(root, "processing")
await mkdir(join(directory, "runs"), { recursive: true })
const store = await new ContentStore(process.env.CONTENT_DB_PATH || join(root, "content.sqlite3")).init()
const [command = "status", argument, reason] = process.argv.slice(2)
try {
  if (command === "export") {
    const snapshot = await store.processing.snapshot()
    const target = argument || join(directory, "input.json")
    await writeFile(`${target}.partial`, JSON.stringify(snapshot), "utf-8")
    await rename(`${target}.partial`, target)
    console.log(JSON.stringify({ snapshot_id: snapshot.snapshot_id, articles: snapshot.articles.length }))
  } else if (command === "import") {
    const result = JSON.parse(await readFile(argument || join(directory, "output.json"), "utf-8"))
    const imported = await store.processing.apply(result)
    const archive = join(directory, "runs", `${result.run_id}.json`)
    try { await access(archive) } catch { await writeFile(archive, JSON.stringify(result), "utf-8") }
    console.log(JSON.stringify({ ...imported, status: await store.processing.status() }, null, 2))
  } else if (command === "override") {
    if (!argument) throw new Error("Pass the override JSON file path")
    console.log(JSON.stringify(await store.processing.override(JSON.parse(await readFile(argument, "utf-8")))))
  } else if (command === "clear-override") {
    if (!argument || !reason) throw new Error("Pass override key and reason")
    console.log(JSON.stringify(await store.processing.clearOverride(argument, reason)))
  } else if (command === "status") {
    console.log(JSON.stringify(await store.processing.status(), null, 2))
  } else throw new Error("Unknown processing command")
} finally { await store.close() }
