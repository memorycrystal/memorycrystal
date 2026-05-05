$ErrorActionPreference = 'Stop'

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
  Write-Host "OpenClaw not installed. Get it at https://openclaw.ai"
  exit 1
}

$pluginUrl = if ($env:CRYSTAL_PLUGIN_URL) {
  $env:CRYSTAL_PLUGIN_URL
} else {
  "https://github.com/illumin8ca/memorycrystal/releases/latest/download/crystal-memory-plugin.tar.gz"
}

$tmp = New-Item -ItemType Directory -Path ([System.IO.Path]::GetTempPath()) -Name ([System.Guid]::NewGuid().ToString())
$tarPath = Join-Path $tmp.FullName "plugin.tar.gz"

Invoke-WebRequest -Uri $pluginUrl -OutFile $tarPath

tar -xzf $tarPath -C $tmp.FullName
openclaw plugins install (Join-Path $tmp.FullName "crystal-memory")

$apiKey = Read-Host "Enter your Memory Crystal API key"
openclaw config set plugins.entries.crystal-memory.config.apiKey $apiKey
openclaw config set plugins.entries.crystal-memory.enabled true
openclaw config set plugins.slots.memory crystal-memory
try { openclaw config unset plugins.slots.contextEngine | Out-Null } catch {}

Write-Host "✓ Memory Crystal installed. Your AI will now remember everything."
