# SubagentStop hook: stops the servers a background agent left running in its
# own worktree (.claude/worktrees/agent-<agent_id>). A forgotten server keeps a
# port busy and locks the worktree folder on Windows.
#
# Only processes whose command line contains both that worktree path and one
# of the `servers` patterns of the project profile are stopped: an agent can
# stop while its own tests or a long job still run, and those must survive.
# Patterns are plain substrings, compared case-insensitively with "\" as the
# path separator. Every run is logged in the plugin's data folder.

$dataDir = $env:CLAUDE_PLUGIN_DATA
if (-not $dataDir) { $dataDir = $PSScriptRoot }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$log = Join-Path $dataDir 'stop-agent-servers.log'

function Write-Log([string]$message) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format s), $message)
}

try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
  Write-Log "unreadable payload"
  exit 0
}

$agentId = $payload.agent_id
if (-not $agentId) {
  Write-Log "no agent_id"
  exit 0
}

$projectDir = $env:CLAUDE_PROJECT_DIR
if (-not $projectDir) { $projectDir = $payload.cwd }
$profilePath = Join-Path $projectDir '.claude\orchestration\profile.json'
if (-not (Test-Path $profilePath)) {
  Write-Log "agent $agentId : no profile at $profilePath"
  exit 0
}

try {
  $patterns = @((Get-Content -Raw -Encoding UTF8 $profilePath | ConvertFrom-Json).servers) | Where-Object { $_ }
} catch {
  Write-Log "agent $agentId : unreadable profile $profilePath"
  exit 0
}
if (-not $patterns) {
  Write-Log "agent $agentId : no servers pattern in the profile"
  exit 0
}
$patterns = $patterns | ForEach-Object { $_.Replace('/', '\').ToLowerInvariant() }

$marker = "\worktrees\agent-$agentId\".ToLowerInvariant()
# Shells are never taken for a server: their command line can mention the
# worktree (this hook's caller, an agent's Bash) without serving anything.
$shells = @('bash.exe', 'sh.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe')
$targets = Get-CimInstance Win32_Process | Where-Object {
  $line = $_.CommandLine
  if (-not $line -or $shells -contains $_.Name.ToLowerInvariant()) { return $false }
  $line = $line.Replace('/', '\').ToLowerInvariant()
  if (-not $line.Contains($marker)) { return $false }
  foreach ($p in $patterns) { if ($line.Contains($p)) { return $true } }
  return $false
}

if (-not $targets) {
  Write-Log "agent $agentId : nothing to stop"
  exit 0
}

foreach ($p in $targets) {
  & taskkill.exe /PID $p.ProcessId /T /F | Out-Null
  Write-Log ("agent {0} : stopped PID {1} {2}" -f $agentId, $p.ProcessId, $p.CommandLine)
}
exit 0
