$ErrorActionPreference = "Stop"

$bundledNode = "C:\Users\PC\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (Test-Path $bundledNode) {
  & $bundledNode server.js
} else {
  node server.js
}
