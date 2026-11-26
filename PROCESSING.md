# 清洗、去重、分类与事件关联

本阶段在现有内容库后增加处理流程。保留所有原始文章、正文、来源和日期，仅写入独立的派生表。原版网页尚未增加分类页面；处理结果可从内容接口和本地记录查看。

## 已实现

1. 标题清洗：HTML 实体、可识别的标题标签、Unicode 与空白规范化；保留原始标题，保护 C++、C#、.NET、版本号和类型参数。
2. 正文指纹：单独保存正文指纹，与原来的文章记录指纹分开；保留代码大小写、缩进和操作符。相同摘要不被当成完整正文重复。
3. 重复与相似检测：继续使用已有链接去重；用 RapidFuzz 检测相似标题，以正文指纹、产品/版本/CVE和近期实体生成候选。
4. 文章分类：内容类型为新闻、教程、知识、工具、测评、待确认；技术领域可多选。类型与来源类别分开存储。每条保存方法、理由和原文依据。
5. 事件关联：区分相同内容、同一事件、后续进展、可能相关、已排除。版本、型号、CVE、价格或规格冲突、否认与传闻会阻止自动归组。
6. 防止链式误合并：A与B相同、B与C相同，不足以把三篇一起归组；组内每一对都要有同事件依据。
7. 人工修正：本地命令可调整分类、关联或拆分；操作留审计记录，清除修正后可恢复自动处理结果。没有开放匿名写入接口。
8. 缓存与重试：输入和规则实现都纳入版本指纹；未变化的分类复用，重复运行不增加相同处理记录。采集更新了原文而处理尚未完成时，接口会标明过期或待处理。

去重关系和事件关联不会删除文章。当前文章列表仍保留原始记录，详情返回重复/事件关系，便于后续网页按关系折叠展示。事件归组没有改变文章的原始发布日期，也不代表其中的事实已核验。

## 怎么运行

只处理当前数据库，不重新采集：

```powershell
& '.\process.ps1'
```

采集、入库、处理一次完成，仍使用原来的命令：

```powershell
& '.\run.ps1'
```

持续采集与处理：

```powershell
& '.\run.ps1' -Watch
```

没有安装后台任务；持续模式需保持窗口运行。单独处理不会启动网页服务；`run.ps1` 自行启动的临时服务会在退出时关闭。

## 查看结果

先运行 `start-web.ps1`，再访问：

| 地址 | 内容 |
| --- | --- |
| `http://127.0.0.1:4320/api/content/processing` | 已处理、待复核、过期、候选关联与事件数量 |
| `http://127.0.0.1:4320/api/content/articles?type=news` | 新闻类型 |
| `http://127.0.0.1:4320/api/content/articles?type=tutorial` | 教程类型 |
| `http://127.0.0.1:4320/api/content/articles?topic=security` | 安全领域 |
| `http://127.0.0.1:4320/api/content/articles?review=true` | 需要复核或只有初步判断的文章 |
| `http://127.0.0.1:4320/api/content/articles/实际文章ID` | 原始资料、分类依据、关联和事件 |
| `http://127.0.0.1:4320/api/content/events` | 已有充分依据归组的事件；没有时返回空列表 |

内容类型：`news`、`tutorial`、`knowledge`、`tool`、`review`、`unknown`。

技术领域：`ai`、`hardware`、`systems`、`software`、`networks`、`databases`、`security`、`research`、`industry`、`ai_science`。

`classified` 表示当前方法给出了分类，`provisional` 表示标题级初步判断，`needs_review` 表示材料或分类依据不足。`method` 区分规则、模型、人工；`confidence` 是方法给出的参考值，尚未校准为统计概率，不能当成事实准确率或质量总分。

关联中的 `score` 是标题字符相似度，不是“同事件概率”。`pending` 候选不会成为已确认事件。`followup_id` 标记后续报道是哪一篇。

## 人工纠错与撤销

以调整一篇文章类型为例，先把下列 JSON 中的 ID 替换为真实文章 ID，保存为项目的 `data\override.json`：

