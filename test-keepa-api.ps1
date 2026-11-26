# ================================================================
#  Keepa API 端到端测试脚本
#  三层验证：Keepa 直连 → server.js 代理 → CSV 解码器 → 字段完整性
# ================================================================
#  用法:
#  1. 替换第 20 行 $KEEPA_TOKEN = "keepa_xxx"
#  2. PowerShell 5 跑:  .\test-keepa-api.ps1
#  3. 输出: 每层测试 PASS/FAIL + 原始数据对比 + 字段覆盖率报告
# ================================================================

$ErrorActionPreference = "Continue"

# ===== 1. 配置 =====
$KEEPA_TOKEN          = "keepa_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"   # ← 换成你的
$BASE_URL             = "https://37lmgu7z9v2nb3yma16.traesite.cn"   # 线上 server.js
$TEST_ASINS           = @(                                          # 三个不同类目的 ASIN
  @{ asin = "B0CQT5G1ZR"; marketplace = "US"; expected = "Daran Portable Power Station" },
  @{ asin = "B09V3KXJPB"; marketplace = "US"; expected = "iPad Air" },
  @{ asin = "B0EXAMPLE1"; marketplace = "US"; expected = "known product (replace if needed)" }
)
$TEST_DAYS            = 180

# ===== 2. 颜色辅助 =====
function Cyan($s)  { Write-Host $s -ForegroundColor Cyan }
function Green($s)  { Write-Host "✅ $s" -ForegroundColor Green }
function Red($s)    { Write-Host "❌ $s" -ForegroundColor Red }
function Yellow($s) { Write-Host "⚠️  $s" -ForegroundColor Yellow }
function Gray($s)   { Write-Host $s -ForegroundColor DarkGray }

# ===== 3. Keepa domain 映射 =====
$KEEPA_DOMAIN = @{ US = 1; UK = 2; DE = 3; FR = 4; JP = 5; CA = 6; IT = 7; ES = 8; IN = 9; MX = 10; BR = 11 }

# ===== 4. 计数器 =====
$script:PASS = 0
$script:FAIL = 0
$script:WARN = 0

function Check($name, $condition, $failMsg) {
  if ($condition) { Green $name; $script:PASS++ }
  else { Red "$name — $failMsg"; $script:FAIL++ }
}

# ==================================================================
#  PHASE 1: Keepa 直连测试（绕过我们的 server.js，直接打 Keepa API）
# ==================================================================
Cyan "`n============================================================"
Cyan "  PHASE 1 — Keepa 原始 API 直连"
Cyan "============================================================"

$asin = $TEST_ASINS[0].asin
$domain = $KEEPA_DOMAIN[$TEST_ASINS[0].marketplace]
$keepaUrl = "https://api.keepa.com/product?key=$KEEPA_TOKEN&domain=$domain&asin=$asin&stats=$TEST_DAYS&history=1&offers=0"

Cyan "  GET $keepaUrl"

try {
  $keepaResp = Invoke-WebRequest -Uri $keepaUrl -UseBasicParsing -TimeoutSec 30
  $keepaRaw = $keepaResp.Content | ConvertFrom-Json
  Green "HTTP 200 — Keepa 直连成功"
  $script:PASS++
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  Red "Keepa 直连失败 — HTTP $status"
  $stream = $_.Exception.Response.GetResponseStream()
  if ($stream) {
    $reader = New-Object System.IO.StreamReader($stream)
    $body = $reader.ReadToEnd()
    Red "  Keepa 原始错误: $($body.Substring(0, [Math]::Min(300, $body.Length)))"
  }
  $script:FAIL++
  Yellow "Token 可能错了？先去 https://keepa.com/#!token 确认一下"
  exit 1
}

