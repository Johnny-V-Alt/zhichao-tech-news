$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1')
$editorialLock = $null
try {
    $editorialLock = [IO.File]::Open((Join-Path $appRoot 'data\editorial.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    Push-Location (Join-Path $appRoot 'web')
    try {
        corepack pnpm exec tsx scripts/editorial-content.ts export
        if ($LASTEXITCODE -ne 0) { throw 'Unable to export editorial snapshot.' }
        & $collectorPython (Join-Path $appRoot 'collector\editorialize.py')
        if ($LASTEXITCODE -ne 0) { throw 'Editorial worker failed; last publication is retained.' }
        corepack pnpm exec tsx scripts/editorial-content.ts import
        if ($LASTEXITCODE -ne 0) { throw 'Editorial import failed; last publication is retained.' }
        $outcome = Get-Content -LiteralPath (Join-Path $appRoot 'data\editorial\output.json') -Raw | ConvertFrom-Json
        if ($outcome.state -in @('failed','partial_error','processing_required')) { throw "Editorial state: $($outcome.state); inspect editorial status and logs." }
        Write-Output "Editorial state: $($outcome.state)."
        if ($outcome.state -eq 'not_configured') { Write-Output 'Model configuration is required for actual AI summaries.' }
    } finally { Pop-Location }
} finally { if ($editorialLock) { $editorialLock.Dispose() } }
