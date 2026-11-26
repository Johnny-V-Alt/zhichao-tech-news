import { useQuery } from "@tanstack/react-query"
export type Row = Record<string, any>
export const topics: Record<string, string> = { ai: "人工智能", hardware: "芯片与硬件", systems: "操作系统", software: "软件与开源", networks: "网络与云", databases: "数据库", security: "网络安全", research: "前沿研究", ai_science: "AI 与科学", industry: "科技产业" }
export const types: Record<string, string> = { news: "新闻", tutorial: "教程", knowledge: "知识", tool: "工具", review: "测评", unknown: "待分类" }
export const windows: Record<string, string> = { "24h": "24 小时", "72h": "近 72 小时", "7d": "近 7 天", history: "历史资讯", unknown: "日期待确认", all: "全部时间" }
export const states: Record<string, string> = { not_configured: "等待模型配置", disabled: "AI 分析已停用", processing_required: "等待重新整理", completed: "分析完成", budget_limited: "本轮额度已用完", failed: "任务失败", partial_error: "部分分析失败", never_run: "尚未运行", queued: "排队中", running: "运行中", succeeded: "已完成", interrupted: "已中断" }
export async function request<T = Row>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, credentials: "same-origin" })
  let data: any
  try { data = await response.json() } catch { throw new Error("暂时无法读取数据，请稍后重试") }
  if (!response.ok) throw new Error(data.message || data.statusMessage || `请求失败（${response.status}）`)
  return data
}
export function useData<T = Row>(path: string, enabled = true, poll = false) {
  return useQuery<T, Error>({ queryKey: ["portal", path], queryFn: ({ signal }) => request<T>(path, { signal }), enabled, staleTime: 20000, retry: 1, refetchInterval: poll ? 15000 : false })
}
export function date(value: string | null | undefined, precision?: string): string {
  if (!value) return "日期待确认"
  if (precision === "date" || value.length === 10) return `${value.slice(0, 10)}（日期精度）`
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return "日期待确认"
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed)
}
export function age(value?: string | null, precision?: string) {
  if (!value) return "日期待确认"
  if (precision === "date") return value.slice(0, 10)
  const hours = (Date.now() - Date.parse(value)) / 3600000
  if (!Number.isFinite(hours)) return "日期待确认"
  if (hours < -5 / 60) return "日期异常"
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))} 分钟前`
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  if (hours < 168) return `${Math.floor(hours / 24)} 天前`
  return value.slice(0, 10)
}
export function external(value: unknown) { try { const url = new URL(String(value)); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined } catch { return undefined } }
export function filtered(params: URLSearchParams, changes: Record<string, string>) {
  const query = new URLSearchParams(params)
  for (const [key, value] of Object.entries(changes)) { if (value) query.set(key, value); else query.delete(key) }
  if (!("page" in changes)) query.delete("page")
  return `/?${query.toString()}`
}
