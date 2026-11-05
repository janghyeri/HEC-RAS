@echo off
rem ==========================================================================
rem  10-minute flood depth images for the web (time player on the map, 3D view).
rem  Reads existing HEC-RAS results only - HEC-RAS is NOT run (about 2-3 min).
rem  Pohang_web and the original Pohang folder are NOT modified.
rem
rem   S0-E, S0-C           : Pohang_web results
rem   S2-mh150, S2-mh050   : jobs\R2_manhole150_post0_1102_212734, jobs\S2_mh050
rem   run-1                : jobs\run-1 (web run) - also uploaded to Supabase
rem
rem  Output: frames_out\v1\<scenario>\frames\  and  frames_out\<scenario>_frames.zip
rem ==========================================================================
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
set "HERE=%~dp0"
set "CONDA=%USERPROFILE%\anaconda3"
if exist "%CONDA%\Scripts\activate.bat" call "%CONDA%\Scripts\activate.bat" "%CONDA%"
cd /d "%HERE%code"
python -c "import h5py, numpy, PIL, tifffile; print('python packages ok')"
if errorlevel 1 goto :nopkg

set "PW=%HERE%Pohang_web"
set "J=%HERE%jobs"
set "OUT=%HERE%frames_out"

echo ===== 1. depth images =====
python -m pipeline.frames_web --terrain "%PW%\NC090901\Terrain\Terrain.all.tif" --out-root "%OUT%" --zip ^
  --job S0-E="%PW%\NC090901\NC0909.p03.hdf" ^
  --job S0-C="%PW%\NC090902\NC090902.p03.hdf" ^
  --job S2-mh150="%J%\R2_manhole150_post0_1102_212734\NC090902\NC090902.p03.hdf" ^
  --job S2-mh050="%J%\S2_mh050\NC090902\NC090902.p03.hdf" ^
  --job run-1="%J%\run-1\NC090902\NC090902.p03.hdf"

echo ===== 2. upload run-1 images to Supabase =====
if exist "%OUT%\v1\run-1\frames\frames.json" python -m worker.upload_frames --dir "%OUT%\v1\run-1\frames" --prefix v1/run-1

echo.
echo Done. Report: %OUT%\frames_report.json
pause
exit /b 0

:nopkg
echo Python packages are missing: h5py numpy pillow tifffile
pause
exit /b 1
