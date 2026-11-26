import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import process from "node:process"
import { ContentStore } from "../server/database/content"

const directory = join(resolve(process.env.CONTENT_DATA_DIR || "../data"), "editorial")
await mkdir(join(directory, "runs"), { recursive: true })
const store = await new ContentStore().init()
const [command = "status", argument, reason] = process.argv.slice(2)
try {
  if (command === "export") {
    const snapshot = await store.editorial.snapshot()
    await writeFile(join(directory, "input.json.partial"), JSON.stringify(snapshot), "utf-8")
    await rename(join(directory, "input.json.partial"), join(directory, "input.json"))
    console.log(JSON.stringify({ snapshot_id: snapshot.snapshot_id, units: snapshot.units.length, candidates: snapshot.units.filter(u => u.preflight?.candidate).length, processing_ready: snapshot.processing_ready }))
  } else if (command === "import") {
    const result = JSON.parse(await readFile(argument || join(directory, "output.json"), "utf-8"))
    const stored = await store.editorial.apply(result)
    const archive = join(directory, "runs", `${result.run_id}.json`)
    try { await access(archive) } catch { await writeFile(archive, JSON.stringify(result), "utf-8") }
    await writeFile(join(directory, "draft.json"), JSON.stringify(await store.editorial.draft(), null, 2), "utf-8")
    console.log(JSON.stringify({ ...stored, status: await store.editorial.status() }, null, 2))
  } else if (command === "curate") {
    if (!argument) throw new Error("Pass a curation JSON file")
    console.log(JSON.stringify(await store.editorial.curate(JSON.parse(await readFile(argument, "utf-8")))))
  } else if (command === "clear-curation") {
    if (!argument || !reason) throw new Error("Pass unit ID and removal reason")
    console.log(JSON.stringify(await store.editorial.clearCuration(argument, reason)))
  } else if (command === "draft") console.log(JSON.stringify(await store.editorial.draft(), null, 2))
  else if (command === "status") console.log(JSON.stringify(await store.editorial.status(), null, 2))
  else throw new Error("Unknown editorial command")
} finally { await store.close() }
