@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title HTS Training Data Viewer

:: ── 1. Find Python ────────────────────────────────────────
call :FIND_PYTHON
if defined PYTHON goto :HAVE_PYTHON

:: ── 2. Install Python and look again ─────────────────────
echo Python not found. Installing now (no admin rights needed)...
echo.
call :INSTALL_PYTHON
call :FIND_PYTHON
if defined PYTHON goto :HAVE_PYTHON

echo.
echo Could not install Python automatically.
echo Please install from https://python.org
echo Check "Add Python to PATH" during setup, then run this file again.
echo.
pause
exit /b 1

:HAVE_PYTHON
echo Using Python: !PYTHON!
echo.

:: ── 3. Check data files ───────────────────────────────────
set MISSING=0
if not exist "..\train.jsonl" (
    echo WARNING: ..\train.jsonl not found
    set MISSING=1
)
if not exist "..\train (1).jsonl" (
    echo WARNING: "..\train (1).jsonl" not found
    set MISSING=1
)
if !MISSING!==1 (
    echo.
    echo The JSONL data files must sit in the folder above web\.
    echo Expected:
    echo   ..\train.jsonl
    echo   "..\train (1).jsonl"
    echo.
    pause
    exit /b 1
)

:: ── 4. Fetch HTS enrichment data if needed ────────────────
if not exist "hts.db" (
    echo hts.db not found. Downloading HTS descriptions from USITC...
    "!PYTHON!" hts_fetch.py
    if errorlevel 1 echo hts_fetch.py failed - continuing without enrichment.
    echo.
)

if not exist "ca_tariff.db" (
    echo ca_tariff.db not found. Downloading Canadian Customs Tariff from CBSA...
    "!PYTHON!" ca_tariff_fetch.py
    if errorlevel 1 echo ca_tariff_fetch.py failed - continuing without Canadian rates.
    echo.
)

:: ── 5. Kill old server and start fresh ───────────────────
echo Stopping any old server on port 8765...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765.*LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul
echo Starting server (loads data files, ~20 sec)...
"!PYTHON!" server.py
if errorlevel 1 pause
exit /b 0


:: ════════════════════════════════════════════════════════
:FIND_PYTHON
:: Check PATH first
set PYTHON=
where python >nul 2>&1
if not errorlevel 1 (set "PYTHON=python" & goto :eof)
where py >nul 2>&1
if not errorlevel 1 (set "PYTHON=py" & goto :eof)
:: Check common install locations (covers installs not yet on PATH)
for %%v in (313 312 311 310 39 38) do (
    if exist "%LOCALAPPDATA%\Programs\Python\Python%%v\python.exe" (
        set "PYTHON=%LOCALAPPDATA%\Programs\Python\Python%%v\python.exe"
        goto :eof
    )
)
for %%v in (313 312 311 310 39 38) do (
    if exist "C:\Python%%v\python.exe" (
        set "PYTHON=C:\Python%%v\python.exe"
        goto :eof
    )
)
goto :eof


:: ════════════════════════════════════════════════════════
:INSTALL_PYTHON
:: Try winget first (available on Windows 10 1709+ and Windows 11)
where winget >nul 2>&1
if not errorlevel 1 (
    echo Trying winget...
    winget install --id Python.Python.3.11 -e --accept-package-agreements --accept-source-agreements
    goto :eof
)
:: Fall back to direct download via PowerShell (no winget needed, no admin needed)
set "PYINST=%TEMP%\python_setup.exe"
echo Downloading Python 3.11 installer (~25 MB)...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe','%PYINST%')"
if not exist "%PYINST%" (
    echo Download failed. Check your internet connection.
    goto :eof
)
echo Installing Python silently...
"%PYINST%" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0 Include_pip=1
del "%PYINST%" >nul 2>&1
goto :eof
