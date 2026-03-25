$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot "backend"
$frontendRoot = Join-Path $projectRoot "frontend"

$pythonCommand = if (Get-Command py -ErrorAction SilentlyContinue) {
  "py"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  "python"
} else {
  throw "Python 실행 명령을 찾지 못했습니다. python 또는 py가 설치되어 있어야 합니다."
}

$frontendCommand = "Set-Location -LiteralPath '$frontendRoot'; npm run dev"
$backendCommand = "Set-Location -LiteralPath '$backendRoot'; $pythonCommand app_web.py"

Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCommand
Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCommand

Write-Host "백엔드와 프론트 개발 서버를 각각 새 창에서 실행했습니다."
Write-Host "백엔드: $backendRoot"
Write-Host "프론트: $frontendRoot"