```json
{
  "kind": "label",
  "article_id": "替换为真实文章ID",
  "content_type": "knowledge",
  "topics": ["software"],
  "technology_relevance": "relevant",
  "reason": "已核对，该文主要解释技术原理"
}
```

在 PowerShell 执行：

```powershell
. '.\scripts\env.ps1'
Set-Location '.\web'
corepack pnpm exec tsx scripts/process-content.ts override ..\data\override.json
& '..\process.ps1'
```

命令会返回 `override_key`。撤销时使用实际返回值，并写明原因：

```powershell
corepack pnpm exec tsx scripts/process-content.ts clear-override '实际override_key' '撤销本次人工修正'
& '..\process.ps1'
```

拆分误关联时，JSON 使用 `kind: "relation"`、两个实际文章ID `left_id/right_id`、`relation: "not_related"` 和原因，运行相同命令。其他可选关系为 `duplicate`、`same_event`、`follow_up`、`possible_related`。设置 `follow_up` 时还需 `followup_id` 指明后续文章。

人工修正保存后，在下一次 `process.ps1` 才生效；此期间 `snapshot_changed` 会提示有待处理的变化。修正与撤销均保留记录，不更改原文。后续可基于这些操作增加管理页面。

## 可选模型分类

默认只运行规则，不会自动使用付费模型。模型服务需在本机环境配置：`AI_API_KEY`、`AI_MODEL`，可选 `AI_API_BASE`；设置 `PROCESSING_AI_ENABLED=1` 才开启。密钥不放入源码、JSON报告或命令参数。

模型接入直接复用 TrendRadar 的 `AIClient.chat()` 与 `AIFilter.classify_batch()`。适配层增加正文片段、多技术领域、理由及原文引用检查。返回的分类或关系没有原文依据时退回规则或待确认；调用失败保留可用结果。已人工修正的内容不重复发送模型，已成功处理的相同输入复用结果。

`config\processing.json` 控制规则、候选窗口、阈值和调用上限。当前默认每次处理最多2次分类请求、每次12篇，最多1次关系判断请求、最多8对候选；不会一次性无限调用。剩余内容留到后续处理。缓存需要输入、规则实现和模型标识一致。

本次没有配置密钥，未进行真实模型质量、费用或跨语言语义准确率验证。中文与英文报道只在标识、动作、日期等依据充分时按规则归组，其余留作候选。

## 存储与源码复用

| 位置 | 作用 |
| --- | --- |
| `collector\process_content.py` | 清洗、规则分类、模型适配与关联判断 |
| `config\processing.json` | 可解释的类型、技术领域与实体规则 |
| `web\server\database\processing.ts` | 派生表、导入验证、事件、人工修正与审计 |
| `web\scripts\process-content.ts` | 导出一致性快照、导入结果及本地管理命令 |
| `data\processing\input.json` | 当前处理快照 |
| `data\processing\output.json` | 最近一次处理结果与模型调用计数 |
| `data\processing\runs` | 历次处理结果 |
| `data\backups` | 处理前的一致性数据库备份及源码备份 |
| `logs\processing-*.log` | 处理、测试与接口验证记录 |

直接复用：已有 URL/采集/原文能力；TrendRadar 的 `RSSParser._clean_text()`、`matches_word_groups()`、`AIFilter.classify_batch()`、`AIClient.chat()`；RapidFuzz 的 `fuzz.ratio()`、`process.extract()`；NewsNow 原数据库依赖和内容接口框架。

zenfeed 的相关报道组织方式作为设计参考，没有复制其 Go 服务或向量索引。事件冲突规则、派生存储和适配代码是本项目补充。原始材料视为数据，不作为程序指令执行。

## 验证范围

覆盖重复运行、跨 Python/Node JSON 数字指纹、未知日期、相同摘要、代码缩进、不同产品/版本/CVE/价格规格、否认/传闻、补丁先后关系、链式误合并、模型捏造引用、模型失败、缓存、人工修正撤销、过期快照拒绝、只读接口及原有采集功能。

真实数据中无法判断的条目继续待确认。没有用模拟案例填充真实事件库，也没有把单元测试通过率当成分类准确率。事实摘要、质量评优、新网页界面与长期无人值守稳定性仍属于后续工作。
