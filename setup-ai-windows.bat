@echo off
setlocal
title Voidcraft.Video - Local AI setup
cd /d "%~dp0"

echo [Voidcraft] Local AI engine setup (PyTorch + diffusers, runs on this PC, no API keys).
echo.

set "PY="
for %%V in (3.12 3.11 3.10) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>nul && set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; assert (3,9) <= sys.version_info[:2] < (3,14)" >nul 2>nul && set "PY=python"
)

if not defined PY (
  echo [Voidcraft] Python 3.10-3.12 was not found.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo     Install Python 3.12 from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^),
    echo     then run this file again.
    pause
    exit /b 1
  )
  choice /m "Install Python 3.12 now with winget"
  if errorlevel 2 exit /b 1
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  echo.
  echo [Voidcraft] Python installed. Close this window and run setup-ai-windows.bat again.
  pause
  exit /b 0
)

echo [Voidcraft] Using %PY%
echo [Voidcraft] Downloading PyTorch and diffusers (about 3-5 GB). This takes a while.
echo.
%PY% engine\setup_engine.py %*
if errorlevel 1 (
  echo.
  echo [Voidcraft] Setup failed. Copy the error text above when asking for help.
  pause
  exit /b 1
)
echo.
echo [Voidcraft] Done. Start the app with start-windows.bat, then open Settings -^> Local AI
echo             and download a model (one time).
pause
