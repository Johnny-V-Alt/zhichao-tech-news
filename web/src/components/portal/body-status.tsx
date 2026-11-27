import { date, type Row } from "./data"

const labels: Record<string, string> = {
  pending: "等待安排正文补抓", queued: "正文补抓已排队", running: "正在提取正文",
  retrying: "抓取失败，已安排重试", awaiting_import: "正文已提取，等待入库",
  complete: "正文已补齐", blocked: "来源访问受限或地址待确认",
  failed: "正文补抓未完成", disabled: "此来源未启用正文补抓",
}
export function BodyStatus({ article }: { article: Row }) {
  const status = article.body_backfill || {}
  if (article.content_status === "full_text") return null
  const state = status.state || "pending"
  return <div className={`body-fetch-status ${["failed", "blocked"].includes(state) ? "attention" : ""}`} role="status">
    <span className="body-fetch-dot" /><div><strong>{labels[state] || "正文状态待更新"}</strong>
      <p>{article.content_text ? "当前先展示来源提供的摘要，补抓成功后自动显示正文。" : "当前只保存了标题和原始链接，尚无可展示的正文。"}</p>
      {status.attempts > 0 && <small>已尝试 {status.attempts} 次{status.last_attempt_at && ` · 最近尝试 ${date(status.last_attempt_at)}`}</small>}
      {status.next_retry_at && <small>预计重试：{date(status.next_retry_at)}</small>}
      {status.error && <details><summary>查看原因</summary><p>{status.error}</p></details>}
      {["failed", "blocked"].includes(state) && <p>可先通过上方“原文”访问来源；管理员可在运行管理中重试失败正文。</p>}
    </div>
  </div>
}
