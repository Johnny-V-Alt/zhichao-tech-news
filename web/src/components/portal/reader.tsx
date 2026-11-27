import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react"
import { ArticleItemStateLess } from "./upstream/folo-article-item"
import { age, date, useData, type Row } from "./data"

export function sourceName(a: Row): string {
  return a.source_names || a.sources?.map((s: Row) => s.name).join(" · ") || "来源待确认"
}

export function Reader({ article, id, children, actions }: { article: Row, id: string, children: ReactNode, actions: ReactNode }) {
  const latest = useData("/api/content/articles?window=all&relevance=relevant&limit=40")
  const [search, setSearch] = useState(""), [listOpen, setListOpen] = useState(false)
  const [fontSize, setFontSize] = useState(17)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows: Row[] = latest.data?.items || []
  const queue = rows.some(a => a.id === id) ? rows : [article, ...rows]
  const visible = queue.filter(a => `${a.title} ${sourceName(a)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const position = queue.findIndex(a => a.id === id)
  useEffect(() => { setListOpen(false); scrollRef.current?.scrollTo({ top: 0 }) }, [id])
  return <div className={`reader-workspace ${listOpen ? "list-open" : ""}`}>
    <aside className="reader-queue" aria-label="阅读队列">
      <div className="queue-header"><div><span className="eyebrow">YOUR READING DESK</span><h2>阅读队列</h2></div><button className="queue-close" onClick={() => setListOpen(false)} aria-label="关闭阅读队列">×</button></div>
      <p className="queue-description">最近收录的科技资讯，按原始发布时间排序</p>
      <input className="queue-search" aria-label="筛选阅读队列" placeholder="在队列中查找…" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="queue-count">{search ? `${visible.length} 篇匹配` : `最近 ${rows.length} 篇${rows.some(a => a.id === id) ? "" : " + 当前文章"}`}</div>
      <div className="queue-items">
        {latest.isPending && <p className="queue-message" role="status">正在载入队列…</p>}
        {latest.isError && <button className="queue-message" onClick={() => latest.refetch()}>队列暂时无法载入，点击重试</button>}
        {!visible.length && <p className="queue-message">没有匹配的资讯</p>}
        {visible.map(a => <ArticleItemStateLess key={a.id} href={`/articles/${a.id}`} selected={a.id === id} feed={{ title: sourceName(a), icon: sourceName(a).slice(0, 1) }} entry={{ title: a.title, description: a.source_excerpt, publishedAt: age(a.published_at, a.publication_precision) }} />)}
      </div>
      <a className="queue-home" href="/">← 返回资讯首页</a>
    </aside>
    {listOpen && <button className="reader-queue-backdrop" onClick={() => setListOpen(false)} aria-label="关闭队列遮罩" />}
    <section className="reader-pane" aria-label="文章阅读区">
      <div className="reader-toolbar">
        <button className="reader-list-toggle" onClick={() => setListOpen(!listOpen)} aria-expanded={listOpen}>☷ 阅读队列</button>
        <a href="/" className="reader-back">← 发现</a>
        <span className="reader-source">{sourceName(article)}</span>
        <div className="reader-toolbar-actions">
          <button className="reader-font" disabled={fontSize === 15} onClick={() => setFontSize(size => Math.max(15, size - 1))} aria-label="缩小正文字号">A−</button>
          <button className="reader-font" disabled={fontSize === 21} onClick={() => setFontSize(size => Math.min(21, size + 1))} aria-label="放大正文字号">A＋</button>
          {actions}
        </div>
      </div>
      <div className="reader-scroll" ref={scrollRef} style={{ "--reader-font-size": `${fontSize}px` } as CSSProperties}>
        <div className="reader-document" key={id}>{children}<div className="reader-end"><span>阅读至此</span><p>原始发布时间：{date(article.published_at, article.publication_precision)}</p></div>
          <nav className="reader-next" aria-label="切换文章">{position > 0 ? <a href={`/articles/${queue[position - 1].id}`}>← 上一篇</a> : <span />}{position < queue.length - 1 ? <a href={`/articles/${queue[position + 1].id}`}>下一篇 →</a> : <span />}</nav>
        </div>
      </div>
    </section>
  </div>
}
