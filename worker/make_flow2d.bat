@echo off
rem ==========================================================================
rem  Flow directions for the 3D view ("flow" button): floodplain (2D) cell
rem  velocities from HEC-RAS Face Velocity, plus river flow for run-1.
rem  Reads existing HEC-RAS results only - HEC-RAS is NOT run (about 3-5 min).
rem  Pohang_web and the original Pohang folder are NOT modified.
rem
rem   S0-E, S0-C           : Pohang_web results
rem   S2-mh150, S2-mh050   : jobs\R2_manhole150_post0_1102_212734, jobs\S2_mh050
rem   run-1                : jobs\run-1 (web run) - also uploaded to Supabase
rem
rem  Output: flow2d_out\v1\<scenario>\flow2d.json, flow2d.bin
rem          flow2d_out\flow2d.zip  (send this back, or leave it for Claude)
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
set "OUT=%HERE%flow2d_out"

echo ===== 1. floodplain flow (2D) =====
python -m pipeline.flow2d_web --terrain "%PW%\NC090901\Terrain\Terrain.all.tif" --out-root "%OUT%" ^
  --job S0-E="%PW%\NC090901\NC0909.p03.hdf" ^
  --job S0-C="%PW%\NC090902\NC090902.p03.hdf" ^
  --job S2-mh150="%J%\R2_manhole150_post0_1102_212734\NC090902\NC090902.p03.hdf" ^
  --job S2-mh050="%J%\S2_mh050\NC090902\NC090902.p03.hdf" ^
  --job run-1="%J%\run-1\NC090902\NC090902.p03.hdf"

echo ===== 2. river flow for run-1 =====
python -m pipeline.river_flow --hdf "%J%\run-1\NC090902\NC090902.p03.hdf" --out "%OUT%\v1\run-1\river_flow.json" --scenario run-1

echo ===== 3. zip =====
python -c "import zipfile,pathlib; r=pathlib.Path(r'%OUT%'); z=zipfile.ZipFile(r/'flow2d.zip','w',zipfile.ZIP_DEFLATED); [z.write(p, p.relative_to(r).as_posix()) for p in sorted(r.rglob('*')) if p.is_file() and p.suffix in ('.json','.bin') and p.name!='flow2d.zip']; z.close(); print('zip ok')"

echo ===== 4. upload run-1 files to Supabase =====
if exist "%OUT%\v1\run-1\flow2d.json" python -m worker.upload_extra --dir "%OUT%\v1\run-1" --prefix v1/run-1 flow2d.json flow2d.bin river_flow.json

echo.
echo Done. Report: %OUT%\flow2d_report.json
pause
exit /b 0

:nopkg
echo Python packages are missing: h5py numpy pillow tifffile
pause
exit /b 1
