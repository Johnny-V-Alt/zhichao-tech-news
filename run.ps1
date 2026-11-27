param([switch]$Watch, [int]$BodyBudget = -1)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1')
$lock = $null
$ownedServer = $null
$cycleFailed = $false
try {
    # One collector/importer at a time, including watch mode. Data itself is never deleted.
    $lock = [IO.File]::Open((Join-Path $appRoot 'data\collector.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $ready = $false
    try {
        $null = Invoke-RestMethod 'http://127.0.0.1:4320/api/content/status' -TimeoutSec 2
        $ready = $true
    } catch { }
    if (-not $ready) {
        $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')
        $ownedServer = Start-Process -FilePath (Get-Command node).Source -ArgumentList @((Join-Path $appRoot 'web\dist\output\server\index.mjs')) -WorkingDirectory (Join-Path $appRoot 'web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appRoot "logs\server-$stamp.log") -RedirectStandardError (Join-Path $appRoot "logs\server-$stamp.err.log") -PassThru
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if ($ownedServer.HasExited) { throw 'The local NewsNow service exited before becoming ready; inspect logs.' }
            try {
                $null = Invoke-RestMethod 'http://127.0.0.1:4320/api/content/status' -TimeoutSec 2
                $ready = $true
                break
            } catch { Start-Sleep -Milliseconds 500 }
        }
        if (-not $ready) { throw 'The local NewsNow service did not become ready on port 4320.' }
    }
    do {
        $cycleFailed = $false
        $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')
        try {
            $collectArgs = @((Join-Path $appRoot 'collector\collect.py'), '--body-budget', '0')
            # Durable body work runs after importing links, including off-feed history.
            & $collectorPython @collectArgs 2>&1 | Tee-Object (Join-Path $appRoot "logs\collect-$stamp.log")
            $collectorExit = $LASTEXITCODE
            Push-Location (Join-Path $appRoot 'web')
            try {
                corepack pnpm exec tsx scripts/import-content.ts 2>&1 | Tee-Object (Join-Path $appRoot "logs\import-$stamp.log")
                $importExit = $LASTEXITCODE
            } finally { Pop-Location }
            & (Join-Path $appRoot 'backfill.ps1') -Budget $BodyBudget -InCollection -SkipProcess 2>&1 | Tee-Object (Join-Path $appRoot "logs\backfill-$stamp.log")
            $backfillExit = $LASTEXITCODE
            & (Join-Path $appRoot 'process.ps1') 2>&1 | Tee-Object (Join-Path $appRoot "logs\processing-$stamp.log")
            $processingExit = $LASTEXITCODE
            & (Join-Path $appRoot 'editorialize.ps1') 2>&1 | Tee-Object (Join-Path $appRoot "logs\editorial-$stamp.log")
            $editorialExit = $LASTEXITCODE
            $status = Invoke-RestMethod 'http://127.0.0.1:4320/api/content/status' -TimeoutSec 10
            $sourceStates = Invoke-RestMethod 'http://127.0.0.1:4320/api/content/sources' -TimeoutSec 10
            @{ checked_at=[DateTime]::UtcNow.ToString('o'); collector_exit=$collectorExit; import_exit=$importExit; processing_exit=$processingExit; backfill_exit=$backfillExit; editorial_exit=$editorialExit; editorial_state=$status.editorial.state; database=$status; sources=$sourceStates } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $appRoot 'data\last-run.json') -Encoding UTF8
            if ($collectorExit -ne 0 -or $importExit -ne 0 -or $backfillExit -ne 0 -or $processingExit -ne 0 -or $editorialExit -ne 0) { throw "Collection exit=$collectorExit; import exit=$importExit; processing exit=$processingExit. See logs and data\last-run.json." }
            Write-Output "Collection stored. Total articles: $($status.articles); failed sources: $($status.failed_sources). Editorial state: $($status.editorial.state)."
        } catch {
            $cycleFailed = $true
            Write-Warning $_
        }
        if ($Watch) {
            $config = Get-Content -LiteralPath (Join-Path $appRoot 'config\sources.json') -Raw | ConvertFrom-Json
            $interval = [Math]::Max(60, [int]$config.interval_seconds)
            Write-Output "Next collection in $interval seconds. Press Ctrl+C to stop."
            Start-Sleep -Seconds $interval
        }
    } while ($Watch)
} finally {
    if ($ownedServer) {
        $ownedServer.Refresh()
        if (-not $ownedServer.HasExited) {
            $currentProcess = Get-Process -Id $ownedServer.Id -ErrorAction SilentlyContinue
            if ($currentProcess -and $currentProcess.StartTime -eq $ownedServer.StartTime) {
                Stop-Process -Id $ownedServer.Id
            }
        }
    }
    if ($lock) { $lock.Dispose() }
}
if ($cycleFailed) { exit 1 }
