# serve.ps1 — Quick HTTP server for Chess Coach Mobile
# Serves the app at http://localhost:8080/game.html

$port = 8080
$dir  = $PSScriptRoot

Write-Host ""
Write-Host "  Chess Coach Mobile — Local Server" -ForegroundColor Cyan
Write-Host "  ===================================" -ForegroundColor Cyan
Write-Host "  Serving: $dir" -ForegroundColor Gray
Write-Host "  URL: http://localhost:$port/game.html" -ForegroundColor Green
Write-Host ""
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

# Try Node.js http-server first
$nodeExists = Get-Command node -ErrorAction SilentlyContinue
if ($nodeExists) {
    $serveExists = Get-Command npx -ErrorAction SilentlyContinue
    if ($serveExists) {
        Write-Host "  Starting via npx serve..." -ForegroundColor Yellow
        Set-Location $dir
        npx -y serve -p $port -s .
        exit
    }
}

# Try Python 3
$py3 = Get-Command python -ErrorAction SilentlyContinue
if ($py3) {
    Write-Host "  Starting via Python 3..." -ForegroundColor Yellow
    Set-Location $dir
    python -m http.server $port
    exit
}

# Try Python 2
$py2 = Get-Command python2 -ErrorAction SilentlyContinue
if ($py2) {
    Write-Host "  Starting via Python 2..." -ForegroundColor Yellow
    Set-Location $dir
    python2 -m SimpleHTTPServer $port
    exit
}

# Fallback: PowerShell HTTP listener
Write-Host "  Starting via PowerShell HTTP listener..." -ForegroundColor Yellow

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:${port}/")
$listener.Start()

$mimeTypes = @{
    ".html"  = "text/html; charset=utf-8"
    ".js"    = "application/javascript"
    ".css"   = "text/css"
    ".png"   = "image/png"
    ".ico"   = "image/x-icon"
    ".json"  = "application/json"
    ".wasm"  = "application/wasm"
    ".mp3"   = "audio/mpeg"
    ".ogg"   = "audio/ogg"
    ".wav"   = "audio/wav"
    ".woff2" = "font/woff2"
    ".woff"  = "font/woff"
    ".ttf"   = "font/ttf"
    ".svg"   = "image/svg+xml"
    ".webmanifest" = "application/manifest+json"
    ".map"   = "application/json"
}

Write-Host "  Open: http://localhost:$port/game.html" -ForegroundColor Green

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    $localPath = $req.Url.LocalPath
    if ($localPath -eq "/") { $localPath = "/game.html" }
    $filePath = Join-Path $dir $localPath.TrimStart("/").Replace("/", "\")

    if (Test-Path $filePath -PathType Leaf) {
        $ext  = [System.IO.Path]::GetExtension($filePath)
        $mime = $mimeTypes[$ext]
        if (-not $mime) { $mime = "application/octet-stream" }

        $content = [System.IO.File]::ReadAllBytes($filePath)
        $res.ContentType   = $mime
        $res.ContentLength64 = $content.Length

        # WASM CORS headers for SharedArrayBuffer (needed for Stockfish threads)
        $res.Headers.Add("Cross-Origin-Opener-Policy", "same-origin")
        $res.Headers.Add("Cross-Origin-Embedder-Policy", "require-corp")
        $res.Headers.Add("Cache-Control", "no-cache")

        $res.OutputStream.Write($content, 0, $content.Length)
    } else {
        $res.StatusCode = 404
        $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $localPath")
        $res.OutputStream.Write($notFound, 0, $notFound.Length)
    }

    $res.OutputStream.Close()
}
