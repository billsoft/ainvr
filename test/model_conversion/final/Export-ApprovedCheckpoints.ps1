param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'approved-recipes.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
$destination = (Resolve-Path -LiteralPath $Directory).Path
foreach ($entry in $lock.recipes.PSObject.Properties) {
  $r = $entry.Value
  $target = Join-Path $destination $r.checkpoint_file
  if (-not (Test-Path -LiteralPath $target)) {
    & docker cp "$($r.historical_container):$($r.historical_bc_path)" "$target.partial"
    if ($LASTEXITCODE -ne 0) { throw "Checkpoint unavailable: $($entry.Name). See documented historical source; no compilation was restarted." }
    if ((Get-FileHash -LiteralPath "$target.partial" -Algorithm SHA256).Hash.ToLower() -ne $r.bc_sha256) { throw "Checkpoint mismatch: $($entry.Name)" }
    Move-Item -LiteralPath "$target.partial" -Destination $target
  }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower() -ne $r.bc_sha256) { throw "Existing checkpoint mismatch: $($entry.Name)" }
  Write-Output "$($entry.Name): verified"
}
