@echo off
rem Re-run the Pohang_web baseline plans with the HEC-RAS command line (no GUI clicks).
rem Note: Ras.exe -c can return before post-processing ends; check "Complete Process" in the
rem compute messages of the result HDF before reading it (worker/compare_results.py does not wait).
setlocal
set "RAS=C:\Program Files (x86)\HEC\HEC-RAS\6.6\Ras.exe"
set "W=C:\Hec-Ras\HECRASMCP\Pohang_web"
set "LOG=C:\Hec-Ras\HECRASMCP\run_baseline.log"
>"%LOG%" echo RAS=%RAS%
if not exist "%RAS%" (>>"%LOG%" echo ERROR Ras.exe not found & exit /b 1)
>>"%LOG%" echo [%date% %time%] start NC0909
"%RAS%" -c "%W%\NC090901\NC0909.prj" "%W%\NC090901\NC0909.p03"
>>"%LOG%" echo [%date% %time%] end NC0909 exit=%errorlevel%
>>"%LOG%" echo [%date% %time%] start NC090902
"%RAS%" -c "%W%\NC090902\NC090902.prj" "%W%\NC090902\NC090902.p03"
>>"%LOG%" echo [%date% %time%] end NC090902 exit=%errorlevel%
>>"%LOG%" echo DONE
