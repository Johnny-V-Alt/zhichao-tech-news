import { getContentStore } from "../../../database/content"

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id") || ""
  if (!/^[a-f0-9]{64}$/.test(id)) throw createError({ statusCode: 400, message: "Invalid article id" })
  const article = await (await getContentStore()).article(id)
  if (!article) throw createError({ statusCode: 404, message: "Article not found" })
  return article
})
