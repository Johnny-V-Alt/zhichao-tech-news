// Cached raster assets only. This endpoint never downloads a supplied URL.
import { readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import process from "node:process"

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id") || ""
  if (!/^[a-f0-9]{64}$/.test(id)) throw createError({ statusCode: 400, message: "Invalid image id" })
  const directory = join(process.env.CONTENT_DATA_DIR || resolve("..", "data"), "article-images")
  try {
    const meta = JSON.parse(await readFile(join(directory, `${id}.json`), "utf-8"))
    if (!["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(meta.type)) throw new Error("Invalid image type")
    const data = await readFile(join(directory, `${id}.bin`))
    if (data.length > 4_000_000 || data.length !== meta.bytes) throw new Error("Invalid image size")
    setHeader(event, "Content-Type", meta.type)
    setHeader(event, "X-Content-Type-Options", "nosniff")
    setHeader(event, "Cache-Control", "public, max-age=31536000, immutable")
    return data
  } catch { throw createError({ statusCode: 404, message: "Article image unavailable" }) }
})
