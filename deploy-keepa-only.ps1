# ================================================================
#  Amazon Seller Tools — Keepa Token 一键部署脚本
# ================================================================
#  用法:
#  1. 把下面 $KEEPA_TOKEN 换成你的真实值（keepa.com/#!token 领）
#  2. PowerShell 跑:  powershell -ExecutionPolicy Bypass -File .\deploy-keepa-only.ps1
#  3. 自动打包 → 生成带 KEEPA_TOKEN 的 execution-config.json → 部署 → 等上线 → 自动验证
# ================================================================

# ======== 唯一需要你填的东西 ========
$KEEPA_TOKEN = "keepa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"   # ← 替换这一行！
# ====================================

# 站点配置（别改）
$SITE_ID    = "37lmgu7z9v2nb3yma16"
$APP_TAGS   = "123,134,289"
$DEPLOY_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path

# 构建 staging
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stage = Join-Path $env:TEMP "trae-deploy-$stamp"
Write-Host "==> 打包到 $stage" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item "$DEPLOY_DIR\server.js", "$DEPLOY_DIR\index.html", "$DEPLOY_DIR\package.json", "$DEPLOY_DIR\build.sh", "$DEPLOY_DIR\run.sh" -Destination $stage -Force

# execution-config.json（只注入 KEEPA_TOKEN，其他留空）
$cfg = @{
  schema_version = 1
  build  = @{ runtime_key = "nodejs20"; build_script = "build.sh"; output_dir = "dist"; environment = @{}; timeout_seconds = 3600 }
  runtime = @{
    runtime_key = "nodejs20"
    start_script = "run.sh"
    port = 8000
    environment = @{ KEEPA_TOKEN = $KEEPA_TOKEN }
  }
} | ConvertTo-Json -Depth 5
$cfg | Set-Content -Path (Join-Path $stage "execution-config.json") -NoNewline

Write-Host "==> execution-config.json (KEEPA_TOKEN=$($KEEPA_TOKEN.Substring(0, [Math]::Min(8, $KEEPA_TOKEN.Length)))...)" -ForegroundColor Green

# 部署
$traeDeploy = "C:\Users\Administrator\.trae-cn\plugins\trae-remote-official\deployment\0.0.43\skills\deployment\bin\win32-x64\trae-deploy.exe"
Write-Host "==> 部署中..." -ForegroundColor Cyan
$out = & $traeDeploy deployments create --site-id $SITE_ID --type function-web --source-dir $stage --execution-config (Join-Path $stage "execution-config.json") --app-tags $APP_TAGS 2>&1 | Out-String
$deployId = ([regex]::Match($out, '"deployment_id":"(dep_\w+)"')).Groups[1].Value
Write-Host "    deployment_id = $deployId" -ForegroundColor Yellow
& $traeDeploy deployments wait --deployment-id $deployId 2>&1 | Out-String | Select-String "status=9"

# 验证
$url = "https://$SITE_ID.traesite.cn"
Write-Host "`n==> 验证 Keepa Token 是否生效..." -ForegroundColor Cyan
Start-Sleep -Seconds 18
try {
  $s = (Invoke-WebRequest -Uri "$url/api/keepa/status" -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
  if ($s.configured) {
    Write-Host "    ✅ Keepa Token 生效！ (prefix=$($s.tokenPrefix))" -ForegroundColor Green
  } else {
    Write-Host "    ❌ Token 没生效，检查一下是不是漏了" -ForegroundColor Red
  }
} catch {
  Write-Host "    ⚠️  服务冷启动中，稍等 30s 后手动测: $url/api/keepa/status" -ForegroundColor Yellow
}

Write-Host "`n✅ 上线了！  $url" -ForegroundColor Green
Write-Host "`n测试命令:" -ForegroundColor Cyan
Write-Host "  curl '$url/api/keepa/product?asin=B0CQT5G1ZR&marketplace=US' | jq '.current'" -ForegroundColor Gray
Write-Host ""
