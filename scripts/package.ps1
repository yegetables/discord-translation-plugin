# 打包扩展为 zip（Chrome Web Store / 备份用）
# 用法：pwsh scripts/package.ps1
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$version = (Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json).version
$zip = Join-Path $dist "discord-translation-plugin-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }

# 只打包运行所需文件（不含 README/LICENSE/scripts/dist/.git 等）
$items = @("manifest.json", "background.js", "content", "popup", "lib", "icons")
Push-Location $root
try {
  Compress-Archive -Path $items -DestinationPath $zip
} finally {
  Pop-Location
}
Write-Host "打包完成: $zip"
