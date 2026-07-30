# Zero-dependency static file server for the MICRO GAUNTLET dev preview.
# No Node/Python on this machine, so we use .NET's HttpListener directly.
# Serves the repo root with aggressive no-cache headers so browser reloads
# always pick up freshly edited source.

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = if ($env:MG_PORT) { [int]$env:MG_PORT } else { 8791 }

$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon'
  '.wasm' = 'application/wasm'
  '.map'  = 'application/json; charset=utf-8'
  '.woff2'= 'font/woff2'
  '.bin'  = 'application/octet-stream'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

Write-Output "MICRO GAUNTLET dev server listening on http://localhost:$Port/"
Write-Output "Serving root: $Root"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath)

      # Capture sink: the page POSTs a PNG data URL here and we write it to
      # shots/. This is how screenshots get to disk for review agents without
      # depending on the browser pane compositing frames.
      if ($rel -eq '/__shot') {
        $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
        $payload = $reader.ReadToEnd()
        $reader.Close()
        $name = $req.QueryString['name']
        if (-not $name) { $name = 'shot' }
        $name = ($name -replace '[^A-Za-z0-9_\-\.]', '_')
        $b64 = $payload
        $comma = $payload.IndexOf(',')
        if ($payload.StartsWith('data:') -and $comma -gt 0) { $b64 = $payload.Substring($comma + 1) }
        $shotDir = Join-Path $Root 'shots'
        if (-not (Test-Path $shotDir)) { New-Item -ItemType Directory -Force -Path $shotDir | Out-Null }
        $outPath = Join-Path $shotDir "$name.png"
        [IO.File]::WriteAllBytes($outPath, [Convert]::FromBase64String($b64))
        $res.StatusCode = 200
        $res.ContentType = 'application/json; charset=utf-8'
        $ok = [Text.Encoding]::UTF8.GetBytes('{"ok":true,"path":"shots/' + $name + '.png"}')
        $res.OutputStream.Write($ok, 0, $ok.Length)
        Write-Output ("SHOT shots/$name.png (" + [Math]::Round($b64.Length / 1365.0) + " KB)")
        $res.Close()
        continue
      }

      if ($rel -eq '/' -or $rel -eq '') { $rel = '/index.html' }
      $rel = $rel.TrimStart('/') -replace '/', '\'

      # Contain every request inside the served root.
      $full = [IO.Path]::GetFullPath((Join-Path $Root $rel))
      $rootFull = [IO.Path]::GetFullPath($Root)
      if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403
        $body = [Text.Encoding]::UTF8.GetBytes('403 Forbidden')
        $res.OutputStream.Write($body, 0, $body.Length)
        $res.Close()
        continue
      }

      if (Test-Path -LiteralPath $full -PathType Leaf) {
        $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
        $ct = $Mime[$ext]
        if (-not $ct) { $ct = 'application/octet-stream' }
        $bytes = [IO.File]::ReadAllBytes($full)
        $res.ContentType = $ct
        $res.StatusCode = 200
        $res.Headers.Add('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        $res.Headers.Add('Pragma', 'no-cache')
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        Write-Output ("200 " + $req.Url.AbsolutePath)
      } else {
        $res.StatusCode = 404
        $res.ContentType = 'text/plain; charset=utf-8'
        $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
        $res.OutputStream.Write($body, 0, $body.Length)
        Write-Output ("404 " + $req.Url.AbsolutePath)
      }
    } catch {
      try {
        $res.StatusCode = 500
        $body = [Text.Encoding]::UTF8.GetBytes("500 " + $_.Exception.Message)
        $res.OutputStream.Write($body, 0, $body.Length)
      } catch {}
      Write-Output ("500 " + $req.Url.AbsolutePath + " :: " + $_.Exception.Message)
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
