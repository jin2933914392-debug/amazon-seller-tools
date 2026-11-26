# ================================================================
#  Amazon SP-API LWA Refresh Token 获取脚本
#  （Login with Amazon OAuth 2.0 for Seller API）
# ================================================================
#  用法:
#  1. 把下方 [CLIENT_ID] [CLIENT_SECRET] 替换成你 Seller Central 应用的值
#  2. PowerShell 跑:  powershell -ExecutionPolicy Bypass -File .\get-lwa-refresh-token.ps1
#  3. 浏览器自动弹出 Amazon 登录页 → 授权 → 脚本自动抓 refresh_token
# ================================================================

# ===== 1. 你的应用凭据（https://sellercentral.amazon.com → 应用管理）=====
$LWA_CLIENT_ID     = "amzn1.application-oa2-client.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$LWA_CLIENT_SECRET = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# ===== 2. 授权回调地址（必须和 Seller Central 应用里填的完全一致）=====
# 本地回环，脚本会在本地起一个临时 HTTP server 来抓回调
$REDIRECT_URI = "http://127.0.0.1:8765/callback"

# ===== 3. Scope =====
# SP-API Brand Analytics 需要的 scope
$SCOPE = "sellercentral:vendor-orders:readonly sellercentral:reports:readonly sellercentral:merchant-information:readonly"

# ===== 4. 临时起本地 HTTP server 抓 OAuth 回调 =====
Write-Host "`n==> 启动本地回调服务器 $REDIRECT_URI ..." -ForegroundColor Cyan
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("$REDIRECT_URI/")
$listener.Start()
Write-Host "    本地监听中，请在浏览器里完成 Amazon 登录授权 ..." -ForegroundColor Gray

# ===== 5. 打开浏览器跳 Amazon LWA 授权页面 =====
$authUrl = "https://www.amazon.com/ap/oa" +
  "?client_id=$LWA_CLIENT_ID" +
  "&scope=$SCOPE" +
  "&response_type=code" +
  "&redirect_uri=$REDIRECT_URI" +
  "&state=trae-spapi-$(Get-Random)"

Write-Host "`n==> 打开 Amazon LWA 授权页面 ..." -ForegroundColor Cyan
Start-Process $authUrl

# ===== 6. 等待回调 =====
Write-Host "    等待授权回调（60s 超时）..." -ForegroundColor Gray
$code = $null
$state = $null
$timeout = (Get-Date).AddSeconds(60)

while ($listener.IsListening -and (Get-Date) -lt $timeout) {
  if ($listener.Pending()) {
    $ctx = $listener.GetContext()
    $reqPath = $ctx.Request.Url.AbsoluteUri
    Write-Host "    ✅ 收到回调: $reqPath" -ForegroundColor Green

    # 回浏览器一个 "授权成功，可以关闭了" 页面
    $respBody = "<html><body style='font-family:sans-serif;padding:40px;text-align:center;background:#4F6AF6;color:#fff'>" +
      "<h1 style='font-size:24px;margin-top:40px'>✅ 授权成功</h1>" +
      "<p style='font-size:14px;opacity:.85'>可以关闭这个页面了，Token 正在写入本地文件 ...</p>" +
      "</body></html>"
    $respBytes = [System.Text.Encoding]::UTF8.GetBytes($respBody)
    $ctx.Response.StatusCode = 200
    $ctx.Response.OutputStream.Write($respBytes, 0, $respBytes.Length)
    $ctx.Response.Close()

    # 从 URL query 里抠 code 和 state
    $qs = [System.Web.HttpUtility]::ParseQueryString($ctx.Request.Url.Query)
    $code = $qs['code']
    $state = $qs['state']

    $listener.Stop()
    break
  }
  Start-Sleep -Milliseconds 200
}

if (-not $code) {
  Write-Host "`n❌ 超时没收到回调，请确认浏览器里完成了 Amazon 登录 + 授权" -ForegroundColor Red
  $listener.Stop()
  exit 1
}

Write-Host "`n==> 拿到 authorization_code，换取 refresh_token ..." -ForegroundColor Cyan

# ===== 7. 用 code 换 refresh_token =====
$tokenBody = "grant_type=authorization_code" +
  "&code=$([System.Web.HttpUtility]::UrlEncode($code))" +
  "&client_id=$LWA_CLIENT_ID" +
  "&client_secret=$LWA_CLIENT_SECRET" +
  "&redirect_uri=$([System.Web.HttpUtility]::UrlEncode($REDIRECT_URI))"

try {
  $tokenResp = Invoke-WebRequest -Uri "https://api.amazon.com/auth/o2/token" `
    -Method POST `
    -ContentType "application/x-www-form-urlencoded" `
    -Body $tokenBody `
    -UseBasicParsing

  $token = $tokenResp.Content | ConvertFrom-Json
} catch {
  Write-Host "❌ 换 token 失败: $($_.Exception.Message)" -ForegroundColor Red
  $body = $_.Exception.Response?.GetResponseStream()
  if ($body) { $reader = New-Object System.IO.StreamReader($body); Write-Host "    Server says: $($reader.ReadToEnd())" }
  exit 1
}

# ===== 8. 输出 =====
Write-Host "`n================================================" -ForegroundColor Green
Write-Host "  ✅ 拿到了！" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Refresh Token:" -ForegroundColor Yellow
Write-Host "  $($token.refresh_token)"
Write-Host ""
Write-Host "  Access Token: (有效期只有 1 小时，每次部署由 server.js 自动换)" -ForegroundColor Gray
Write-Host "  $($token.access_token.Substring(0, [Math]::Min(20, $token.access_token.Length)))..."
Write-Host ""
Write-Host "  expires_in: $($token.expires_in)s" -ForegroundColor Gray
Write-Host "  token_type: $($token.token_type)" -ForegroundColor Gray

# ===== 9. 写入本地 secrets.json（deploy-with-credentials.ps1 会读）=====
$secretsPath = Join-Path $PSScriptRoot "secrets.json"
$secrets = @{
  SP_API_LWA_CLIENT_ID     = $LWA_CLIENT_ID
  SP_API_LWA_CLIENT_SECRET = $LWA_CLIENT_SECRET
  SP_API_LWA_REFRESH_TOKEN = $token.refresh_token
  generated_at             = (Get-Date).ToString("s")
  note                     = "Refresh Token 有效期通常 30 天，过期后重新跑本脚本即可"
} | ConvertTo-Json -Depth 3

Set-Content -Path $secretsPath -Value $secrets -NoNewline

Write-Host "`n✅ 已写入: $secretsPath" -ForegroundColor Green
Write-Host "   PowerShell 里别把这个文件放进 git，`.gitignore` 里应该有 secrets.json" -ForegroundColor DarkYellow

# ===== 10. 直接提示你下一步 =====
Write-Host "`n================================================" -ForegroundColor Cyan
Write-Host "  下一步" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. 复制上面的 Refresh Token" -ForegroundColor White
Write-Host "  2. 粘贴到 deploy-with-credentials.ps1 第 15 行 `$SP_API_LWA_REFRESH_TOKEN" -ForegroundColor White
Write-Host "  3. 跑 .\deploy-with-credentials.ps1 部署" -ForegroundColor White
Write-Host "  4. 或直接测试:" -ForegroundColor White
Write-Host "     curl ""https://api.amazon.com/auth/o2/token"" -d ""grant_type=refresh_token&refresh_token=你的token&client_id=$LWA_CLIENT_ID&client_secret=$LWA_CLIENT_SECRET""" -ForegroundColor Gray
Write-Host ""
