# 知潮 · 计算机科技资讯

把计算机相关的新消息聚合到一起，按领域、时间和来源阅读，保留原文依据，再进行人工选稿或可选的 AI 归纳与评优。

**Windows 本机网站。优先复用 NewsNow、TrendRadar，再用连接代码组成完整的数据与阅读流程。**

## 下载后怎样运行

准备以下环境：

- Windows 10/11、PowerShell。推荐 PowerShell 7。
- Node.js **24**、Corepack（包管理器版本由 `web/package.json` 固定）。开发验证版本为 Node.js 24.19.0。
- Python **3.12**，开发验证版本为3.12.16。
- 首次安装需要联网下载依赖。源码仓库不包含依赖二进制、已采集文章、密钥或模型。

在项目根目录打开 PowerShell：

```powershell
# 首次安装
& .\setup.ps1

# 启动网站
& .\launch.ps1
```

如果系统策略阻止运行该脚本，可仅为这次进程执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

安装完成后，也可以双击：

| 文件 | 用途 |
| --- | --- |
| `启动网站.cmd` | 启动网站并打开浏览器 |
| `打开管理.cmd` | 打开本机管理页面 |
| `停止网站.cmd` | 停止启动器记录的本项目服务 |

首页：`http://127.0.0.1:4320/`。保持启动窗口打开；Ctrl+C停止服务。首次内容库为空，服务启动后会自动采集，状态可在来源页和管理页查看。迁移电脑后需要重新安装依赖，不能只搬运构建产物。

`setup.ps1` 会在项目内创建 `.runtime`、`.cache`、`data`、`logs`。不依赖原开发电脑上的D盘路径。需要指定Python位置时：

```powershell
& .\setup.ps1 -PythonExecutable 'C:\你的Python312\python.exe'
```

## 已接通的功能

- 多来源采集、RSS与正文提取、统一SQLite内容库、失败状态和原始字段保存。
- 清洗、去重、领域/类型分类、同事件关联、版本与后续进展记录。
- 桌面和手机阅读、关键词搜索、来源/领域/时间/类型筛选、分页和本机收藏。
- 文章正文/来源摘要、原始日期、引用链接与分类依据。
- 人工推荐、推荐理由、短引文、核验说明与撤下。
- 可选AI归纳、评分、精选、简报归档；无模型时明确为空，不生成假摘要。
- 本机管理、同源写入保护、分类/关系纠错、来源配置、任务日志和审计。
- 服务运行期间定时采集、失败重试、一键启动/停止、诊断与数据库备份。

首页默认近72小时、已有计算机科技依据的资讯。待确认和全部原始收录可切换查看。规则可能误判，保留人工纠错；不宣称完整覆盖互联网。来源摘要不等于本站独立事实核验。

## AI 是可选项

没有模型接口，也能采集、浏览、搜索、收藏和人工选稿。

实际AI分析需要自行配置模型服务、密钥和预算。默认关闭：

```powershell
$env:AI_MODEL = 'provider/model'
$env:AI_API_BASE = '服务商要求的地址'
$env:EDITORIAL_AI_ENABLED = '1'
$secret = Read-Host 'API key（仅在本机输入）' -AsSecureString
$env:AI_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
Remove-Variable secret
& .\editorialize.ps1
```

占位符需要替换；使用默认地址的服务可不设置 `AI_API_BASE`。模型适配沿用TrendRadar/LiteLLM。默认每轮新增分析最多2条、应用层调用最多4次；限额不是费用保证。实际模型兼容性、质量和计费尚未完成真实验证。

模型提供带引文的事实、变化、意义和评分理由；程序检查原文引文、数值、单位和日期，另一次模型调用检查来源一致性。评分权重：相关性25、时效30、依据20、影响15、新增信息10。时效门槛由程序控制，旧闻不能靠高分变成新消息。模型检查不是独立事实核验。

不要提交API密钥、管理码或真实数据库。管理只监听本机，不是面向公网的多用户账户系统。部署公网需要另行完成服务与权限配置；GitHub源码仓库本身不会运行网站。

## 代码复用

| 项目 | 直接使用的部分 | 来源 |
| --- | --- | --- |
| NewsNow | 网站工程、React/TanStack Router/Query、来源适配、缓存、科技热榜卡片、PWA、db0/better-sqlite3 | [newsnext/newsnow](https://github.com/newsnext/newsnow) |
| TrendRadar | 热榜采集、RSS解析、ArticleReaderTools、关键词匹配、AIClient、AI批处理/JSON提取与提示词加载 | [sansan0/TrendRadar](https://github.com/sansan0/TrendRadar) |
| Trafilatura | 网页正文提取备用实现 | [adbar/trafilatura](https://github.com/adbar/trafilatura) |
| RapidFuzz | 相似标题候选检索 | [rapidfuzz/RapidFuzz](https://github.com/rapidfuzz/RapidFuzz) |

`zenfeed`、`Folo`仅作结构参考，没有复制它们的代码。新增的主要是模块衔接、存储协议、跨来源处理规则、评分门槛、阅读页面组合和本机管理。上游固定提交、文件指纹与说明见 `UPSTREAM.json`。

保留所有第三方许可证和来源声明。TrendRadar及采集端为GPLv3，NewsNow原代码保留MIT声明；详见 `LICENSE`、`web/LICENSE`、`collector/LICENSE`、`vendor/TrendRadar/LICENSE` 和 `THIRD_PARTY_NOTICES.md`。新增整合代码按GPLv3提供，第三方代码继续适用各自许可证。

## 结构

```text
web/                   NewsNow基础上的网站、API和SQLite存储
collector/             采集/整理/可选AI编辑连接程序与测试
vendor/TrendRadar/     固定版本的上游源码与许可证
config/                来源、整理规则、编辑策略和提示词
scripts/               本机环境、固定任务入口与数据库维护
setup.ps1              首次依赖安装、初始化与构建
launch.ps1             本机启动器
PROCESSING.md          整理协议及人工修正规则
EDITORIAL.md           编辑、评分及模型配置细节
```

## 验证

原集成版通过133项自动测试（Node86、Python47）、62项隔离管理接口检查和桌面/手机浏览器验证；完成8个来源的真实采集。模型测试使用模拟接口，不能据此推断真实模型效果。公开仓库不携带开发机器的文章库、管理会话或测试数据。

安装完成后的检查命令：

```powershell
. .\scripts\env.ps1
& $collectorPython -m pytest collector -q
Push-Location web
try {
  corepack pnpm exec vitest run
  corepack pnpm run typecheck
} finally { Pop-Location }
& .\doctor.ps1
```

修改代码后先停止网站，再在 `web` 目录执行 `corepack pnpm run build`，避免Windows锁住SQLite原生模块。默认服务内调度已经负责定时采集；如果使用 `run.ps1 -Watch`，先在管理页关闭服务内自动采集。
