$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1')
Push-Location (Join-Path $appRoot 'web')
try {
    node dist/output/server/index.mjs
} finally {
    Pop-Location
}
