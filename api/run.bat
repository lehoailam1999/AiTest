@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Chua co .venv. Chay: python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo [INFO] Da tao .env tu .env.example
  )
)

echo [INFO] Starting Python API: http://localhost:5000
echo [INFO] Health: http://localhost:5000/health
".venv\Scripts\python.exe" -m uvicorn app.main:app --reload --host 0.0.0.0 --port 5000
