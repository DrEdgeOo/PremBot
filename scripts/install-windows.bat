@echo off
setlocal enableextensions

REM PremBot installer/updater for Windows.
REM Downloads the latest source from GitHub and copies it into the CEP
REM extensions folder so Premiere picks up the changes on next panel reload.
REM
REM Edit BRANCH below if you want to track a different branch.

set "REPO=DrEdgeOo/PremBot"
set "BRANCH=claude/adobe-premiere-plugin-askaU"
set "DEST=%APPDATA%\Adobe\CEP\extensions\PremBot"
set "TMPZIP=%TEMP%\PremBot-update.zip"
set "TMPDIR=%TEMP%\PremBot-update-extracted"

echo.
echo === PremBot update ===
echo Repo:   %REPO%
echo Branch: %BRANCH%
echo Dest:   %DEST%
echo.

REM Clean previous temp artefacts.
if exist "%TMPZIP%" del /q "%TMPZIP%"
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"

echo Downloading latest source...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri 'https://github.com/%REPO%/archive/refs/heads/%BRANCH%.zip' -OutFile '%TMPZIP%'"
if errorlevel 1 (
    echo.
    echo Download failed. Check your internet connection and the BRANCH name.
    goto :fail
)

echo Extracting...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; Expand-Archive -Path '%TMPZIP%' -DestinationPath '%TMPDIR%' -Force"
if errorlevel 1 (
    echo Extraction failed.
    goto :fail
)

REM GitHub archives extract into a single top-level folder named
REM "<repo>-<branch with slashes replaced by dashes>". Locate it.
set "SRC="
for /d %%D in ("%TMPDIR%\*") do set "SRC=%%D"

if not defined SRC (
    echo Could not locate extracted folder under %TMPDIR%.
    goto :fail
)
if not exist "%SRC%\host\index.jsx" (
    echo Extracted folder is missing host\index.jsx - something is wrong.
    echo Looked in: %SRC%
    goto :fail
)

if not exist "%DEST%" (
    echo Creating destination %DEST% ...
    mkdir "%DEST%"
)

echo Copying files into the CEP extensions folder...
robocopy "%SRC%\client" "%DEST%\client" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP
robocopy "%SRC%\host"   "%DEST%\host"   /MIR /NFL /NDL /NJH /NJS /NC /NS /NP
robocopy "%SRC%\CSXS"   "%DEST%\CSXS"   /MIR /NFL /NDL /NJH /NJS /NC /NS /NP

REM Robocopy uses exit codes 0-7 to indicate success/warnings; >= 8 is an error.
if errorlevel 8 (
    echo Robocopy reported errors copying files.
    goto :fail
)

echo.
echo === Done. ===
echo Reload the PremBot panel in Premiere ^(Window ^> Extensions ^> PremBot^)
echo or restart Premiere to pick up the new code.
echo.
goto :cleanup

:fail
echo.
echo Update FAILED. Nothing was changed in your CEP extensions folder
echo unless robocopy partially ran above.
echo.
exit /b 1

:cleanup
if exist "%TMPZIP%" del /q "%TMPZIP%"
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
endlocal
exit /b 0
