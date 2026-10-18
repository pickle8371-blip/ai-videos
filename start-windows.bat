@echo off
setlocal
title Voidcraft.Video
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Voidcraft] Node.js was not found. Install Node.js 22 LTS from https://nodejs.org or run:
  echo     winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  if not defined FFMPEG_PATH (
    echo [Voidcraft] WARNING: FFmpeg was not found on PATH. Exports, previews and thumbnails need it.
    echo     Install with: winget install Gyan.FFmpeg   ^(then open a new terminal^)
    echo     or set FFMPEG_PATH and FFPROBE_PATH to the executables.
    echo.
  )
)

if not exist node_modules (
  echo [Voidcraft] Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

rem Rebuild when there is no build yet or the source is newer (e.g. after unzipping an update).
node scripts\needs-build.mjs
if errorlevel 1 goto :build
goto :run

:build
echo [Voidcraft] Building...
call npm run build
if errorlevel 1 goto :fail

:run
if not exist engine\.venv\Scripts\python.exe (
  echo [Voidcraft] The local AI engine is not installed yet. Run setup-ai-windows.bat,
  echo     or click "Install engine" in the app ^(Settings -^> Local AI^).
  echo.
)
if not defined VOIDCRAFT_PORT set VOIDCRAFT_PORT=5174
echo [Voidcraft] Starting on http://localhost:%VOIDCRAFT_PORT%  (Ctrl+C to stop)
echo [Voidcraft] Your browser opens when the server is ready. Keep this window open while you use the app.
set VOIDCRAFT_OPEN_BROWSER=1
node dist-server\server\index.js
echo.
echo [Voidcraft] The server stopped. If this was not you, copy the messages above when asking for help.
pause
goto :eof

:fail
echo [Voidcraft] Setup failed. See the messages above.
pause
exit /b 1