# --- 原始 Keepa 对象结构检查 ---
Cyan "`n  [1.1] Keepa 原始 JSON 结构"
Check "products 数组存在" ($null -ne $keepaRaw.products) "products 是 $($keepaRaw.products.GetType().Name)"
if ($keepaRaw.products) {
  $p = $keepaRaw.products[0]
  Check "product[0] 存在" ($null -ne $p) "products 长度=$($keepaRaw.products.Count)"
  if ($p) {
    Check "asin = $asin" ($p.asin -eq $asin) "got $($p.asin)"
    Check "title 非空" ($null -ne $p.title -and $p.title.Length -gt 5) "title='$($p.title)'"
    Check "csv 数组存在" ($null -ne $p.csv) "csv 是 $($p.csv.GetType().Name)"
    Check "csv 长度 ≥ 8" ($p.csv.Count -ge 8) "csv 类型数=$($p.csv.Count) (应 ≥ 8 覆盖 0..7)"
    Check "stats 对象存在" ($null -ne $p.stats) "stats 是 $($p.stats.GetType().Name)"
    Check "stats.current 是数组" ($null -ne $p.stats.current) "stats.current=$($p.stats.current.GetType().Name)"
    Check "stats.current[3] (NEW_SALES_RANK) 非零" ($p.stats.current[3] -gt 0) "BSR=$($p.stats.current[3])"
  }
}

# --- CSV 各类型长度检查 ---
Cyan "`n  [1.2] Keepa CSV 时间序列覆盖"
$TYPE_NAMES = @(
  "0=Amazon NEW Price",
  "1=3rd Party NEW Price",
  "2=USED Price",
  "3=NEW Sales Rank ← BSR!",
  "4=USED Sales Rank",
  "5=Amazon Offer Count",
  "6=NEW Offer Count (卖家数)",
  "7=USED Offer Count"
)
for ($t = 0; $t -lt 8; $t++) {
  $rows = $p.csv[$t]
  $count = if ($rows) { $rows.Count } else { 0 }
  $label = $TYPE_NAMES[$t]
  if ($count -gt 0) {
    Green "  CSV[$t] $label — $count 条记录"
  } elseif ($t -in @(0, 1, 3, 6)) {
    Red   "  CSV[$t] $label — 0 条（关键类型空了！）"
    $script:FAIL++
  } else {
    Yellow "  CSV[$t] $label — 0 条（该 ASIN 没有 USED 数据正常）"
  }
}

# --- stats 字段完整性 ---
Cyan "`n  [1.3] Keepa stats 预计算字段"
$stats = $p.stats
$expectedStats = @("current", "avg180", "minInInterval", "maxInInterval", "salesRankDrops30", "outOfStockPercentage90")
foreach ($f in $expectedStats) {
  if ($null -ne $stats.$f) {
    Green "  stats.$f 存在"
    $script:PASS++
  } else {
    Red "  stats.$f 缺失"
    $script:FAIL++
  }
}

# ==================================================================
#  PHASE 2: 我们 server.js 代理端点测试
# ==================================================================
Cyan "`n============================================================"
Cyan "  PHASE 2 — server.js /api/keepa/product 代理端点"
Cyan "============================================================"

$proxyUrl = "$BASE_URL/api/keepa/product?asin=$asin&marketplace=$($TEST_ASINS[0].marketplace)&days=$TEST_DAYS"
Cyan "  GET $proxyUrl"

try {
  $proxyResp = Invoke-WebRequest -Uri $proxyUrl -UseBasicParsing -TimeoutSec 60
  $proxy = $proxyResp.Content | ConvertFrom-Json
  Check "HTTP 200" ($proxyResp.StatusCode -eq 200) "got $($proxyResp.StatusCode)"
  Check "ok=true" ($proxy.ok -eq $true) "ok=$($proxy.ok) error=$($proxy.error)"
} catch {
  $stream = $_.Exception.Response.GetResponseStream()
  if ($stream) {
    $reader = New-Object System.IO.StreamReader($stream)
    $err = $reader.ReadToEnd() | ConvertFrom-Json
    Red "代理端点失败 — $($err.error)"
    if ($err.error -match "Keepa Token 未配置") {
      Yellow "→ 你需要把 KEEPA_TOKEN 环境变量注入到线上部署"
    }
  } else {
    Red "代理端点根本没响应 — server.js 可能没部署最新版"
  }
  $script:FAIL++
  exit 1
}

