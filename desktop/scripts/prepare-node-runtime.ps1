param(
  [string]$NodeVersion = "22.12.0",
  [string]$Arch = "x64"
)
$ErrorActionPreference = "Stop"
$DesktopRoot = Split-Path -Parent $PSScriptRoot
$Resources = Join-Path $DesktopRoot "resources"
$Target = Join-Path $Resources "node"
$Cache = Join-Path $DesktopRoot ".cache"
$ZipName = "node-v$NodeVersion-win-$Arch.zip"
$ZipPath = Join-Path $Cache $ZipName
$DownloadUrl = "https://nodejs.org/dist/v$NodeVersion/$ZipName"
$ChecksumsUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
$ExtractRoot = Join-Path $Cache "node-extract"
$Extracted = Join-Path $ExtractRoot "node-v$NodeVersion-win-$Arch"

if ((Test-Path (Join-Path $Target "node.exe")) -and (Test-Path (Join-Path $Target "node_modules\npm\bin\npm-cli.js"))) {
  Write-Host "[node] bundled runtime already exists: $Target"
  exit 0
}

New-Item -ItemType Directory -Force -Path $Cache | Out-Null
if (-not (Test-Path $ZipPath)) {
  Write-Host "[node] downloading $DownloadUrl"
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipPath -UseBasicParsing
}
$Checksums = (Invoke-WebRequest -Uri $ChecksumsUrl -UseBasicParsing).Content
$ChecksumLine = @($Checksums -split "`n" | Where-Object { $_.Trim().EndsWith("  $ZipName") })
if ($ChecksumLine.Count -ne 1) { throw "Missing official checksum for $ZipName" }
$ExpectedHash = ($ChecksumLine[0] -split '\s+')[0].ToLowerInvariant()
if ((Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash) {
  Remove-Item $ZipPath -Force
  throw "Node runtime checksum mismatch for $ZipName"
}
Remove-Item -Recurse -Force $ExtractRoot -ErrorAction SilentlyContinue
Expand-Archive -Path $ZipPath -DestinationPath $ExtractRoot -Force
Remove-Item -Recurse -Force $Target -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Path (Join-Path $Extracted "*") -Destination $Target -Recurse -Force
Remove-Item -Recurse -Force $ExtractRoot
Write-Host "[node] prepared Node.js $NodeVersion win-$Arch"
