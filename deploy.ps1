# deploy.ps1 — Build and publish a GitHub Release
#
# Usage:
#   .\deploy.ps1 1.0.20
#
# Requirements:
#   - Node.js / npm
#   - gh CLI (authenticated)

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version
)

$ErrorActionPreference = "Stop"

$Tag         = "v$Version"
$Root        = $PSScriptRoot
$ObsidianDir = "$Root\obsidian-plugin"
$VscodeDir   = "$Root\vscode-extension"
$DistDir     = "$Root\dist"

# ── Helper ───────────────────────────────────────────────────────────────────
function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Update-JsonVersion([string]$Path) {
    $json = Get-Content $Path -Raw | ConvertFrom-Json
    $json.version = $Version
    $json | ConvertTo-Json -Depth 10 | Set-Content $Path -Encoding UTF8
}

# ── Clean dist ───────────────────────────────────────────────────────────────
if (Test-Path $DistDir) { Remove-Item $DistDir -Recurse -Force }
New-Item -ItemType Directory -Path $DistDir | Out-Null

# ── Bump versions ────────────────────────────────────────────────────────────
Step "Syncing version: $Version"
Update-JsonVersion "$ObsidianDir\manifest.json"
Update-JsonVersion "$ObsidianDir\package.json"
Update-JsonVersion "$VscodeDir\package.json"

# ── Build Obsidian plugin ────────────────────────────────────────────────────
Step "Building Obsidian plugin..."
Push-Location $ObsidianDir
try {
    npm ci --prefer-offline 2>$null
    if ($LASTEXITCODE -ne 0) { npm install }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Obsidian plugin build failed" }
} finally { Pop-Location }

Copy-Item "$ObsidianDir\main.js"       "$DistDir\main.js"
Copy-Item "$ObsidianDir\manifest.json" "$DistDir\manifest.json"

# ── Build VSCode extension ───────────────────────────────────────────────────
Step "Building VSCode extension..."
Push-Location $VscodeDir
try {
    npm ci --prefer-offline 2>$null
    if ($LASTEXITCODE -ne 0) { npm install }
    npm run compile
    if ($LASTEXITCODE -ne 0) { throw "VSCode extension compile failed" }
    npx @vscode/vsce package --allow-missing-repository --out "$DistDir\obsidianpreview.vsix"
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed" }
} finally { Pop-Location }

# ── Create vscode-integration.zip ────────────────────────────────────────────
Step "Creating vscode-integration.zip..."
$TmpDir = "$DistDir\vscode-integration"
New-Item -ItemType Directory -Path $TmpDir | Out-Null
Copy-Item "$DistDir\main.js"       "$TmpDir\"
Copy-Item "$DistDir\manifest.json" "$TmpDir\"
Compress-Archive -Path $TmpDir -DestinationPath "$DistDir\vscode-integration.zip" -Force
Remove-Item $TmpDir -Recurse -Force

# ── Verify artifacts ─────────────────────────────────────────────────────────
Step "Artifacts:"
Get-ChildItem $DistDir | Format-Table Name, Length -AutoSize

$required = @("main.js", "manifest.json", "obsidianpreview.vsix", "vscode-integration.zip")
foreach ($f in $required) {
    if (-not (Test-Path "$DistDir\$f")) {
        throw "Missing artifact: $f"
    }
}

# ── Commit version bump & tag ─────────────────────────────────────────────────
# 現在のコミットにタグをつける
git tag $Tag
if ($LASTEXITCODE -ne 0) { throw "git tag failed" }

# ── Push & create GitHub Release ─────────────────────────────────────────────
Step "Pushing tag $Tag..."
git push origin HEAD
if ($LASTEXITCODE -ne 0) { throw "git push HEAD failed" }

git push origin $Tag
if ($LASTEXITCODE -ne 0) { throw "git push tag failed" }

# Step "Creating GitHub Release $Tag..."
Write-Host $Tag
Write-Host $DistDir
gh release create $Tag `
    --title $Tag `
    --generate-notes `
    "$DistDir\main.js" `
    "$DistDir\manifest.json" `
    "$DistDir\obsidianpreview.vsix" `
    "$DistDir\vscode-integration.zip"

if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }

Write-Host ""
Write-Host "Done! Release $Tag published." -ForegroundColor Green
