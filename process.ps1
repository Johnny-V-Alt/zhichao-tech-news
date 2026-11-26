$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1')
$processingLock = $null
try {
    $processingLock = [IO.File]::Open((Join-Path $appRoot 'data\processing.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    Push-Location (Join-Path $appRoot 'web')
    try {
        corepack pnpm exec tsx scripts/process-content.ts export
        if ($LASTEXITCODE -ne 0) { throw 'Unable to export a consistent processing snapshot.' }
        & $collectorPython (Join-Path $appRoot 'collector\process_content.py')
        if ($LASTEXITCODE -ne 0) { throw 'Content processing failed; previous derived results are retained.' }
        corepack pnpm exec tsx scripts/process-content.ts import
        if ($LASTEXITCODE -ne 0) { throw 'Unable to import derived results; inspect errors and rerun.' }
    } finally { Pop-Location }
} finally {
    if ($processingLock) { $processingLock.Dispose() }
}
