import servePage from "../routes/[...path]"
export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  // Run before the template renderer's generic /** route on Windows.
  if (path.startsWith("/api/") || (path !== "/favicon.ico" && /\.[a-z0-9]{1,8}$/i.test(path))) return
  return servePage(event)
})
