# AI 筛选、归纳、评优：运行说明

程序已接入，实际 AI 分析尚待模型配置。当前没有配置服务商、模型或密钥，因此不会发起模型请求，也没有生成真实的 AI 精选。现已增加知潮阅读界面、人工推荐和本机管理；本站保留 NewsNow 科技热榜卡片。整站用法见 PROJECT_GUIDE.md。

项目：`.`。

## 现在可以做什么

一轮完整处理：

```powershell
& '.\run.ps1'
```

流程为：采集 → 入库 → 清洗、分类、关联 → 编辑候选筛选 → 可选 AI 分析 → 程序评分 → 简报入库。没有模型时，前面的采集和整理照常完成，编辑状态为 `not_configured`，待分析条数会保存。任务成功退出不代表已经生成 AI 结果。

只运行编辑步骤：

```powershell
& '.\editorialize.ps1'
```

如果显示 `processing_required`，先运行同目录的 `process.ps1`；源内容或分类变化后，旧快照会被拒绝，避免把过期分析导入新数据。

`run.ps1 -Watch` 会按现有配置持续运行；需要窗口保持打开，Ctrl+C 停止。本次未安装计划任务或后台常驻服务，也没有设定每天某个时刻自动发布日报。

## 评分和时效

模型给出相关性、证据、影响、新颖度的 0–5 分及带引文的理由；程序计算时效、总分、门槛和栏目，不直接相信模型返回的总分。

| 维度 | 权重 |
| --- | ---: |
| 计算机科技相关性 | 25 |
| 时效 | 30 |
| 证据 | 20 |
| 影响 | 15 |
| 新颖度 | 10 |

- 时效分：24小时内5分，24–72小时4分，72小时–7天2分，超过7天0分。边界按文章原始时间计算。
- 总分80及以上可进精选，65及以上可进近期；还必须通过相关性、来源、日期、内容和核查状态门槛。分数高也不能绕过这些门槛。
- 通常只分析72小时内、有至少120字符正文或来源摘要、已知发布时间的候选。标题不能代替正文证据。教程、知识等普通背景材料不会因重新采集而进入近期新闻。
- 3–7天的重大持续事件可由本地人工标记进入跟踪候选；必须保存理由和核验说明，仍显示原日期，不把它混作刚发布的新闻。跟踪最多3条。
- 只有明确日期和原文引文支持的实质更新，才允许更新有效日期；保留原发布时间。网页修改时间和采集时间不作为新事件日期。
- 使用重复组中较早的原始日期，避免同一旧闻被新转载“刷新”。未知日期、明显未来日期、冲突或未核实内容进入待确认/不入选。
- 仅有来源摘要、全为官方来源或厂商主张时，证据分最高3；其他情况最高4。模型检查不等于独立事实核验。

## AI 输出检查

每条分析保存事实、变化、意义、评分理由、原文链接和短引文。推论单独标记，不能冒充事实。

程序检查引用是否确实出现在保存的正文中，检查数值、常见单位和显式事件日期；随后单独调用同一个已配置模型检查所有主张与引文的一致性。检查不通过，不发布该批新简报。两次调用不代表两个独立信息来源，也不能保证原始新闻真实。重大数学证明等主张仍需人工核验。

## 以后配置模型

现在无需操作。获得模型服务后，在本机当前 PowerShell 会话设置：

```powershell
$env:AI_MODEL = '服务商/模型名'
$env:AI_API_BASE = '服务商要求的接口地址'
$env:EDITORIAL_AI_ENABLED = '1'
$secret = Read-Host 'API key（仅在本机输入）' -AsSecureString
$env:AI_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
Remove-Variable secret
& '.\editorialize.ps1'
```

模型标识沿用 TrendRadar 的 LiteLLM 接口；上面的中文占位符必须换成实际服务信息。部分服务使用默认地址，可不设置 `AI_API_BASE`。本次没有选定或验证具体服务商，后续接入时应先做小批量真实验证。不要把密钥发到聊天、写入源码或提交到 Git。

启用需要同时具备密钥、模型名，以及 `EDITORIAL_AI_ENABLED=1` 或配置文件中的 `ai.enabled=true`。默认 `config\editorial.json` 的 `enabled` 为 false。环境变量仅作用于当前会话；本次没有持久保存凭据。

