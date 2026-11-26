// The retained Vite/Nitro template renderer cannot serve deep links in this
// Node deployment. Serve the built SPA for reader routes; keep API/asset 404s.
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"

let html: Promise<string> | undefined
export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  if (path === "/favicon.ico") return sendRedirect(event, "/icon.svg", 302)
  if (path.startsWith("/api/") || /\.[a-z0-9]{1,8}$/i.test(path) || !["GET", "HEAD"].includes(event.method)) throw createError({statusCode:404,message:"Not found"})
  const known = /^\/(?:featured|events|digests|saved|sources|admin|hot)\/?$/.test(path) || /^\/(?:articles|events|digests)\/[a-f0-9]{64}\/?$/.test(path) || path.startsWith("/c/") || path === "/"
  if (!known) setResponseStatus(event, 404)
  setHeader(event, "Content-Type", "text/html; charset=utf-8")
  setHeader(event, "Cache-Control", "no-cache")
  html ??= readFile(resolve(process.env.NODE_ENV === "development" ? "index.html" : "dist/output/public/index.html"), "utf-8").catch(error => { html = undefined; throw error })
  return html
})
