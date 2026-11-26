import { getContentStore } from "../../database/content"

export default defineEventHandler(async () => (await getContentStore()).status())
