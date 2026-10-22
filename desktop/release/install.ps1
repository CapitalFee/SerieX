<#
  Installs or updates SerieX (SerieX Books and SerieX Payroll) on Windows, for the current user.

    irm https://github.com/CapitalFee/SerieX/releases/latest/download/install.ps1 | iex

  Options when the script is saved and run as a file:
    -Uninstall        remove SerieX (your company files are kept)
    -Version <tag>    install a specific release, for example v2026.10.3
  When piped into iex, use environment variables instead:
    $env:SERIEX_UNINSTALL = '1'      same as -Uninstall
    $env:SERIEX_VERSION = 'v2026.10.3'  same as -Version
    $env:SERIEX_NO_LAUNCH = '1'      do not start SerieX when the installation is done

  Works with Windows PowerShell 5.1 and PowerShell 7. Needs no administrator rights.
  Your company files are kept in %APPDATA%\SerieX and are never touched.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$Version
)

function Invoke-SerieXSetup {
    param([bool]$Uninstall, [string]$Version)

    Set-StrictMode -Version 2.0
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads very slow in PowerShell 5.1

    $repoUrl = 'https://github.com/CapitalFee/SerieX'
    $installerName = 'SerieX-Setup-x64.exe'
    $dataDir = Join-Path $env:APPDATA 'SerieX'
    $defaultInstallDir = Join-Path $env:LOCALAPPDATA 'Programs\SerieX'

    function Say([string]$text) { Write-Host $text }

    # The registry entry Windows uses for "Apps and features" (current user first).
    function Get-SerieXEntry {
        $roots = @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
        )
        foreach ($root in $roots) {
            if (-not (Test-Path $root)) { continue }
            foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
                $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
                if ($p -and ($p.PSObject.Properties.Name -contains 'DisplayName') -and $p.DisplayName -eq 'SerieX' -and
                    ($p.PSObject.Properties.Name -contains 'UninstallString')) {
                    return [pscustomobject]@{ Root = $root; UninstallString = [string]$p.UninstallString }
                }
            }
        }
        return $null
    }

    # Folder of the installed SerieX, from its uninstaller path ("C:\...\SerieX\Uninstall SerieX.exe" /currentuser).
    function Get-SerieXFolder($entry) {
        if ($entry -and $entry.UninstallString -match '^\s*"([^"]+)"') {
            return Split-Path -Parent $Matches[1]
        }
        return $defaultInstallDir
    }

    # Closes SerieX the normal way (it saves its settings and stops its servers); after 15 seconds
    # whatever is still running is stopped.
    function Close-SerieX([string]$folder) {
        $procs = @(Get-Process -Name 'SerieX' -ErrorAction SilentlyContinue)
        if ($procs.Count -gt 0) {
            Say 'SerieX is open. Closing it...'
            foreach ($p in $procs) { try { [void]$p.CloseMainWindow() } catch { } }
            $deadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $deadline -and @(Get-Process -Name 'SerieX' -ErrorAction SilentlyContinue).Count -gt 0) {
                Start-Sleep -Milliseconds 500
            }
            $left = @(Get-Process -Name 'SerieX' -ErrorAction SilentlyContinue)
            if ($left.Count -gt 0) {
                Say 'SerieX did not close in 15 seconds; stopping it.'
                $left | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
        }
        # The two SerieX servers stop with the app; stop any that were left running from its folder.
        foreach ($name in 'seriex-books', 'seriex-payroll') {
            foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
                $path = $null
                try { $path = $p.Path } catch { }
                if ($path -and $folder -and $path.StartsWith($folder, [StringComparison]::OrdinalIgnoreCase)) {
                    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'SerieX needs a 64-bit version of Windows.'
    }

    if ($Uninstall) {
        $entry = Get-SerieXEntry
        $folder = Get-SerieXFolder $entry
        if (-not $entry) {
            Say 'SerieX is not installed.'
        } else {
            if ($entry.UninstallString -notmatch '^\s*"([^"]+)"\s*(.*)$') { throw "Unexpected uninstall command: $($entry.UninstallString)" }
            $uninstaller = $Matches[1]
            $uninstallArgs = @($Matches[2] -split '\s+' | Where-Object { $_ }) + '/S'
            if (-not (Test-Path $uninstaller)) { throw "The SerieX uninstaller is missing: $uninstaller" }
            Close-SerieX $folder
            Say 'Removing SerieX...'
            $proc = Start-Process -FilePath $uninstaller -ArgumentList $uninstallArgs -Wait -PassThru
            if ($proc.ExitCode -ne 0) { throw "The SerieX uninstaller stopped with exit code $($proc.ExitCode)." }
            # The uninstaller hands the work to a copy of itself; wait for it to finish.
            $appExe = Join-Path $folder 'SerieX.exe'
            $deadline = (Get-Date).AddSeconds(120)
            while ((Get-Date) -lt $deadline -and (Test-Path $appExe)) { Start-Sleep -Milliseconds 500 }
            if (Test-Path $appExe) { throw "SerieX is still in $folder. Remove it from Settings > Apps." }
            Say 'SerieX was removed.'
        }
        Say 'Your company files were not touched. They are kept in:'
        Say "  $dataDir"
        Say 'Delete that folder only if you no longer need your SerieX company files.'
        return
    }

    if ($Version) {
        if ($Version -match '^\d') { $Version = "v$Version" } # 2026.10.3 means the release v2026.10.3
        $base = "$repoUrl/releases/download/$Version"
    } else {
        $base = "$repoUrl/releases/latest/download"
    }

    $work = Join-Path ([IO.Path]::GetTempPath()) ('seriex-setup-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $exe = Join-Path $work $installerName
        $sums = Join-Path $work 'SHA256SUMS'
        $label = if ($Version) { " $Version" } else { '' }
        Say "Downloading SerieX$label..."
        try {
            Invoke-WebRequest -Uri "$base/$installerName" -OutFile $exe -UseBasicParsing
            Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
        } catch {
            throw "Could not download SerieX from $base ($($_.Exception.Message))"
        }

        Say 'Checking the download...'
        $expected = $null
        foreach ($line in Get-Content -LiteralPath $sums) {
            if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $installerName) {
                $expected = $Matches[1].ToLowerInvariant()
                break
            }
        }
        if (-not $expected) { throw "SHA256SUMS does not list $installerName." }
        $actual = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw 'The download is damaged (its SHA-256 checksum does not match). Please try again.' }
        Unblock-File -LiteralPath $exe -ErrorAction SilentlyContinue

        $entry = Get-SerieXEntry
        Close-SerieX (Get-SerieXFolder $entry)
        if ($entry -and $entry.Root -like 'HKLM:*') {
            Say 'Note: SerieX is also installed for all users of this computer; this installs a copy for you only.'
        }

        Say 'Installing SerieX...'
        $proc = Start-Process -FilePath $exe -ArgumentList '/S', '/currentuser' -Wait -PassThru
        if ($proc.ExitCode -ne 0) { throw "The SerieX installer stopped with exit code $($proc.ExitCode)." }

        $entry = Get-SerieXEntry
        $folder = Get-SerieXFolder $entry
        $appExe = Join-Path $folder 'SerieX.exe'
        if (-not (Test-Path $appExe)) { throw "SerieX.exe was not found in $folder after the installation." }
        $installed = (Get-Item -LiteralPath $appExe).VersionInfo.ProductVersion
        Say "SerieX $installed is installed in $folder"
        Say "Your company files are kept in: $dataDir"

        if ($env:SERIEX_NO_LAUNCH -ne '1') {
            Say 'Starting SerieX...'
            Start-Process -FilePath $appExe -WorkingDirectory $folder
        }
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Piped into iex there are no parameters: read them from the environment.
$serieXUninstall = [bool]$Uninstall
if (-not $serieXUninstall -and $env:SERIEX_UNINSTALL -and @('1', 'true', 'yes') -contains $env:SERIEX_UNINSTALL.ToLowerInvariant()) {
    $serieXUninstall = $true
}
$serieXVersion = $Version
if (-not $serieXVersion -and $env:SERIEX_VERSION) { $serieXVersion = $env:SERIEX_VERSION.Trim() }

try {
    Invoke-SerieXSetup -Uninstall $serieXUninstall -Version $serieXVersion
} catch {
    Write-Host "SerieX setup stopped: $($_.Exception.Message)" -ForegroundColor Red
    # "exit" would close the PowerShell window when the script runs through iex.
    if ($PSCommandPath) { exit 1 }
}
