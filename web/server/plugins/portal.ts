import { getOperations } from "../services/operations"
export default defineNitroPlugin((app) => {
  const operations = getOperations()
  operations.startScheduler()
  app.hooks.hook("close", () => operations.stopScheduler())
})
