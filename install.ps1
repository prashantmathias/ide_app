param(
    [switch]$Force
)

Write-Host "Building and installing CodeCraft Go..." -ForegroundColor Cyan

$installDir = Join-Path $HOME "bin"
$binaryName = "codecraft.exe"
$target = Join-Path $installDir $binaryName

function Add-ToUserPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathToAdd
    )

    $normalizedPath = [System.IO.Path]::GetFullPath($PathToAdd).TrimEnd('\')
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathEntries = @()

    if (-not [string]::IsNullOrWhiteSpace($userPath)) {
        $pathEntries = $userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    $alreadyExists = $pathEntries | Where-Object {
        [System.IO.Path]::GetFullPath($_).TrimEnd('\') -ieq $normalizedPath
    }

    if (-not $alreadyExists) {
        $updatedPath = (@($pathEntries) + $normalizedPath) -join ';'
        [Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")
        Write-Host "Added $normalizedPath to your user PATH." -ForegroundColor Green
    } else {
        Write-Host "$normalizedPath is already on your user PATH." -ForegroundColor DarkGray
    }

    $processPathEntries = $env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $processPathExists = $processPathEntries | Where-Object {
        [System.IO.Path]::GetFullPath($_).TrimEnd('\') -ieq $normalizedPath
    }

    if (-not $processPathExists) {
        $env:Path = (@($processPathEntries) + $normalizedPath) -join ';'
    }
}

if ((Test-Path $target) -and -not $Force) {
    Write-Host "`n$target already exists. Re-run with -Force to overwrite it." -ForegroundColor Yellow
    exit 1
}

try {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    go build -o $target .
    if ($LASTEXITCODE -eq 0) {
        Add-ToUserPath -PathToAdd $installDir
        Write-Host "`nSuccessfully installed CodeCraft Go!" -ForegroundColor Green
        Write-Host "Binary: $target" -ForegroundColor Yellow
        Write-Host "Run: codecraft" -ForegroundColor Yellow
    } else {
        Write-Host "`nInstallation failed." -ForegroundColor Red
    }
} catch {
    Write-Host "`nError running go build. Make sure Go is installed." -ForegroundColor Red
}
