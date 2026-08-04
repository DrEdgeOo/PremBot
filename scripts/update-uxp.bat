@echo off
setlocal enableextensions

REM PremBot UXP updater for Windows.
REM
REM Assumes the folder containing this repo is the same folder UDT is
REM "Load and Watch"-ing as uxp\. After pulling, UDT auto-reloads
REM index.js and index.html. If manifest.json changed, you must manually
REM Unload + Load and Watch in UDT.
REM
REM Place this .bat anywhere inside the repo and double-click it.

set "BRANCH=main"

pushd "%~dp0\.."

echo.
echo === PremBot UXP update ===
echo Repo dir: %CD%
echo Branch:   %BRANCH%
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo This folder is not a git repo. Aborting.
    goto :fail
)

echo Fetching origin...
git fetch origin
if errorlevel 1 goto :fail

REM Switch to the working branch if we're not already on it.
for /f "tokens=*" %%B in ('git rev-parse --abbrev-ref HEAD') do set "CUR=%%B"
if /i not "%CUR%"=="%BRANCH%" (
    echo Switching from %CUR% to %BRANCH% ...
    git checkout %BRANCH%
    if errorlevel 1 goto :fail
)

echo.
echo Changes incoming:
git --no-pager log --oneline HEAD..origin/%BRANCH%
echo.

git pull --ff-only origin %BRANCH%
if errorlevel 1 (
    echo.
    echo Fast-forward pull failed - your local branch has diverged.
    echo Run    git status    to see why.
    goto :fail
)

echo.
echo === Done. ===
echo UDT will hot-reload index.js / index.html automatically.
echo If manifest.json changed in the diff above, Unload + Load and Watch in UDT.
echo.
popd
pause
exit /b 0

:fail
popd
echo.
echo UPDATE FAILED.
pause
exit /b 1
