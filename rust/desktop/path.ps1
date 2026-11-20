# Adds or removes Argon's bin folder from the current user's PATH.
# Usage: path.ps1 add|remove <folder>
param([string]$Action, [string]$Dir)
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $current) { $current = '' }
$parts = $current -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ne $Dir.TrimEnd('\') }
if ($Action -eq 'add') { $parts += $Dir }
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
