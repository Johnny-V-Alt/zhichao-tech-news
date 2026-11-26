import { contentTypes, topicIds } from "../../../../shared/processing"
import { getContentStore } from "../../../database/content"

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const integer = (key: string, fallback: number, max: number) => {
    if (query[key] === undefined) return fallback
    const value = Number(query[key])
    if (!Number.isInteger(value) || value < (key === "limit" ? 1 : 0) || value > max)
      throw createError({ statusCode: 400, message: `Invalid ${key}` })
    return value
  }
  const text = (key: string) => {
    if (query[key] === undefined) return undefined
    if (typeof query[key] !== "string" || query[key].length > 200)
      throw createError({ statusCode: 400, message: `Invalid ${key}` })
    return query[key]
  }
  const type = text("type"), topic = text("topic"), review = text("review")
  if (type && !contentTypes.includes(type as typeof contentTypes[number])) throw createError({statusCode:400,message:"Invalid content type"})
  if (topic && !topicIds.includes(topic as typeof topicIds[number])) throw createError({statusCode:400,message:"Invalid topic"})
  if (review !== undefined && !["true","false"].includes(review)) throw createError({statusCode:400,message:"Invalid review filter"})
  const relevance = text("relevance")
  if (relevance && !["all", "relevant", "uncertain", "out_of_scope"].includes(relevance)) throw createError({statusCode:400,message:"Invalid relevance"})
  const window = text("window")
  if (window && !["all", "24h", "72h", "7d", "history", "unknown"].includes(window)) throw createError({statusCode:400,message:"Invalid time window"})
  let ids: string[] | undefined
  if (query.ids !== undefined) {
    if (typeof query.ids !== "string" || query.ids.length > 6500 || !query.ids.split(",").every(id => /^[a-f0-9]{64}$/.test(id))) throw createError({statusCode:400,message:"Invalid article IDs"})
    ids = [...new Set(query.ids.split(","))]
    if (ids.length > 100) throw createError({statusCode:400,message:"Too many article IDs"})
  }
  return (await getContentStore()).articles({window,ids,relevance,contentType:type,topic,review:review===undefined?undefined:review==="true", source: text("source"), kind: text("kind"), q: text("q"), limit: integer("limit", 30, 100), offset: integer("offset", 0, 1000000) })
})
