export default defineEventHandler(() => { throw createError({statusCode:404,message:"Content endpoint not found"}) })
