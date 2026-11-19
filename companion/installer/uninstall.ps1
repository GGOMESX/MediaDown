<#
.SYNOPSIS
  Removes the MediaDown companion for the current user. Downloaded videos are not touched.
#>
[CmdletBinding()]
param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'MediaDown'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HostName = 'com.mediadown.host'
$RegistryRoots = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)

Get-Process -Name 'mediadown-host', 'yt-dlp' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force

foreach ($root in $RegistryRoots) {
    Remove-Item -Path (Join-Path $root $HostName) -Recurse -Force -ErrorAction SilentlyContinue
}

# Only delete a folder that really is ours, never an arbitrary path passed by mistake.
if ((Test-Path -LiteralPath (Join-Path $InstallDir 'mediadown-host.exe')) -or (Test-Path -LiteralPath (Join-Path $InstallDir "$HostName.json"))) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

Write-Host 'MediaDown companion removido.' -ForegroundColor Green
