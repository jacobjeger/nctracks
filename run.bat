@echo off
title NCTracks Eligibility Verifier
echo === NCTracks Eligibility Verifier ===

:: Try python, then python3, then py launcher
where python >nul 2>&1
if %ERRORLEVEL%==0 (
    python "%~dp0main.py"
    goto :end
)

where python3 >nul 2>&1
if %ERRORLEVEL%==0 (
    python3 "%~dp0main.py"
    goto :end
)

where py >nul 2>&1
if %ERRORLEVEL%==0 (
    py "%~dp0main.py"
    goto :end
)

echo.
echo ERROR: Python is not installed.
echo Please install Python from https://www.python.org/downloads/
echo Make sure to check "Add Python to PATH" during installation.
echo.
pause

:end
