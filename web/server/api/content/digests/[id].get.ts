import { getContentStore } from "../../../database/content"

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id") || ""
  if (!/^[a-f0-9]{64}$/.test(id)) throw createError({ statusCode: 400, message: "Invalid digest ID" })
  const result = await (await getContentStore()).editorial.publication(id)
  if (!result) throw createError({ statusCode: 404, message: "Digest not found" })
  return result
})
