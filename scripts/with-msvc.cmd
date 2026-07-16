@echo off
setlocal

set "VSDEVCMD=%ProgramW6432%\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
if not exist "%VSDEVCMD%" set "VSDEVCMD=%ProgramFiles%\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat"
if not exist "%VSDEVCMD%" set "VSDEVCMD=%ProgramFiles%\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat"
if not exist "%VSDEVCMD%" set "VSDEVCMD=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
if not exist "%VSDEVCMD%" set "VSDEVCMD=%ProgramFiles(x86)%\Microsoft Visual Studio\2017\Community\Common7\Tools\VsDevCmd.bat"
if not exist "%VSDEVCMD%" (
  echo Unable to find VsDevCmd.bat. Install Visual Studio Build Tools with the Windows SDK.
  exit /b 1
)

call "%VSDEVCMD%" -arch=x64 -host_arch=x64 >nul
if errorlevel 1 exit /b %errorlevel%

for /d %%D in ("%ProgramFiles(x86)%\Microsoft Visual Studio\2017\Community\VC\Tools\MSVC\*") do (
  if exist "%%~fD\include\excpt.h" set "INCLUDE=%%~fD\include;%INCLUDE%"
)

for /d %%D in ("%ProgramW6432%\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\*") do (
  if exist "%%~fD\lib\onecore\x64\msvcrt.lib" (
    set "LIB=%%~fD\lib\onecore\x64;%LIB%"
    goto :run
  )
)

for /d %%D in ("%ProgramW6432%\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\*") do (
  if exist "%%~fD\lib\onecore\x64\msvcrt.lib" (
    set "LIB=%%~fD\lib\onecore\x64;%LIB%"
    goto :run
  )
)

for /f "delims=" %%P in ('where /r "%ProgramW6432%\Microsoft Visual Studio" msvcrt.lib 2^>nul') do (
  set "LIB=%%~dpP;%LIB%"
  goto :run
)

:run
%*
