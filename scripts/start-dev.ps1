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

# 서버 API 하네스(api/**)는 .env.server.local 의 자격증명(서비스 계정 또는 에뮬레이터)을 읽는다.
$serverEnvFile = Join-Path $projectRoot ".env.server.local"
$apiCommand = "Set-Location -LiteralPath '$projectRoot'; npm run dev:api"
$usesEmulator = (Test-Path $serverEnvFile) -and (Select-String -Path $serverEnvFile -Pattern '^\s*FIRESTORE_EMULATOR_HOST\s*=\s*\S' -Quiet)

if (-not (Test-Path $serverEnvFile)) {
  Write-Warning ".env.server.local 이 없습니다. .env.server.example 을 복사해 채우지 않으면 API 하네스가 바로 종료됩니다."
}

if ($usesEmulator) {
  $emulatorCommand = "Set-Location -LiteralPath '$projectRoot'; npm run emulators"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $emulatorCommand
  Start-Sleep -Seconds 8
}

Start-Process powershell -ArgumentList "-NoExit", "-Command", $apiCommand
Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCommand
Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCommand

Write-Host "API 하네스, 카메라 백엔드, 프론트 개발 서버를 각각 새 창에서 실행했습니다."
if ($usesEmulator) { Write-Host "Firebase 에뮬레이터도 띄웠습니다(프론트는 VITE_USE_FIREBASE_EMULATORS=true 필요)." }
Write-Host "API: $projectRoot (npm run dev:api)"
Write-Host "백엔드: $backendRoot"
Write-Host "프론트: $frontendRoot"
