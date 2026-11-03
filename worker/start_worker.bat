@echo off
rem ==========================================================================
rem  Web run worker (Step 5). Double-click and leave the window open.
rem
rem  - Takes queued runs from Supabase (web /run page), runs HEC-RAS 6.6 on a
rem    copy of Pohang_web (1D post-processing ON, about 9 min per run),
rem    converts the result and uploads it to Supabase Storage.
rem  - Writes a heartbeat every 30 s, so the web page shows "server on".
rem  - If Python stops with an error, it restarts after 30 s.
rem  - Stop: press Ctrl+C (twice) or close this window.
rem    A run in progress is then marked "failed" and can be requested again.
rem
rem  Needs code\worker\.env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_ID).
rem  Pohang_web and the original Pohang folder are NOT modified.
rem  Job folders: jobs\run-<id>
rem ==========================================================================
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
set "HERE=%~dp0"
set "CONDA=%USERPROFILE%\anaconda3"
if exist "%CONDA%\Scripts\activate.bat" call "%CONDA%\Scripts\activate.bat" "%CONDA%"
cd /d "%HERE%code"
if not exist "worker\.env" (
  echo code\worker\.env is missing. Run check_supabase.bat first.
  pause
  exit /b 1
)
python -c "import h5py, numpy, PIL, tifffile; print('python packages ok')"
if errorlevel 1 (
  echo Python packages are missing: h5py numpy pillow tifffile
  pause
  exit /b 1
)
title HEC-RAS web worker
:loop
echo [%date% %time%] worker start
python -m worker.run_worker
echo [%date% %time%] worker stopped (exit code %errorlevel%). Restart in 30 s - close the window to quit.
timeout /t 30
goto loop