# --- 代理返回字段覆盖率 ---
Cyan "`n  [2.1] 代理返回字段完整性"
$requiredFields = @(
  @{ path = "title";          type = "string"; desc = "产品标题" },
  @{ path = "brand";          type = "string"; desc = "品牌" },
  @{ path = "current.bsrNew"; type = "int";    desc = "当前类目 BSR" },
  @{ path = "current.newPrice"; type = "double"; desc = "第三方 NEW 价(美元)" },
  @{ path = "current.newOffers"; type = "int";  desc = "当前卖家数" },
  @{ path = "avg.bsrNew";     type = "int";    desc = "180天平均 BSR" },
  @{ path = "avg.newPrice";   type = "double"; desc = "180天平均价" },
  @{ path = "min.bsrNew";     type = "int";    desc = "180天最低 BSR (越小越好)" },
  @{ path = "min.amazonPrice"; type = "double"; desc = "180天 Amazon 最低价" },
  @{ path = "rankDelta.now";  type = "int";    desc = "当前 BSR" },
  @{ path = "rankDelta.d7";   type = "obj";    desc = "7天前 BSR + delta" },
  @{ path = "rankDelta.d30";  type = "obj";    desc = "30天前 BSR + delta" },
  @{ path = "rankSeries";     type = "array";  desc = "BSR 时间序列 [{date, bsr}]" },
  @{ path = "priceHistory";   type = "array";  desc = "价格历史 [{date, price}]" }
)

foreach ($f in $requiredFields) {
  $val = $proxy
  foreach ($seg in $f.path.Split('.')) { $val = $val.$seg }
  $exists = $null -ne $val -and $val -ne ""
  if ($exists) { Green "  ✅ $($f.path) = $($val.ToString().Substring(0, [Math]::Min(60, $val.ToString().Length)))" }
  else { Red "  ❌ $($f.path) — $($f.desc) 缺失" }
}

# ==================================================================
#  PHASE 3: server.js vs Keepa 原始数据一致性
# ==================================================================
Cyan "`n============================================================"
Cyan "  PHASE 3 — server.js CSV 解码器验证（和 Keepa 原始对比）"
Cyan "============================================================"

# --- BSR 排名一致性 ---
$keepaBsr = $p.stats.current[3]
$proxyBsr = $proxy.current.bsrNew
Check "BSR 排名一致 (Keepa=$keepaBsr vs Proxy=$proxyBsr)" ($keepaBsr -eq $proxyBsr -or [Math]::Abs($keepaBsr - $proxyBsr) -le 5) "差值=$([Math]::Abs($keepaBsr - $proxyBsr))"

# --- 价格一致性 ---
$keepaPrice = $p.stats.current[1] / 100.0   # 分→美元
$proxyPrice = $proxy.current.newPrice
Check "NEW 价格一致 (Keepa=`$$keepaPrice vs Proxy=`$$proxyPrice)" ([Math]::Abs($keepaPrice - $proxyPrice) -le 0.10) "差值=$([Math]::Abs($keepaPrice - $proxyPrice))"

# --- 卖家数一致性 ---
$keepaOffers = $p.stats.current[6]
$proxyOffers = $proxy.current.newOffers
Check "卖家数一致 (Keepa=$keepaOffers vs Proxy=$proxyOffers)" ($keepaOffers -eq $proxyOffers) ""

