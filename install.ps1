param(
    [switch]$Force
)

Write-Host "Building and installing deno-tui-ide..." -ForegroundColor Cyan

# Use cargo install to build the release version and place it in ~/.cargo/bin
$cargoArgs = @("install", "--path", ".")
if ($Force) {
    $cargoArgs += "--force"
}

try {
    cargo @cargoArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`nSuccessfully installed deno-tui-ide!" -ForegroundColor Green
        Write-Host "You can now run it from anywhere using the command: deno-tui-ide" -ForegroundColor Yellow
    } else {
        Write-Host "`nInstallation failed." -ForegroundColor Red
    }
} catch {
    Write-Host "`nError running cargo. Make sure Rust is installed." -ForegroundColor Red
}
