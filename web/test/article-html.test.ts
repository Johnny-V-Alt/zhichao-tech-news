import { describe, expect, it } from "vitest"
import { JSDOM } from "jsdom"
import createDOMPurify from "dompurify"
import { articleLink, sanitizeArticleHTML } from "../shared/article-html"

describe("DOMPurify article reader integration", () => {
  const window = new JSDOM("").window
  const purifier = createDOMPurify(window)
  const image = "/api/content/images/" + "a".repeat(64)
  it("retains structural typography and cached image order", () => {
    const html = sanitizeArticleHTML(`<h2>Heading</h2><p>Before <strong>image</strong></p><img src="${image}" alt="Photo"><p>After</p><ul><li>Item</li></ul><pre><code>const x = 1</code></pre><table><tr><td>Cell</td></tr></table>`, "https://example.com/story", purifier)
    const document = new JSDOM(html).window.document
    expect([...document.body.children].map(x => x.tagName)).toEqual(["H2", "P", "IMG", "P", "UL", "PRE", "TABLE"])
    expect(document.querySelector("img")!.getAttribute("src")).toBe(image)
    expect(document.querySelector("img")!.getAttribute("loading")).toBe("lazy")
  })
  it("removes executable content, external image requests, clobbering attributes and source styles", () => {
    const html = sanitizeArticleHTML(`<script>alert(1)</script><img src="${image}" onerror="alert(1)"><img src="https://tracker.example/pixel"><svg onload="alert(1)"></svg><iframe srcdoc="<script>alert(1)</script>"></iframe><a href="javascript:alert(1)" id="location" style="position:fixed">bad</a><p onclick="alert(1)">Good</p>`, "https://example.com/story", purifier)
    const document = new JSDOM(html).window.document
    expect(document.querySelectorAll("img")).toHaveLength(1)
    expect(document.querySelector("script,svg,iframe,[onerror],[onclick],[style],[id]")).toBeNull()
    expect(document.querySelector("a")!.hasAttribute("href")).toBe(false)
    expect(html).toContain("Good")
  })
  it("normalizes relative links and rejects local and credential-bearing targets", () => {
    const html = sanitizeArticleHTML('<a href="../docs">Docs</a><a href="https://user:pass@example.com">Private</a><a href="http://127.0.0.1">Local</a>', "https://example.com/news/story", purifier)
    const links = new JSDOM(html).window.document.querySelectorAll("a")
    expect(links[0].getAttribute("href")).toBe("https://example.com/docs")
    expect(links[1].hasAttribute("href")).toBe(false)
    expect(links[2].hasAttribute("href")).toBe(false)
    expect(articleLink("data:text/html,bad", "https://example.com")).toBeNull()
  })
})