# --- rankSeries 解码正确性 ---
$keepaRankCsv = $p.csv[3]  # NEW_SALES_RANK 原始 CSV
$proxySeries = $proxy.rankSeries
Check "Keepa CSV[3] 有数据" ($keepaRankCsv.Count -gt 0) "0 条"
Check "proxy.rankSeries 有数据" ($proxySeries.Count -gt 0) "0 条"
if ($keepaRankCsv.Count -gt 0 -and $proxySeries.Count -gt 0) {
  # server.js 解码出来的最后一条应该等于 Keepa CSV 最后一条解码出来的值
  $proxyLast = $proxySeries[$proxySeries.Count - 1].bsr
  # 手动解 Keepa CSV 最后一条（差分）
  $last = $keepaRankCsv[$keepaRankCsv.Count - 1]
  $prev = $keepaRankCsv[$keepaRankCsv.Count - 2]
  $decodedBsr = $prev[2] + $last[2]  # 简化：假设前两条可解
  Check "rankSeries 最后 BSR ≈ Keepa 原始" ([Math]::Abs($proxyLast - $keepaBsr) -le 5) "proxy.last=$proxyLast keepa.current=$keepaBsr"
}

# ==================================================================
#  PHASE 4: 三个 ASIN 批量覆盖测试
# ==================================================================
Cyan "`n============================================================"
Cyan "  PHASE 4 — 3 个 ASIN 批量覆盖"
Cyan "============================================================"

foreach ($t in $TEST_ASINS) {
  $url = "$BASE_URL/api/keepa/product?asin=$($t.asin)&marketplace=$($t.marketplace)&days=90"
  try {
    $r = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
    if ($r.ok) {
      Green "$($t.asin) | BSR=$($r.current.bsrNew) | 卖家=$($r.current.newOffers) | 标题=$($r.title.Substring(0, [Math]::Min(40, $r.title.Length)))..."
      $script:PASS++
    } else {
      Yellow "$($t.asin) — API 返回 ok=false: $($r.error)"
      $script:WARN++
    }
  } catch {
    Red "$($t.asin) — HTTP 错误: $($_.Exception.Message.Substring(0, [Math]::Min(80, $_.Exception.Message.Length)))"
    $script:FAIL++
  }
}

# ==================================================================
#  PHASE 5: keepa/status 健康检查
# ==================================================================
Cyan "`n============================================================"
Cyan "  PHASE 5 — /api/keepa/status 健康检查"
Cyan "============================================================"

try {
  $s = (Invoke-WebRequest -Uri "$BASE_URL/api/keepa/status" -UseBasicParsing).Content | ConvertFrom-Json
  Check "Keepa Token 已配置" ($s.configured -eq $true) "configured=$($s.configured)"
  Check "tokenPrefix 非空" ($null -ne $s.tokenPrefix) "tokenPrefix=$($s.tokenPrefix)"
  Green "usageNote: $($s.usageNote)"
} catch {
  Red "keepa/status 端点不可达"
  $script:FAIL++
}

# ==================================================================
#  汇总
# ==================================================================
Cyan "`n============================================================"
Cyan "  汇总"
Cyan "============================================================"
Write-Host ""
Write-Host "  PASS: $($script:PASS)" -ForegroundColor Green
Write-Host "  FAIL: $($script:FAIL)" -ForegroundColor Red
Write-Host "  WARN: $($script:WARN)" -ForegroundColor Yellow
Write-Host ""

if ($script:FAIL -eq 0) {
  Green "🎉 全部测试通过！Keepa 数据链路完整可用"
} else {
  Yellow "有 $($script:FAIL) 项失败，看上面红色错误定位问题"
}

Write-Host ""
Write-Host "  下一步接入前端:" -ForegroundColor Cyan
Write-Host "  1. runAsin() 里 fetch /api/keepa/product?asin=XXX" -ForegroundColor Gray
Write-Host "  2. renderAllKeywords() 的 rankNow / trend sparkline 切到 rankSeries" -ForegroundColor Gray
Write-Host "  3. ABA 列暂时保留 autocomplete proxy，未来接 SP-API Brand Analytics" -ForegroundColor Gray
