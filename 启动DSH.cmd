@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  DSH integrated desktop - DAILY LAUNCHER (browser mode)
rem
rem  NOTE: this is NOT the same as the emergency browser-launch cmd
rem    this one  : daily driver, port 3080, isolated DSH_HOME
rem    that one  : emergency escape, port 3199, shares ~/.dsh
rem
rem  Single source of truth: <project>\tools\start-dsh.ps1
rem
rem  IMPORTANT: keep this file ASCII-only.
rem  cmd.exe parses the .cmd itself as GBK/ANSI *before* chcp 65001 takes
rem  effect, so any UTF-8 Chinese comment here turns into mojibake and
rem  breaks the script (already hit this once). All Chinese output comes
rem  from the PowerShell script instead.
rem ============================================================
set "PS1=%~dp0tools\start-dsh.ps1"
if not exist "%PS1%" (
  echo [!] missing: "%PS1%"
  pause
  exit /b 1
)
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
%PS% -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
pause >nul
