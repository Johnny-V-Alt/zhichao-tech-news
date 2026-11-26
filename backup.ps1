$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1')
& $collectorPython (Join-Path $appRoot 'scripts\database-maintenance.py') backup
if ($LASTEXITCODE -ne 0) { throw '备份未完成。' }
