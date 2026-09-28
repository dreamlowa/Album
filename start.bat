@echo off
chcp 65001 >nul
title Семейный архив — запуск
echo ============================================
echo   Семейный архив (локальный режим, SQLite)
echo ============================================
echo.

cd /d "%~dp0backend"

rem Проверка Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не установлен. Скачайте с https://nodejs.org
  pause
  exit /b 1
)

rem Установка зависимостей (при первом запуске)
if not exist "node_modules" (
  echo Устанавливаю зависимости, подождите...
  call npm install
  if errorlevel 1 (
    echo [ОШИБКА] Не удалось установить зависимости
    pause
    exit /b 1
  )
)

echo.
echo Запускаю сервер: http://localhost:3000
echo Вход: admin / admin
echo Для остановки закройте это окно.
echo.
start "" http://localhost:3000
node src/index.js

pause