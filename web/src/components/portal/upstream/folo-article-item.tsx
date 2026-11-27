// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from RSSNext/Folo ArticleItemStateLess, commit
// 292d15d94f9e7680899e1e2567c1c0d48a423f48. Original file and license:
// vendor/frontend/folo/. Changes: accessible link wrapper, local source/time
// props and CSS in place of Folo stores, Tailwind theme and media proxy.
import type { ReactNode } from "react"

export function ArticleItemStateLess({ entry, feed, href, selected }: {
  entry: { title: string, description?: string, publishedAt: ReactNode },
  feed: { title: string, icon: ReactNode }, href: string, selected?: boolean,
}) {
  return <a className={`folo-article-item ${selected ? "selected" : ""}`} href={href} aria-current={selected ? "page" : undefined}>
    <span className="folo-feed-icon">{feed.icon}</span>
    <div className="folo-item-content">
      <div className="folo-item-meta"><span>{feed.title}</span><span>·</span><span>{entry.publishedAt}</span></div>
      <div className="folo-item-title">{entry.title}</div>
      {entry.description && <div className="folo-item-description">{entry.description}</div>}
    </div>
  </a>
}
