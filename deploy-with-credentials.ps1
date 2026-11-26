# ================================================================
#  Amazon Seller Tools - 部署脚本（带 SP-API 真实 ABA 凭据注入）
# ================================================================
#  用法:
#  1. 把下面的 [ 占位值 ] 替换成你自己的真实凭据
#  2. PowerShell 5 下直接跑:  .\deploy-with-credentials.ps1
#  3. 脚本会自动打包 → 生成带凭据的 execution-config.json → 部署 → 等待上线
# ================================================================

# ----- 1. 你的 SP-API 凭据（全部替换掉占位值！） -----
$SP_API_LWA_CLIENT_ID     = "amzn1.application-oa2-client.xxxxxxxxxxxxxxxxxxxxxx"     # LWA OAuth Client ID
$SP_API_LWA_CLIENT_SECRET = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"                         # LWA OAuth Client Secret
$SP_API_LWA_REFRESH_TOKEN = "Atzr|IwEBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"    # LWA Refresh Token
$SP_API_AWS_ACCESS_KEY_ID = "AKIAXXXXXXXXXXXXXXXX"                                     # AWS IAM Access Key ID
$SP_API_AWS_SECRET_KEY    = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"                   # AWS IAM Secret Access Key
$SP_API_ROLE_ARN          = "arn:aws:iam::123456789012:role/SP-API-Role"                # STS AssumeRole Role ARN

# ----- 1.5 Keepa API Token（推荐，不用 Brand Registry 也能拿真实 BSR）-----
# https://keepa.com/#!token → 注册后在 Dashboard 里领
# 免费试用 20 tokens/min 够用，付费最低 €49/月 20 tokens/min
$KEEPA_TOKEN              = "keepa_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"                       # Keepa API Token

# ----- 2. 站点配置 -----
$SITE_ID = "37lmgu7z9v2nb3yma16"
$APP_TAGS = "123,134,289"
$MARKETPLACE_ID = "ATVPDKIKX0DER"   # US

# ----- 3. 构建 staging 目录 -----
$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$stage  = Join-Path $env:TEMP "trae-deploy-$stamp"

Write-Host "==> Creating staging dir: $stage" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item "$srcDir\server.js"   -Destination $stage -Force
Copy-Item "$srcDir\index.html"  -Destination $stage -Force
Copy-Item "$srcDir\package.json"-Destination $stage -Force
Copy-Item "$srcDir\build.sh"    -Destination $stage -Force
Copy-Item "$srcDir\run.sh"      -Destination $stage -Force

# ----- 4. 生成 execution-config.json（带凭据 + Marketplace） -----
$executionConfig = @{
  schema_version = 1
  build = @{
    runtime_key      = "nodejs20"
    build_script     = "build.sh"
    output_dir       = "dist"
    environment      = @{}
    timeout_seconds  = 3600
  }
  runtime = @{
    runtime_key = "nodejs20"
    start_script = "run.sh"
    port = 8000
    environment = @{
      SP_API_LWA_CLIENT_ID     = $SP_API_LWA_CLIENT_ID
      SP_API_LWA_CLIENT_SECRET = $SP_API_LWA_CLIENT_SECRET
      SP_API_LWA_REFRESH_TOKEN = $SP_API_LWA_REFRESH_TOKEN
      SP_API_AWS_ACCESS_KEY_ID = $SP_API_AWS_ACCESS_KEY_ID
      SP_API_AWS_SECRET_KEY    = $SP_API_AWS_SECRET_KEY
      SP_API_ROLE_ARN          = $SP_API_ROLE_ARN
      SP_API_MARKETPLACE_ID    = $MARKETPLACE_ID
      KEEPA_TOKEN              = $KEEPA_TOKEN
    }
  }
} | ConvertTo-Json -Depth 5

$configPath = Join-Path $stage "execution-config.json"
Set-Content -Path $configPath -Value $executionConfig -NoNewline

Write-Host "==> execution-config.json generated (凭据已注入)" -ForegroundColor Green
Write-Host "    runtime.environment keys:" -ForegroundColor Gray
($executionConfig | ConvertFrom-Json).runtime.environment.PSObject.Properties.Name | ForEach-Object { Write-Host "      $_ = ***" }

# ----- 5. 部署 -----
$traeDeploy = "C:\Users\Administrator\.trae-cn\plugins\trae-remote-official\deployment\0.0.43\skills\deployment\bin\win32-x64\trae-deploy.exe"

Write-Host "`n==> Deploying to site $SITE_ID ..." -ForegroundColor Cyan
$out = & $traeDeploy deployments create `
  --site-id         $SITE_ID `
  --type            function-web `
  --source-dir      $stage `
  --execution-config $configPath `
  --app-tags        $APP_TAGS 2>&1 | Out-String

$deployId = ([regex]::Match($out, '"deployment_id":"(dep_\w+)"')).Groups[1].Value
if (-not $deployId) {
  Write-Host "❌ 解析 deployment_id 失败" -ForegroundColor Red
  Write-Host $out
  exit 1
}
Write-Host "==> Deployment ID: $deployId" -ForegroundColor Yellow

# ----- 6. 等待上线 -----
Write-Host "==> Waiting for deployment to complete ..." -ForegroundColor Cyan
& $traeDeploy deployments wait --deployment-id $deployId 2>&1 | Out-String | Select-String "status=9"
$url = "https://$SITE_ID.traesite.cn"
Write-Host "`n✅ 上线了！  $url" -ForegroundColor Green

# ----- 7. 15 秒后验证 SP-API 凭据是否生效 -----
Start-Sleep -Seconds 15
Write-Host "`n==> Verifying SP-API connection ..." -ForegroundColor Cyan
try {
  $c = (Invoke-WebRequest -Uri "$url/api/spapi/config" -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
  if ($c.ready) {
    Write-Host "✅ SP-API 凭据全部生效！" -ForegroundColor Green
  } else {
    Write-Host "⚠️  还有凭据缺失: $($c.missing.key -join ', ')" -ForegroundColor Yellow
  }
} catch {
  Write-Host "⚠️  服务还在冷启动，稍等 30s 后再手动测:  $url/api/spapi/config" -ForegroundColor Yellow
}

Write-Host "`n==> 拉真实 ABA 数据测试:" -ForegroundColor Cyan
Write-Host "    $url/api/spapi/brand-search-terms?days=30&keyword=power%20station" -ForegroundColor Gray
Write-Host "`n`nDone." -ForegroundColor Green
