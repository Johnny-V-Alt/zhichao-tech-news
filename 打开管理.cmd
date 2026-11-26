@echo off
chcp 65001 >nul
if exist "C:\Program Files\PowerShell\7\pwsh.exe" (
  "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" -Admin
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" -Admin
)
pause
