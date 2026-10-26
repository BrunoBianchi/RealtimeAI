# Downloads the hybrid RAG embedding model (multilingual-e5-small, ONNX int8,
# about 118 MB) to %LOCALAPPDATA%\RealTimeAI\models\multilingual-e5-small.
# Run once: scripts\windows\download-embeddings-model.bat
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dest = Join-Path $env:LOCALAPPDATA 'RealTimeAI\models\multilingual-e5-small'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$base = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main'
$files = @(
    @{ url = "$base/onnx/model_quantized.onnx"; out = 'model_quantized.onnx'; min = 50MB },
    @{ url = "$base/tokenizer.json";             out = 'tokenizer.json';       min = 1MB }
)
foreach ($f in $files) {
    $target = Join-Path $dest $f.out
    if ((Test-Path $target) -and ((Get-Item $target).Length -ge $f.min)) {
        Write-Host "OK (already here): $($f.out)"
        continue
    }
    Write-Host "Downloading $($f.out)..."
    $tmp = "$target.part"
    Invoke-WebRequest -Uri $f.url -OutFile $tmp -UseBasicParsing
    if ((Get-Item $tmp).Length -lt $f.min) { throw "Download of $($f.out) looks incomplete." }
    Move-Item -Force $tmp $target
}
Write-Host ""
Write-Host "Model ready in $dest"
Write-Host "Restart the overlay: the console shows 'Hybrid RAG: ready' when it loads."
