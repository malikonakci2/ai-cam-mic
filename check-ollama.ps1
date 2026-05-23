$ErrorActionPreference = "Stop"

Write-Host "Checking Ollama models..."
$tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags"
$tags.models | Select-Object name, model, modified_at, size | Format-Table

if (-not ($tags.models | Where-Object { $_.name -like "moondream*" -or $_.model -like "moondream*" })) {
  Write-Warning "Moondream was not found. Run: ollama pull moondream"
}

Write-Host ""
Write-Host "Checking dashboard health..."
Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health"
