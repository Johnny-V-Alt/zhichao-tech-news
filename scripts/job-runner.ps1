param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{24}$')][string]$JobId, [Parameter(Mandatory=$true)][ValidateSet('collect','process','editorial','backfill')][string]$Kind)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$operationsRoot = Join-Path $projectRoot 'data\operations'
$jobPath = Join-Path $operationsRoot "jobs\$JobId.json"
$job = Get-Content -LiteralPath $jobPath -Raw | ConvertFrom-Json
function Save-Job {
    $job | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath "$jobPath.partial" -Encoding UTF8
    Move-Item -LiteralPath "$jobPath.partial" -Destination $jobPath -Force
}
$job.state = 'running'
$job.pid = $PID
$job | Add-Member -NotePropertyName start_ticks -NotePropertyValue ((Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString()) -Force
Save-Job
$nativeExit = 1
try {
    $scriptName = @{collect='run.ps1';process='process.ps1';editorial='editorialize.ps1';backfill='backfill.ps1'}[$Kind]
    $extraArguments = @()
    if ($Kind -eq 'backfill' -and $job.trigger -eq 'manual') { $extraArguments += '-RetryFailed' }
    & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot $scriptName) @extraArguments
    $nativeExit = $LASTEXITCODE
    $job.exit_code = $nativeExit
    $job.state = $(if ($nativeExit -eq 0) { 'succeeded' } else { 'failed' })
} catch {
    $job.exit_code = 1
    $job.state = 'failed'
    Write-Warning '任务未完成；请检查该任务日志和流程状态。'
} finally {
    $job.finished_at = [DateTime]::UtcNow.ToString('o')
    Save-Job
    $lockPath = Join-Path $operationsRoot 'job.lock'
    if ((Test-Path -LiteralPath $lockPath) -and (Get-Content -LiteralPath $lockPath -Raw).Trim() -eq $JobId) { Remove-Item -LiteralPath $lockPath }
}
exit $nativeExit
