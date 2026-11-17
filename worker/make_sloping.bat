@echo off
rem ==========================================================================
rem  Re-draw flood depth images with the SLOPING water surface (same idea as
rem  RAS Mapper "Sloping", the render mode in NC090902.rasmap):
rem    frames\   10-min depth classes, 4 m  (2D map time view, 3D fallback)
rem    depth2m\  continuous depth, 2 m + max.png  (3D water surface)
rem    tiles\    max depth tiles z10-16  (2D map)
rem  Reads existing HEC-RAS results only - HEC-RAS is NOT run (about 15-30 min).
rem  Pohang_web and the original Pohang folder are NOT modified.
rem  KPI (kpi.json, cell based) is NOT changed.
rem
rem  Output: sloping_out\v1\<scenario>\  and  sloping_out\<scenario>_web.zip
rem          run-1 files are also uploaded to Supabase
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
set "OUT=%HERE%sloping_out"

echo ===== 1. sloping depth images (frames, depth2m, tiles) =====
python -m pipeline.frames_web --depth2m --tiles --terrain "%PW%\NC090901\Terrain\Terrain.all.tif" --out-root "%OUT%" --zip ^
  --job S0-E="%PW%\NC090901\NC0909.p03.hdf" ^
  --job S0-C="%PW%\NC090902\NC090902.p03.hdf" ^
  --job S2-mh150="%J%\R2_manhole150_post0_1102_212734\NC090902\NC090902.p03.hdf" ^
  --job S2-mh050="%J%\S2_mh050\NC090902\NC090902.p03.hdf" ^
  --job run-1="%J%\run-1\NC090902\NC090902.p03.hdf"

echo ===== 2. upload run-1 to Supabase =====
set "R1=%OUT%\v1\run-1"
if exist "%R1%\frames\frames.json" python -m worker.upload_frames --dir "%R1%\frames" --prefix v1/run-1 --name frames
if exist "%R1%\depth2m\frames.json" python -m worker.upload_frames --dir "%R1%\depth2m" --prefix v1/run-1 --name depth2m
if exist "%R1%\tiles\tiles.json" python -m worker.upload_frames --dir "%R1%\tiles" --prefix v1/run-1 --name tiles

echo.
echo Done. Report: %OUT%\frames_report.json
pause
exit /b 0

:nopkg
echo Python packages are missing: h5py numpy pillow tifffile
pause
exit /b 1
