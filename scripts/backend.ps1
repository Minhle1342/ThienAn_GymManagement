param([ValidateSet('run', 'test', 'build', 'seed', 'create-admin')][string]$Action = 'run')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$compilerBin = $env:THIEN_AN_LLVM_BIN
if (-not $compilerBin) {
    $compilerBin = Join-Path $env:TEMP 'thien-an-llvm/rust-tools/llvm-mingw-20261117-ucrt-x86_64/bin'
}
$originalPath = $env:PATH
$originalCC = $env:CC
$originalAR = $env:AR
$originalLinker = $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER
Push-Location (Join-Path $projectRoot 'backend')
try {
    $cargoArgs = @()
    if (Test-Path -LiteralPath (Join-Path $compilerBin 'clang.exe')) {
        $env:PATH = $compilerBin + ';' + $env:PATH
        $env:CC = 'clang'
        $env:AR = 'llvm-ar'
        $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER = 'clang'
        $cargoArgs += '+stable-x86_64-pc-windows-gnullvm'
    }
    if ($Action -eq 'seed') { $cargoArgs += @('run', '--', '--seed') }
    elseif ($Action -eq 'create-admin') { $cargoArgs += @('run', '--', '--create-admin') }
    else { $cargoArgs += $Action }
    & cargo @cargoArgs
    if ($LASTEXITCODE -ne 0) { throw "cargo failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
    $env:PATH = $originalPath
    $env:CC = $originalCC
    $env:AR = $originalAR
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER = $originalLinker
}
