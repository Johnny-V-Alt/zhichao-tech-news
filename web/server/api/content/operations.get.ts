import { getOperations } from "../../services/operations"
export default defineEventHandler(async () => getOperations().publicState())
