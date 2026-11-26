$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1')
Write-Output '知潮：本机运行检查'
foreach ($required in @('web\dist\output\server\index.mjs','web\node_modules','vendor\TrendRadar\LICENSE','web\LICENSE','config\sources.json','config\editorial.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $appRoot $required))) { throw "缺少：$required" }
}
node --version
& $collectorPython --version
& $collectorPython (Join-Path $appRoot 'scripts\database-maintenance.py') check
if ($LASTEXITCODE -ne 0) { throw '数据库检查未通过。' }
Write-Output '源码、依赖入口、构建产物和数据库检查通过。'
Write-Output 'AI需要本机模型配置；本检查不发送模型请求。'
