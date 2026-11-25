# Installs Forchetta on Windows, with no WSL. In PowerShell:
#
#   irm https://forchetta.dev/install.ps1 | iex
#
# It needs no administrator: Forchetta goes in %USERPROFILE%\.local\lib\forchetta, its command in %USERPROFILE%\.local\bin, its
# data in %USERPROFILE%\.local\share\forchetta. Without Node.js 22 or later, or with one that its next update
# would move, one from nodejs.org goes in %USERPROFILE%\.local\lib\forchetta-node, only for Forchetta. Run it again to update.
# Nothing here asks Windows to trust a program of ours: what runs is Node.js.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  Set-StrictMode -Version 2

  # In the copy that a release has, its version and the sha256 of its archive (scripts/package-windows.sh). Empty here.
  $PinnedVersion = ''
  $PinnedSha256 = ''

  $Repo = 'alessiodonato/forchetta'
  $GitHub = "https://github.com/$Repo/releases"
  function Or($value, $default) { if ($value) { $value } else { $default } }
  $Releases = Or $env:FORCHETTA_RELEASES $GitHub
  $NodeDist = Or $env:FORCHETTA_NODE_DIST 'https://nodejs.org/dist/latest-v22.x'
  # %USERPROFILE%, as Node.js reads it.
  $UserHome = $env:USERPROFILE
  $Lib = Join-Path $UserHome '.local\lib'
  # The versions, each in a folder of its own: the one in use may have files that Windows does not let go. `forchetta` is
  # a junction to the one that counts.
  $Versions = Join-Path $Lib 'forchetta-versions'
  $Link = Join-Path $Lib 'forchetta'
  $NodeLib = Join-Path $Lib 'forchetta-node'
  $Bin = Join-Path $UserHome '.local\bin'
  $System32 = Join-Path $env:SystemRoot 'System32'
  $Tar = Join-Path $System32 'tar.exe'

  function Say($text) { Write-Host $text }
  function Stop-Here($text, $hint) {
    $message = "forchetta: $text"
    if ($hint) { $message += "`n  $hint" }
    throw $message
  }

  # A file of the web over https; a path, in the tests.
  function Get-File($from, $to) {
    if ($from -match '^https://') { Invoke-WebRequest -Uri $from -OutFile $to -UseBasicParsing -MaximumRedirection 5 }
    elseif ($from -notmatch '^[a-z]+://') { Copy-Item -LiteralPath $from -Destination $to }
    else { Stop-Here "$from is not https" }
  }

  # The file is the one of this checksum; what is not a checksum is of no file.
  function Test-Intact($file, $want) {
    if ($want -cnotmatch '^[0-9a-f]{64}$') { return $false }
    (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $want
  }

  # The output of a program, or nothing when it fails or is not there.
  function Read-Program($file, [string[]]$arguments) {
    try {
      $out = & $file @arguments 2>$null
      if ($LASTEXITCODE -eq 0) { return ("$out").Trim() }
    } catch { }
    return ''
  }
  function Test-Recent($version) { ($version -match '^(\d+)\.') -and ([int]$Matches[1] -ge 22) }
  # Not in a folder of its version, as winget, nvm, fnm and Volta keep it: an update takes that folder away, and the hooks, which
  # name it, would stop. What counts is the program that runs, not the one that starts it (src/shared/config.ts has the same rule).
  function Test-Lasting($node) {
    $path = Read-Program $node @('-p', 'process.execPath')
    if (-not $path) { return $false }
    $folder = [IO.Path]::GetDirectoryName($path) + '\'
    ($folder -notmatch '\d+\.\d+\.\d+') -and ($folder -notmatch '[\\/]fnm_multishells[\\/]')
  }

  function Expand-Tar($file, $to) {
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    & $Tar -xf $file -C $to --strip-components 1
    if ($LASTEXITCODE -ne 0) { Stop-Here 'the download could not be opened: nothing was installed' }
  }

  # A junction, which needs no administrator: taken away without touching what it leads to.
  function Set-Junction($at, $to) {
    if (Test-Path -LiteralPath $at) {
      $item = Get-Item -LiteralPath $at -Force
      if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Stop-Here "$at is not of this installer: it was left as it is" 'move it away, then run this again' }
      [IO.Directory]::Delete($at)
    }
    New-Item -ItemType Junction -Path $at -Value $to | Out-Null
  }

  function Install-Node($work, $arch) {
    $ownNode = Join-Path $NodeLib 'node.exe'
    $own = if (Test-Path -LiteralPath $ownNode) { Read-Program $ownNode @('-p', 'process.versions.node') } else { '' }
    # The Node.js of this PC when its next update takes it away: better than none, if nodejs.org does not answer.
    $moves = ''
    $stays = 'nodejs.org does not answer: the hooks run on the Node.js of this PC. After an update of it, run this again.'
    if (-not $own -and -not $env:FORCHETTA_NODE_ALWAYS) {
      $system = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($system -and (Test-Recent (Read-Program $system.Source @('-p', 'process.versions.node')))) {
        if (Test-Lasting $system.Source) { return $system.Source }
        $moves = $system.Source
        Say 'The Node.js of this PC is in a folder that its next update takes away: Forchetta gets one of its own.'
      }
    }
    $sums = Join-Path $work 'SHASUMS256.txt'
    try { Get-File "$NodeDist/SHASUMS256.txt" $sums } catch {
      if ($moves) {
        Say $stays
        return $moves
      }
      if (-not (Test-Recent $own)) { Stop-Here 'Node.js could not be downloaded' 'install Node.js 22 or later from https://nodejs.org, then run this again' }
      Say "nodejs.org does not answer: the Node.js of Forchetta stays at $own."
      return $ownNode
    }
    $line = Get-Content -LiteralPath $sums | Where-Object { $_ -cmatch "^([0-9a-f]{64})  (node-v([0-9.]+)-win-$arch\.zip)$" } | Select-Object -First 1
    if (-not $line -or $line -cnotmatch "^([0-9a-f]{64})  (node-v([0-9.]+)-win-$arch\.zip)$") { Stop-Here "nodejs.org has no Node.js for win-$arch" }
    $want = $Matches[1]; $file = $Matches[2]; $version = $Matches[3]
    if ($version -eq $own) { return $ownNode }
    Say 'Downloading a Node.js for Forchetta alone...'
    $zip = Join-Path $work 'node.zip'
    try { Get-File "$NodeDist/$file" $zip } catch {
      if (-not $moves) { throw }
      Say $stays
      return $moves
    }
    if (-not (Test-Intact $zip $want)) { Stop-Here 'the download of Node.js is not the one nodejs.org lists: nothing was installed' }
    $new = "$NodeLib.new"
    if (Test-Path -LiteralPath $new) { Remove-Item -LiteralPath $new -Recurse -Force }
    Expand-Tar $zip $new
    if (-not (Test-Recent (Read-Program (Join-Path $new 'node.exe') @('-p', 'process.versions.node')))) { Stop-Here 'the Node.js of nodejs.org does not run on this Windows: nothing was installed' }
    if (Test-Path -LiteralPath $NodeLib) {
      # The one in use by a daemon or a session does not move: it stays until the next time.
      $old = "$NodeLib.old-$PID"
      try { Move-Item -LiteralPath $NodeLib -Destination $old } catch {
        Remove-Item -LiteralPath $new -Recurse -Force
        Say "The Node.js of Forchetta is in use: it stays at $own."
        return $ownNode
      }
      Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    }
    Move-Item -LiteralPath $new -Destination $NodeLib
    return $ownNode
  }

  # The archive comes from the workflow of Forchetta on GitHub, for the tag of this version: its attestation says so
  # (SECURITY.md). Only with the GitHub CLI signed in; without, the checksum is what counts. Not for the archives of a test.
  function Test-Attested($file, $version) {
    if ($Releases -ne $GitHub) { return $true }
    $gh = Get-Command gh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gh) { return $true }
    if (-not (Read-Program $gh.Source @('auth', 'token', '--hostname', 'github.com'))) {
      Say 'Only the checksum is checked, not the attestation of GitHub: the GitHub CLI is not signed in.'
      return $true
    }
    & $gh.Source attestation verify $file --hostname github.com --repo $Repo --signer-workflow "$Repo/.github/workflows/linux-release.yml" --source-ref "refs/tags/v$version" --deny-self-hosted-runners | Out-Null
    if ($LASTEXITCODE -ne 0) { return $false }
    Say 'GitHub made it from the source of Forchetta: checked.'
    return $true
  }

  # ~\.local\bin in the PATH of this user, where the installer of Claude Code puts its own. What is there is kept as it is written.
  function Add-ToPath($dir) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $there = $value -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') }
      if ($there -notcontains $dir) {
        $key.SetValue('Path', (@($value.TrimEnd(';'), $dir) | Where-Object { $_ }) -join ';', [Microsoft.Win32.RegistryValueKind]::ExpandString)
        # Told to the programs that are open: a variable that is not there, taken away.
        [Environment]::SetEnvironmentVariable('FORCHETTA_PATH_CHANGED', $null, 'User')
      }
    } finally { $key.Dispose() }
    if (($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $dir) { $env:Path = "$env:Path;$dir" }
  }

  function Write-Commands {
    New-Item -ItemType Directory -Force -Path $Bin | Out-Null
    $ascii = New-Object Text.ASCIIEncoding
    foreach ($name in 'forchetta', 'forchetta-statusline') {
      [IO.File]::WriteAllText((Join-Path $Bin "$name.cmd"), "@echo off`r`n""%~dp0..\lib\forchetta\bin\$name.cmd"" %*`r`n", $ascii)
    }
    # For Git Bash, which does not look for .cmd by itself.
    [IO.File]::WriteAllText((Join-Path $Bin 'forchetta'), "#!/bin/sh`nexec ""`$(dirname ""`$0"")/forchetta.cmd"" ""`$@""`n", $ascii)
  }

  function Write-Shortcut {
    try {
      $menu = [Environment]::GetFolderPath('Programs')
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut((Join-Path $menu 'Forchetta.lnk'))
      $shortcut.TargetPath = Join-Path $Bin 'forchetta.cmd'
      $shortcut.Arguments = 'open'
      $shortcut.WorkingDirectory = $UserHome
      $shortcut.Description = 'The window of Forchetta'
      # Minimized: the window of Forchetta is the one of Edge or Chrome.
      $shortcut.WindowStyle = 7
      $shortcut.Save()
    } catch { Say 'No shortcut in the Start menu: open Forchetta with "forchetta open".' }
  }

  function Install-Forchetta {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Stop-Here 'this is for Windows' 'for Linux see https://github.com/alessiodonato/forchetta#install' }
    if ([Environment]::OSVersion.Version.Build -lt 17763) { Stop-Here 'Forchetta needs Windows 10 1809 or later' }
    if (-not (Test-Path -LiteralPath $Tar)) { Stop-Here "$Tar is missing" }
    $arch = switch ("$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)") {
      'X64' { 'x64' }
      'Arm64' { 'arm64' }
      default { Stop-Here "Forchetta has no terminals for $_ yet" }
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $work = Join-Path ([IO.Path]::GetTempPath()) "forchetta-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
      $version = Or $env:FORCHETTA_VERSION $PinnedVersion
      if (-not $version) {
        # The address of the last release ends with its version.
        $request = [Net.WebRequest]::Create("$Releases/latest")
        $request.Method = 'HEAD'
        $request.UserAgent = 'forchetta'
        $response = $request.GetResponse()
        $version = ($response.ResponseUri.AbsoluteUri -split '/v')[-1]
        $response.Close()
      }
      if ($version -cnotmatch '^\d+\.\d+\.\d+(-beta\.\d+)?$') { Stop-Here 'the last version of Forchetta was not found' "see $Releases" }
      Say "Forchetta $version, for Windows $arch..."
      $name = "forchetta-$version-windows.tar.gz"
      $archive = Join-Path $work 'forchetta.tar.gz'
      try { Get-File "$Releases/download/v$version/$name" $archive } catch { Stop-Here "Forchetta $version for Windows could not be downloaded" "see $Releases" }
      if ($PinnedSha256 -and $version -ceq $PinnedVersion) { $want = $PinnedSha256 }
      else {
        $sum = Join-Path $work 'forchetta.sha256'
        Get-File "$Releases/download/v$version/$name.sha256" $sum
        $want = ((Get-Content -LiteralPath $sum -TotalCount 1) -split ' ')[0]
      }
      if (-not (Test-Intact $archive $want)) { Stop-Here 'the download is not the one of the release: nothing was installed' }
      if (-not (Test-Attested $archive $version)) { Stop-Here "GitHub did not confirm that it made this archive from the source of Forchetta ${version}: nothing was installed" }

      $node = Install-Node $work $arch
      New-Item -ItemType Directory -Force -Path $Versions | Out-Null
      # A folder never used before: another with this version may be running.
      $folder = Join-Path $Versions "$version-$($want.Substring(0, 8))"
      if (-not (Test-Path -LiteralPath (Join-Path $folder 'dist\cli.js'))) {
        $new = "$folder.new-$PID"
        Expand-Tar $archive $new
        if (-not (Test-Path -LiteralPath (Join-Path $new "node_modules\node-pty\prebuilds\win32-$arch\conpty.node"))) { Stop-Here "Forchetta $version has no terminals for $arch" "see $Releases" }
        if ((Read-Program $node @((Join-Path $new 'dist\cli.js'), '--version')) -ne $version) { Stop-Here "Forchetta $version does not start on this Windows: nothing was installed" }
        if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -Force }
        Move-Item -LiteralPath $new -Destination $folder
      }
      Set-Junction $Link $folder
      Write-Commands
      Add-ToPath $Bin
      if (-not $env:FORCHETTA_NO_SHORTCUT) { Write-Shortcut }
      # The versions before this one, unless a session still runs on them.
      Get-ChildItem -LiteralPath $Versions -Directory | Where-Object { $_.FullName -ne $folder } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
      Say "Installed in $Link"
    } finally {
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
      Get-ChildItem -Path $Versions -Directory -Filter "*.new-$PID" -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if ($env:FORCHETTA_NO_SETUP) { return }
    # The setup shows what it adds to the settings of Claude Code, and asks.
    & (Join-Path $Bin 'forchetta.cmd') setup
  }

  try { Install-Forchetta } catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    # From a script (-File), say it failed; typed in a terminal, leave it open.
    if ($env:FORCHETTA_EXIT) { exit 1 }
  }
}
