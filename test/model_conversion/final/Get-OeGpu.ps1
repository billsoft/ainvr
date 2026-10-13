param([Parameter(Mandatory)][string]$Directory, [switch]$Load)
$ErrorActionPreference = 'Stop'
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'approved-recipes.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
$target = Join-Path (Resolve-Path -LiteralPath $Directory).Path 'ai_toolchain_ubuntu_22_s100_s600_gpu_v3.7.0.tar'
$url = 'https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/oe/3.7.0/ai_toolchain_ubuntu_22_s100_s600_gpu_v3.7.0.tar'
if (-not (Test-Path -LiteralPath $target)) {
  & curl.exe --fail --location --continue-at - --retry 2 --connect-timeout 30 --output "$target.partial" $url
  if ($LASTEXITCODE -ne 0) { throw 'Download incomplete; partial retained for retry.' }
  if ((Get-FileHash -LiteralPath "$target.partial" -Algorithm SHA256).Hash.ToLower() -ne $lock.image_tar_sha256) { throw 'Archive hash mismatch; not loading.' }
  Move-Item -LiteralPath "$target.partial" -Destination $target
}
if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower() -ne $lock.image_tar_sha256) { throw 'Archive hash mismatch.' }
if ($Load) {
  & docker load --input $target
  if ($LASTEXITCODE -ne 0) { throw 'Docker load failed.' }
}
Write-Output "Verified archive: $target (recorded local identity, not a publisher signature)."
