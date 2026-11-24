@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js nao encontrado. Abra o CMD onde npm start funciona.
  pause
  exit /b 1
)
echo Feche o aplicativo NovaMind antes de instalar. O servidor DirectX pode continuar aberto.
pause
node "%~dp0instalar.js" "E:\NovaMind-work"
if errorlevel 1 (
  echo Instalacao interrompida. Confira a mensagem acima.
) else (
  echo Abra o NovaMind pelo BAT de inicializacao habitual.
)
pause