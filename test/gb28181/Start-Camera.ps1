param(
  [string]$Server = '192.168.100.189',
  [string]$LocalIp = '192.168.100.182',
  [int]$Port = 5060,
  [ValidateSet('2016','2022')][string]$Version = '2016',
  [ValidateSet('tcp','udp')][string]$Signaling = 'tcp',
  [ValidateSet('tcp-passive','tcp-active','udp')][string]$Media = 'tcp-passive',
  [int]$Seconds = 300,
  [string]$ServerId = '34020000002000000001',
  [string]$DeviceId = '34020000001320000001',
  [string]$ChannelId = '34020000001320000002',
  [string]$Realm = '3402000000',
  [string]$Sample = '',
  [switch]$IsolatedTest
)
$ErrorActionPreference = 'Stop'
if (-not $Sample) { $Sample = Join-Path $PSScriptRoot 'h264-aac.psrecords' }
$cameraArgs = @((Join-Path $PSScriptRoot 'virtual_camera.py'), '--server', $Server, '--local-ip', $LocalIp,
  '--port', $Port, '--version', $Version, '--signaling', $Signaling, '--media', $Media,
  '--seconds', $Seconds, '--sample', $Sample, '--server-id', $ServerId,
  '--device-id', $DeviceId, '--channel-id', $ChannelId, '--realm', $Realm)
if ($IsolatedTest) { $cameraArgs += '--isolated-test' }
& py -3.10 @cameraArgs
exit $LASTEXITCODE
