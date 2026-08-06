$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempDirectory = [System.IO.Path]::GetFullPath(
  (Join-Path $tempBase ("helm-terminal-tests-" + [guid]::NewGuid().ToString("N")))
)
if (
  -not $tempDirectory.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -or
  -not ([System.IO.Path]::GetFileName($tempDirectory)).StartsWith("helm-terminal-tests-", [System.StringComparison]::Ordinal)
) {
  throw "临时测试目录越界：$tempDirectory"
}

try {
  New-Item -ItemType Directory -Path $tempDirectory | Out-Null
  $tsc = Join-Path $projectRoot "node_modules\.bin\tsc.cmd"
  & $tsc `
    --ignoreConfig `
    --target ES2022 `
    --module CommonJS `
    --moduleResolution Node `
    --ignoreDeprecations 6.0 `
    --esModuleInterop `
    --skipLibCheck `
    --noEmitOnError `
    --types node `
    --rootDir $projectRoot `
    --outDir $tempDirectory `
    (Join-Path $projectRoot "tests\terminalRegistry.test.ts") `
    (Join-Path $projectRoot "tests\terminalViewportFollow.test.ts")
  if ($LASTEXITCODE -ne 0) {
    throw "终端测试编译失败，退出码：$LASTEXITCODE"
  }

  & node --test `
    (Join-Path $tempDirectory "tests\terminalRegistry.test.js") `
    (Join-Path $tempDirectory "tests\terminalViewportFollow.test.js")
  if ($LASTEXITCODE -ne 0) {
    throw "终端测试失败，退出码：$LASTEXITCODE"
  }
} finally {
  if (Test-Path -LiteralPath $tempDirectory) {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force
  }
}
