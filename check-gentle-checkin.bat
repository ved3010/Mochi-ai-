@echo off
echo ========================================================
echo   Running Gentle Check-in and Stuck Detector Tests
echo ========================================================
echo.
echo [1/2] Running tests/gentle-checkin.test.js ...
node --test tests/gentle-checkin.test.js
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Gentle check-in tests failed!
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo [2/2] Running tests/stuck-detector.test.js ...
node --test tests/stuck-detector.test.js
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Stuck detector tests failed!
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo ========================================================
echo   ALL TESTS PASSED SUCCESSFULLY!
echo ========================================================
pause
