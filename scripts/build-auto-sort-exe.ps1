param(
  [string]$PythonExe = "python"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EntryScript = Join-Path $PSScriptRoot "auto_sort_downloads.py"
$OutputDir = Join-Path $ProjectRoot "release\auto-sort"
$TempBuildRoot = Join-Path ([System.IO.Path]::GetTempPath()) "withcue-auto-sort-build"
$TempEntryScript = Join-Path $TempBuildRoot "auto_sort_downloads.py"
$TempDistDir = Join-Path $TempBuildRoot "dist"
$TempWorkDir = Join-Path $TempBuildRoot "work"

Write-Host "Starting WithCueAutoSort.exe build."
Write-Host "Output directory: $OutputDir"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if (Test-Path -LiteralPath $TempBuildRoot) {
  Remove-Item -LiteralPath $TempBuildRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $TempBuildRoot | Out-Null
New-Item -ItemType Directory -Force -Path $TempDistDir | Out-Null
New-Item -ItemType Directory -Force -Path $TempWorkDir | Out-Null
Copy-Item -LiteralPath $EntryScript -Destination $TempEntryScript -Force

& $PythonExe -m PyInstaller `
  --onefile `
  --console `
  --name "WithCueAutoSort" `
  --distpath $TempDistDir `
  --workpath $TempWorkDir `
  --specpath $TempWorkDir `
  $TempEntryScript

if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller build failed with exit code $LASTEXITCODE."
}

Copy-Item -LiteralPath (Join-Path $TempDistDir "WithCueAutoSort.exe") `
  -Destination (Join-Path $OutputDir "WithCueAutoSort.exe") `
  -Force

Write-Host "WithCueAutoSort.exe build complete."
