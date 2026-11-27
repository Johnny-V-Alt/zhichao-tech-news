// DOMPurify performs HTML sanitization. Local rules only constrain the reader's
// tags/URLs; no publisher styles, scripts, embeds or remote image requests.
import DOMPurify from "dompurify"
import type { DOMPurify as Purifier } from "dompurify"

export const localArticleImage = (value: unknown): value is string => typeof value === "string" && /^\/api\/content\/images\/[a-f0-9]{64}$/.test(value)
export function articleLink(value: string, base: string): string | null {
  try {
    const url = new URL(value, base)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes(".") || /^\d+(?:\.\d+){3}$/.test(url.hostname) || /(^|\.)(localhost|local|internal)$/.test(url.hostname)) return null
    return url.href
  } catch { return null }
}
export function sanitizeArticleHTML(value: string, base: string, purifier: Purifier = DOMPurify): string {
  const options = {
    ALLOWED_TAGS: ["p", "br", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "a", "img", "figure", "figcaption", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "hr", "span", "div", "sup", "sub", "dl", "dt", "dd"],
    ALLOWED_ATTR: ["src", "href", "alt", "title", "colspan", "rowspan", "loading", "decoding"],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  }
  const fragment = purifier.sanitize(value, { ...options, RETURN_DOM_FRAGMENT: true })
  for (const image of fragment.querySelectorAll("img")) {
    if (!localArticleImage(image.getAttribute("src"))) image.remove()
    else { image.setAttribute("loading", "lazy"); image.setAttribute("decoding", "async") }
  }
  for (const link of fragment.querySelectorAll("a")) {
    const raw = link.getAttribute("href") || ""
    const href = raw.trim() ? articleLink(raw, base) : null
    if (href) link.setAttribute("href", href)
    else link.removeAttribute("href")
  }
  const container = fragment.ownerDocument.createElement("div")
  container.append(fragment)
  // Final sanitization also covers the small, constrained URL normalization.
  return purifier.sanitize(container.innerHTML, options)
}