当前限额：每轮最多新增分析2条，最多4次应用层模型调用，每次最多输出1800 tokens，超时30秒，关闭客户端自动重试和备用模型。每条材料单篇截取最多5000字符、合计最多6000字符；每轮请求估算上限64000，按 UTF-8 字节加输出预留保守估算。这不是服务商真实 token 用量，也不是费用上限，实际计费尚未验证。

达到预算时保留待分析队列，并明确标记部分覆盖。分析缓存按原文输入、模型、接口指纹、程序和提示词版本区分；相同有效输入可复用，避免重复调用。失败时记录去敏错误代码，不输出包含凭据的服务端错误原文。

清除当前会话密钥并停用：

```powershell
Remove-Item Env:AI_API_KEY -ErrorAction SilentlyContinue
$env:EDITORIAL_AI_ENABLED = '0'
```

## 查看接口

```powershell
& '.\start-web.ps1'
```

仅监听本机 `http://127.0.0.1:4320`：

| 路径 | 内容 |
| --- | --- |
| `/api/content/editorial/status` | 最近编辑状态、覆盖范围、调用次数、错误 |
| `/api/content/digests/latest` | 最新简报；无发布时明确返回空列表 |
| `/api/content/digests?limit=20&offset=0` | 简报历史分页 |
| `/api/content/digests/{id}` | 某一期归档，保留当时内容和发布时间 |
| `/api/content/status` | 全流程状态，包含编辑状态 |

接口只读，不提供匿名发布、人工修改或草稿接口。草稿在本地 `data\editorial\draft.json`，不应放进网站静态目录。

缺模型、模型失败、输出不合格或处理快照过期，都不覆盖上一期简报。相同简报不会因重复运行刷新发布时间。最新接口会隐藏已过期或原文变化的项目；归档仍保留历史内容，因此历史记录不代表现在仍属近期。

## 本地人工跟踪与撤销

先运行一次 `editorialize.ps1`，在 `data\editorial\input.json` 查找实际 `units[].id`。以下仅为结构示例，不能直接用于真实文章：

```json
{
  "unit_id": "article:替换为实际ID",
  "reason": "说明为什么属于重大持续事件",
  "major_ongoing": true,
  "verification_note": "说明已查到的证据和仍未确认的部分",
  "verified_update": null,
  "include_updated_resource": false
}
```

把填写好的 JSON 保存到 D 盘文件，再在 PowerShell 中运行：

```powershell
. '.\scripts\env.ps1'
Push-Location '.\web'
try {
    corepack pnpm exec tsx scripts/editorial-content.ts curate 'D:\替换为人工标记文件.json'
} finally { Pop-Location }
```

撤销使用同一命令环境下的 `clear-curation '实际unit_id' '撤销原因'`。人工操作保存审计记录。若要声明实质更新，`verified_update` 必须填写 `{ "date": "YYYY-MM-DD", "citation": { "article_id": "实际文章ID", "quote": "含明确日期的原文短引文" } }`；教程更新还需 `include_updated_resource=true`，程序会验证引文。没有真实证据应保持 null。

本次未给生产库写入任何人工重大事件标记或模拟 AI 分析。

## 文件、复用与验证边界

- `collector\editorialize.py`：复用 TrendRadar `AIClient.chat`、`load_prompt_template`、`AIFilter._extract_json`；沿用现有原子写入和哈希工具。
- `web\server\utils\editorial-policy.ts`：与本项目要求有关的时效、证据和评分门槛。
- `web\server\database\editorial.ts`：沿用 NewsNow 的 db0/better-sqlite3 存储，新增分析缓存、运行记录、草稿、评估、简报和人工审计表。
- `config\editorial*.txt`、`config\editorial.json`：提示词和编辑策略。
- `data\editorial`、数据库、日志、源码及依赖都在 D 盘。未新增第三方依赖；原许可证和来源声明保留。

自动测试用临时库和模拟模型检查正常及失败路径；生产库只做了无模型运行。实际模型兼容性、摘要质量、真实费用和长期运行稳定性尚未验证。新的阅读界面和管理页已经接通；仍需获得模型后验证真实分析效果。
