import { getCookie, setCookie, deleteCookie, getRequestURL, getHeader, readBody, createError, getRequestIP } from "h3"
import { getOperations, equalKeys, signSession, verifySession } from "../../services/operations"
import { getContentStore } from "../../database/content"

const attempts = new Map<string, { count: number, until: number }>()
export default defineEventHandler(async (event) => {
  const url = getRequestURL(event), method = event.method, path = url.pathname.replace(/^\/api\/admin\//, "")
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw createError({ statusCode: 403, message: "管理仅限本机" })
  if (method !== "GET" && (getHeader(event, "origin") !== url.origin || getHeader(event, "x-tech-action") !== "1")) throw createError({ statusCode: 403, message: "管理操作需要同源请求" })
  const ops = getOperations(), key = await ops.key(), authenticated = verifySession(getCookie(event, "tech_admin"), key)
  if (path === "session") {
    if (method === "GET") return { authenticated }
    if (method === "DELETE") { deleteCookie(event, "tech_admin", { path: "/api/admin", sameSite: "strict" }); return { authenticated: false } }
    if (method !== "POST") throw createError({ statusCode: 405 })
    const address = getRequestIP(event) || "local", previous = attempts.get(address)
    if (previous && previous.until > Date.now() && previous.count >= 5) throw createError({ statusCode: 429, message: "尝试过多，请15分钟后重试" })
    const body = await readBody(event)
    if (typeof body?.key !== "string" || body.key.length > 200 || !equalKeys(body.key.trim(), key)) {
      const entry = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 15 * 60000 }
      entry.count++; attempts.set(address, entry); throw createError({ statusCode: 401, message: "管理码不正确" })
    }
    attempts.delete(address)
    setCookie(event, "tech_admin", signSession(key), { httpOnly: true, sameSite: "strict", path: "/api/admin", maxAge: 8 * 3600, secure: url.protocol === "https:" })
    return { authenticated: true }
  }
  if (!authenticated) throw createError({ statusCode: 401, message: "请先使用本机管理码登录" })
  if (path === "state" && method === "GET") return ops.adminState()
  if (path === "log" && method === "GET") {
    const id = url.searchParams.get("id") || ""
    if (!/^[a-f0-9]{24}$/.test(id)) throw createError({statusCode:400,message:"Invalid job ID"})
    return ops.jobLog(id)
  }
  if (path !== "action" || method !== "POST") throw createError({ statusCode: 404 })
  const body = await readBody(event)
  if (!body || typeof body.action !== "string" || JSON.stringify(body).length > 100000) throw createError({ statusCode: 400, message: "管理请求无效" })
  return ops.serial(async () => {
    try {
      const store = await getContentStore()
      switch (body.action) {
        case "sources": return await ops.changeSources(body.value)
        case "settings": return await ops.changeSettings(body.value)
        case "job": return await ops.startJob(body.kind)
        case "label": { const result = await store.processing.override({ ...body.value, kind: "label" }); await ops.audit("label", { ...body.value, ...result }); return result }
        case "relation": { const result = await store.processing.override({ ...body.value, kind: "relation" }); await ops.audit("relation", { ...body.value, ...result }); return result }
        case "clear_override": { const result = await store.processing.clearOverride(body.key, body.reason); await ops.audit("clear_override", { key: body.key, reason: body.reason }); return result }
        case "curate": return await store.editorial.curate(body.value)
        case "clear_curation": return await store.editorial.clearCuration(body.unit_id, body.reason)
        case "pick": return await ops.pick(body.value)
        case "unpick": return await ops.unpick(body.article_id, body.reason)
        default: throw new Error("未知管理操作")
      }
    } catch (error: any) { throw createError({ statusCode: 400, message: String(error.message).slice(0, 500) }) }
  })
})
