import process from "node:process"
import type { VitePWAOptions } from "vite-plugin-pwa"
import { VitePWA } from "vite-plugin-pwa"

const pwaOption: Partial<VitePWAOptions> = {
  registerType: "prompt",
  includeAssets: ["icon.svg", "apple-touch-icon.png"],
  filename: "swx.js",
  manifest: {
    name: "知潮 · 科技资讯",
    short_name: "知潮 · 科技资讯",
    description: "聚合计算机领域的资讯，带着来源读科技",
    theme_color: "#087f80",
    icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  },
  workbox: {
    navigateFallbackDenylist: [/^\/api/],
    // sw.js 是旧版本的自销毁 SW，必须始终从网络获取，不能被预缓存
    globIgnores: ["**/sw.js"],
  },
  devOptions: {
    enabled: process.env.SW_DEV === "true",
    type: "module",
    navigateFallback: "index.html",
  },
}

export default function pwa() {
  return VitePWA(pwaOption)
}
