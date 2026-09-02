@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
where python >nul 2>nul || (
  echo Python 3.11 or newer is required.
  pause
  exit /b 1
)
where npm >nul 2>nul || (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
python -m pip install -r requirements.txt || exit /b 1
pushd medha_desktop
if not exist node_modules call npm install || exit /b 1
call npm start
popd
