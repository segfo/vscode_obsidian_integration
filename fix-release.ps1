# fix-release.ps1 — 間違えたバージョンを取り消して正しいバージョンでリリースし直す
#
# Usage:
#   .\fix-release.ps1 -Wrong 1.0.0 -Correct 1.0.20

param(
    [Parameter(Mandatory = $true)][string]$Wrong,
    [Parameter(Mandatory = $true)][string]$Correct
)

$ErrorActionPreference = "Stop"
$Root     = $PSScriptRoot
$WrongTag = "v$Wrong"

function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "    $msg"  -ForegroundColor Yellow }

# ── GitHub Release を削除 ─────────────────────────────────────────────────────
Step "GitHub Release $WrongTag を削除..."
$releaseExists = gh release view $WrongTag 2>$null
if ($LASTEXITCODE -eq 0) {
    gh release delete $WrongTag --yes
    Write-Host "    削除しました。"
} else {
    Warn "Release $WrongTag は存在しないためスキップ。"
}

# ── リモートタグを削除 ────────────────────────────────────────────────────────
Step "リモートタグ $WrongTag を削除..."
$remoteTag = git ls-remote --tags origin "refs/tags/$WrongTag"
if ($remoteTag) {
    git push origin ":refs/tags/$WrongTag"
    Write-Host "    削除しました。"
} else {
    Warn "リモートにタグ $WrongTag は存在しないためスキップ。"
}

# ── ローカルタグを削除 ────────────────────────────────────────────────────────
Step "ローカルタグ $WrongTag を削除..."
$localTag = git tag -l $WrongTag
if ($localTag) {
    git tag -d $WrongTag
} else {
    Warn "ローカルにタグ $WrongTag は存在しないためスキップ。"
}

# ── 正しいバージョンで再デプロイ ─────────────────────────────────────────────
Step "v$Correct で再デプロイ..."
& "$Root\deploy.ps1" $Correct
