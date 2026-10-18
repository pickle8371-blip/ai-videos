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

if not exist dist-server\server\index.js goto :build
if not exist dist-web\index.html goto :build
goto :run

:build
echo [Voidcraft] Building...
call npm run build
if errorlevel 1 goto :fail

:run
if not defined VOIDCRAFT_PORT set VOIDCRAFT_PORT=5174
echo [Voidcraft] Starting on http://localhost:%VOIDCRAFT_PORT%  (Ctrl+C to stop)
start "" "http://localhost:%VOIDCRAFT_PORT%"
node dist-server\server\index.js
goto :eof

:fail
echo [Voidcraft] Setup failed. See the messages above.
pause
exit /b 1
