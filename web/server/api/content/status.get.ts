import { bodyBackfillStatus } from "../../services/body-backfill"
import { getContentStore } from "../../database/content"

export default defineEventHandler(async () => ({ ...await (await getContentStore()).status(), body_backfill: await bodyBackfillStatus() }))
