param([int]$ProcessId, [string]$JobId, [string]$StartedAt, [string]$StartTicks = '')
$ErrorActionPreference = 'Stop'
try {
    $workerProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $workerProcess -or $workerProcess.ProcessName -notin @('pwsh', 'powershell')) { 'False'; exit 0 }
    $actualTicks = $workerProcess.StartTime.ToUniversalTime().Ticks.ToString()
    if ($StartTicks) {
        if ($StartTicks -ne $actualTicks) { 'False'; exit 0 }
    } else {
        $jobStarted = [DateTimeOffset]::Parse($StartedAt).UtcDateTime
        if ([Math]::Abs(($workerProcess.StartTime.ToUniversalTime() - $jobStarted).TotalSeconds) -gt 20) { 'False'; exit 0 }
    }
    $workerCommand = (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId").CommandLine
    $runnerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'job-runner.ps1'))
    $isOwned = $JobId -match '^[a-f0-9]{24}$' -and $workerCommand -and
        $workerCommand.IndexOf($runnerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $workerCommand.Contains($JobId)
    if ($isOwned) { 'True' } else { 'False' }
} catch { 'False' }
