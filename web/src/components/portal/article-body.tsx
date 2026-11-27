import { useMemo, useState, type SyntheticEvent } from "react"
import { localArticleImage, sanitizeArticleHTML } from "../../../shared/article-html"
import type { Row } from "./data"
import "github-markdown-css/github-markdown-light.css"
import "./article-body.css"

function imageError(event: SyntheticEvent) {
  const image = event.target
  if (!(image instanceof HTMLImageElement) || image.dataset.failed) return
  image.dataset.failed = "true"; image.hidden = true; image.style.display = "none"
  const note = document.createElement("span")
  note.className = "article-image-placeholder"; note.textContent = "配图暂时无法加载，可通过原文查看。"
  image.after(note)
}
export function ArticleCover({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  if (failed || !localArticleImage(url)) return null
  return <div className="article-card-cover"><img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /></div>
}
export function ArticleBody({ article }: { article: Row }) {
  const markup = useMemo(() => article.content_html && typeof window !== "undefined" ? sanitizeArticleHTML(article.content_html, article.canonical_url) : "", [article.content_html, article.canonical_url])
  const [expanded, setExpanded] = useState(false)
  if (markup) return <div className="markdown-body article-rich-body" onErrorCapture={imageError} dangerouslySetInnerHTML={{ __html: markup }} />
  const text: string = article.content_text || ""
  return <><div className="markdown-body article-rich-body article-plain-body">{(expanded ? text : text.slice(0, 12000)).split(/\n+/).filter(Boolean).map((p, i) => <p key={i}>{p}</p>)}</div>{text.length > 12000 && <button className="button" onClick={() => setExpanded(!expanded)}>{expanded ? "收起正文" : "展开剩余正文"}</button>}</>
}
