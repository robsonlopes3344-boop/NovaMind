@echo off
setlocal EnableExtensions
chcp 65001 >nul
title NovaMind - Instalador e Preparador
cd /d "%~dp0"

echo ================================================
echo              NOVAMIND DESKTOP
echo   Instalacao do Hermes + compilacao do aplicativo
echo ================================================
echo.

rem Preserva a pasta Hermes existente; em PCs novos usa o padrao oficial do Windows.
if exist "E:\Hermes\Data\.env" (
  set "HERMES_HOME=E:\Hermes\Data"
) else (
  set "HERMES_HOME=%LOCALAPPDATA%\hermes"
)
setx HERMES_HOME "%HERMES_HOME%" >nul

where hermes >nul 2>nul
if errorlevel 1 (
  echo [1/4] Instalando Hermes Agent oficial para Windows...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm https://hermes-agent.nousresearch.com/install.ps1)"
  if errorlevel 1 goto erro
  if exist "%LOCALAPPDATA%\hermes\bin" set "PATH=%LOCALAPPDATA%\hermes\bin;%PATH%"
  where hermes >nul 2>nul
  if errorlevel 1 (
    echo O Hermes foi instalado, mas o comando ainda nao esta no PATH.
    echo Feche esta janela, abra novamente o BAT e tente outra vez.
    pause
    exit /b 1
  )
) else (
  echo [1/4] Hermes Agent ja esta instalado.
)

echo.
echo [2/4] Verificando Node.js para compilar o NovaMind...
where node >nul 2>nul
if errorlevel 1 (
  where winget >nul 2>nul
  if errorlevel 1 (
    echo O Windows nao possui winget. Instale Node.js LTS em https://nodejs.org/ e execute este BAT novamente.
    start https://nodejs.org/
    goto erro
  )
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
  if errorlevel 1 goto erro
  if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm nao foi encontrado. Reinicie o Windows e execute este BAT novamente.
  goto erro
)

 echo.
echo [3/4] Instalando dependencias e compilando o instalador do NovaMind...
call npm install --no-audit --no-fund
if errorlevel 1 goto erro
call npm run dist
if errorlevel 1 goto erro

 echo.
echo [4/4] Preparando Hermes Agent para iniciar junto com o NovaMind...
echo O primeiro uso em um PC novo pode solicitar que voce escolha/autentique um provedor de modelo.
echo Essa etapa e necessaria porque as credenciais do seu PC nao devem ser copiadas automaticamente.
echo.

if exist "release\NovaMind-Setup-1.0.0.exe" (
  start "" "release\NovaMind-Setup-1.0.0.exe"
) else (
  for %%F in (release\NovaMind-Setup-*.exe) do if exist "%%~fF" start "" "%%~fF"
)
echo.
echo Concluido. Termine a instalacao do NovaMind pelo instalador que abriu.
echo Depois, abra NovaMind pelo atalho. O Hermes sera iniciado automaticamente.
pause
exit /b 0

:erro
echo.
echo A instalacao nao terminou. Confira a mensagem acima e tente novamente.
pause
exit /b 1