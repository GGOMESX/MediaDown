<#
.SYNOPSIS
  Installs the MediaDown companion for the current Windows user (no admin rights needed).

.DESCRIPTION
  1. Copies mediadown-host.exe to %LOCALAPPDATA%\MediaDown
  2. Downloads yt-dlp and ffmpeg at the versions pinned in engines.json and verifies SHA-256
  3. Registers the native messaging host for Chrome, Edge and Brave (HKCU only)
#>
[CmdletBinding()]
param(
    [string]$SourceDir = $PSScriptRoot,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'MediaDown'),
    [string]$ExtensionId = 'jakijlbgipgbbaldfhhpglollgnldckh',
    [switch]$SkipEngines
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest ~10x slower on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$HostName = 'com.mediadown.host'
$RegistryRoots = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Assert-Hash([string]$Path, [string]$Expected) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw "Checksum inválido para $(Split-Path $Path -Leaf): esperado $Expected, obtido $actual. Download corrompido ou adulterado."
    }
}

function Test-Hash([string]$Path, [string]$Expected) {
    (Test-Path -LiteralPath $Path) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -eq $Expected.ToLowerInvariant())
}

function Save-Verified([string]$Url, [string]$Sha256, [string]$Destination) {
    $temp = "$Destination.download"
    Invoke-WebRequest -Uri $Url -OutFile $temp -UseBasicParsing
    Assert-Hash $temp $Sha256
    Move-Item -LiteralPath $temp -Destination $Destination -Force
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    # Set-Content -Encoding UTF8 on PS 5.1 writes a BOM, which Chrome rejects in host manifests.
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Install-Engines([string]$BinDir, $Lock) {
    $ytDlp = Join-Path $BinDir 'yt-dlp.exe'
    if (Test-Hash $ytDlp $Lock.ytDlp.sha256) {
        Write-Step "yt-dlp $($Lock.ytDlp.version) já instalado"
    } else {
        Write-Step "Baixando yt-dlp $($Lock.ytDlp.version)"
        Save-Verified $Lock.ytDlp.url $Lock.ytDlp.sha256 $ytDlp
    }

    $ffmpegFiles = $Lock.ffmpeg.files.PSObject.Properties
    $ffmpegReady = @($ffmpegFiles | Where-Object { -not (Test-Hash (Join-Path $BinDir (Split-Path $_.Name -Leaf)) $_.Value) }).Count -eq 0
    if ($ffmpegReady) {
        Write-Step "ffmpeg $($Lock.ffmpeg.version) já instalado"
        return
    }

    Write-Step "Baixando ffmpeg $($Lock.ffmpeg.version) (~100 MB)"
    $workDir = Join-Path ([IO.Path]::GetTempPath()) ("mediadown-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $workDir | Out-Null
    try {
        $archive = Join-Path $workDir 'ffmpeg.zip'
        Save-Verified $Lock.ffmpeg.url $Lock.ffmpeg.sha256 $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $workDir -Force
        foreach ($file in $ffmpegFiles) {
            $source = Join-Path (Join-Path $workDir $Lock.ffmpeg.archiveRoot) $file.Name
            Assert-Hash $source $file.Value
            Copy-Item -LiteralPath $source -Destination (Join-Path $BinDir (Split-Path $file.Name -Leaf)) -Force
        }
        Copy-Item -LiteralPath (Join-Path (Join-Path $workDir $Lock.ffmpeg.archiveRoot) 'LICENSE') -Destination (Join-Path $BinDir 'FFMPEG-LICENSE.txt') -Force
    } finally {
        Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Register-NativeHost([string]$ManifestPath) {
    foreach ($root in $RegistryRoots) {
        $key = Join-Path $root $HostName
        New-Item -Path $key -Force | Out-Null
        Set-ItemProperty -Path $key -Name '(default)' -Value $ManifestPath
    }
}

if ($ExtensionId -notmatch '^[a-p]{32}$') { throw "ID de extensão inválido: $ExtensionId" }
$hostSource = Join-Path $SourceDir 'mediadown-host.exe'
if (-not (Test-Path -LiteralPath $hostSource)) { throw "mediadown-host.exe não encontrado em $SourceDir" }
$lock = Get-Content -Raw -LiteralPath (Join-Path $SourceDir 'engines.json') | ConvertFrom-Json

Write-Step "Instalando em $InstallDir"
Get-Process -Name 'mediadown-host' -ErrorAction SilentlyContinue | Stop-Process -Force
$binDir = Join-Path $InstallDir 'bin'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
$hostPath = Join-Path $InstallDir 'mediadown-host.exe'
Copy-Item -LiteralPath $hostSource -Destination $hostPath -Force

if ($SkipEngines) { Write-Step 'Pulando download dos motores (-SkipEngines)' } else { Install-Engines $binDir $lock }

Write-Step 'Registrando no Chrome, Edge e Brave'
$manifestPath = Join-Path $InstallDir "$HostName.json"
$manifest = [ordered]@{
    name            = $HostName
    description     = 'MediaDown companion: downloads HLS/DASH media locally with yt-dlp and ffmpeg'
    path            = $hostPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
Write-Utf8NoBom $manifestPath ($manifest | ConvertTo-Json -Depth 3)
Register-NativeHost $manifestPath

Write-Host ''
Write-Host 'MediaDown companion instalado.' -ForegroundColor Green
Write-Host "Extensão autorizada: $ExtensionId"
Write-Host 'Recarregue a extensão em chrome://extensions para ela detectar o app.'
