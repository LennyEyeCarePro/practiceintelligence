@echo off
title Practice Intelligence — Local Server
echo.
echo  Practice Intelligence — Local Server
echo  =====================================
echo.

:: Check if node is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed. Download it from https://nodejs.org
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

:: Check if public folder has files
if not exist "public\seo-tool.html" (
    echo Setting up HTML files...
    node setup-public.js
    echo.
)

:: Check for .env file
if not exist ".env" (
    echo.
    echo WARNING: No .env file found!
    echo Copy .env.example to .env and add your API keys.
    echo.
    pause
    exit /b 1
)

:: Start server and open browser
echo Starting server...
start "" http://localhost:3000/seo-tool.html
node server.js
pause
