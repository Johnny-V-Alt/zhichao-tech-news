// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from dailydotdev/apps Card.tsx and ArticleGrid.tsx, commit
// 776829c1840da97e431d2aa64615adb9445126c1. Original source and license:
// vendor/frontend/daily-dev/. Changes: use clsx, local semantic CSS and props;
// remove GraphQL, telemetry, ads and account-specific services.
import type { HTMLAttributes, ReactNode } from "react"
import { clsx } from "clsx"

type TitleProps = HTMLAttributes<HTMLHeadingElement> & {
  lineClamp?: 2 | 3 | 4
  children: ReactNode
}

export function CardTitle({ className, lineClamp = 3, children, ...rest }: TitleProps) {
  return <h3 {...rest} className={clsx("daily-title", `daily-clamp-${lineClamp}`, className)}>{children}</h3>
}

export function CardTextContainer({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={clsx("daily-text-container", className)} />
}

export function CardSpace() { return <div className="daily-space" /> }

// Keep the original stretched-link approach. Buttons and tag links remain
// independent targets; the article itself does not impersonate a button.
export function CardLink({ href, title }: { href: string, title: string }) {
  return <a href={href} className="daily-link" aria-label={`阅读：${title}`} />
}

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <article {...props} className={clsx("daily-card", className)} />
}

export function ArticleGrid({ href, title, header, tags, summary, cover, metadata, actions }: {
  href: string, title: string, header: ReactNode, tags: ReactNode,
  summary?: ReactNode, cover?: ReactNode, metadata: ReactNode, actions: ReactNode,
}) {
  return <Card>
    <CardLink href={href} title={title} />
    <CardTextContainer>
      {header}
      <CardTitle>{title}</CardTitle>
      {summary}
      <CardSpace />
      {tags}
      {metadata}
    </CardTextContainer>
    {cover}
    <div className="daily-card-actions">{actions}</div>
  </Card>
}
