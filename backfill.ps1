param([int]$Budget = -1, [switch]$RetryFailed, [switch]$InCollection, [switch]$SkipProcess)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1')
$lock = $null
try {
    if (-not $InCollection) { $lock = [IO.File]::Open((Join-Path $appRoot 'data\collector.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    $arguments = @((Join-Path $appRoot 'collector\backfill.py'))
    if ($Budget -ge 0) { $arguments += @('--budget', "$Budget") }
    if ($RetryFailed) { $arguments += '--retry-failed' }
    & $collectorPython @arguments
    if ($LASTEXITCODE -ne 0) { throw '正文补抓任务未完成，请检查日志。' }
    Push-Location (Join-Path $appRoot 'web')
    try {
        corepack pnpm exec tsx scripts/import-content.ts
        if ($LASTEXITCODE -ne 0) { throw '正文补抓结果入库失败，待入库文件已保留。' }
    } finally { Pop-Location }
    & $collectorPython (Join-Path $appRoot 'collector\backfill.py') --status-only
    if ($LASTEXITCODE -ne 0) { throw '正文补抓状态核对失败。' }
    if (-not $SkipProcess) {
        & (Join-Path $appRoot 'process.ps1')
        if ($LASTEXITCODE -ne 0) { throw '正文已保存，但分类整理需要重试。' }
    }
} finally {
    if ($lock) { $lock.Dispose() }
}
