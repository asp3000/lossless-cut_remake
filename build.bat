@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem build.bat - build LosslessCut (frame-precise keyframe cut)
rem             Windows unpacked app only (dist\win-unpacked)
rem ============================================================

set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

set "YARN=node "%~dp0.yarn\releases\yarn-4.18.0.cjs""

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH. Install Node.js 18+ first.
    pause
    exit /b 1
)

echo === [1/3] Dependencies ===
if exist "node_modules" goto :deps_ok
%YARN% install || goto :fail
:deps_ok
echo Dependencies ready.

echo === [2/3] Bundled ffmpeg (win32-x64) ===
if exist "ffmpeg\win32-x64\lib\ffmpeg.exe" if exist "ffmpeg\win32-x64\lib\ffprobe.exe" goto :ffmpeg_ok
mkdir "ffmpeg\win32-x64\lib" 2>nul
where ffmpeg >nul 2>nul
if errorlevel 1 goto :ffmpeg_download
for /f "delims=" %%i in ('where ffmpeg') do call :ffmpeg_from "%%~dpi"
if exist "ffmpeg\win32-x64\lib\ffmpeg.exe" if exist "ffmpeg\win32-x64\lib\ffprobe.exe" goto :ffmpeg_ok

:ffmpeg_download
%YARN% download-ffmpeg-win32-x64 || goto :fail

:ffmpeg_ok
echo Bundled ffmpeg ready.

echo === [3/3] Building app (electron-vite) ===
if exist "out" rd /s /q "out"
%YARN% build || goto :fail

echo === Packing unpacked app (dist\win-unpacked, no installer/portable exe) ===
if exist "dist\win-unpacked" rd /s /q "dist\win-unpacked"
if exist "dist\win-unpacked.tmp" rd /s /q "dist\win-unpacked.tmp"
call npx electron-builder --win --x64 --dir || goto :fail

echo.
echo === Build OK. Unpacked app is in "dist\win-unpacked" (run LosslessCut.exe). ===
pause
exit /b 0

:fail
echo.
echo [ERROR] Build failed. See messages above.
pause
exit /b 1

:ffmpeg_from
if exist "ffmpeg\win32-x64\lib\ffprobe.exe" goto :eof
copy /y "%~1ffmpeg.exe" "ffmpeg\win32-x64\lib\" >nul 2>nul
copy /y "%~1ffprobe.exe" "ffmpeg\win32-x64\lib\" >nul 2>nul
goto :eof

