import { getContentStore } from "../../../database/content"

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const limit = query.limit === undefined ? 30 : Number(query.limit)
  const offset = query.offset === undefined ? 0 : Number(query.offset)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000)
    throw createError({ statusCode: 400, message: "Invalid pagination" })
  return (await getContentStore()).processing.events(limit, offset)
})
