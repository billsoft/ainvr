param(
  [Parameter(Mandatory)][string]$Repository,
  [Parameter(Mandatory)][string]$Data,
  [ValidatePattern('^ainvr-[a-z0-9-]+$')][string]$Name = 'ainvr-oe370-final',
  [switch]$PrintOnly
)
$ErrorActionPreference = 'Stop'
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'approved-recipes.json') -Raw | ConvertFrom-Json
$repoPath = (Resolve-Path -LiteralPath $Repository).Path
$dataPath = (Resolve-Path -LiteralPath $Data).Path
if ($repoPath.Contains(',') -or $dataPath.Contains(',')) { throw 'Docker mount paths cannot contain commas.' }
if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'test/model_conversion/final/check_environment.py'))) { throw 'Repository snapshot is missing final scripts.' }
$dockerArgs = @('run','-d','--name',$Name,'--gpus','all','--cpus','8','--memory','16g','--memory-swap','20g','--shm-size','2g',
  '--mount',"type=bind,source=$repoPath,target=/repo,readonly",
  '--mount',"type=bind,source=$dataPath,target=/data,readonly",
  '--mount',"type=volume,source=$Name-work,target=/work",
  '--entrypoint','/bin/bash',$lock.image,'-lc','exec sleep infinity')
if ($PrintOnly) { $dockerArgs | ConvertTo-Json; exit 0 }
$imageId = & docker image inspect $lock.image --format '{{.Id}}'
if ($LASTEXITCODE -ne 0 -or $imageId -ne $lock.image_id) { throw 'Pinned official image is missing or differs; run Get-OeGpu.ps1 -Load first.' }
& docker @dockerArgs
if ($LASTEXITCODE -ne 0) { throw 'Container creation failed; inspect the named container before retrying.' }
& docker exec $Name python3 /repo/test/model_conversion/final/check_environment.py
if ($LASTEXITCODE -ne 0) { throw 'Environment check failed; container retained for diagnosis.' }
Write-Output "Ready: $Name. Work persists in Docker volume $Name-work; back it up before removing that volume."
