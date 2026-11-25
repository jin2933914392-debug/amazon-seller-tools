# 亚马逊卖家助手（amazon-seller-tools）

零依赖的亚马逊运营工具集：一个 Node 20 单文件服务 + 一个单页前端。无需安装任何 npm 依赖，解压即可运行。

- 线上演示：https://37lmgu7z9v2nb3yma16.traesite.cn
- 许可证：[AGPL-3.0](LICENSE)

## 功能

任务台式首页，按「新品开发 / 广告优化 / 竞品研究」三条任务链组织 10 个工具：

| 工具 | 说明 |
| --- | --- |
| 广告搜索词分析 | 多维判断每个词「否 / 留 / 观察」，白名单品牌词保护 |
| Alexa 导购洞察 · 词海搭建 | ASIN / 种子词抓真实搜索词，一条龙生成五级词海与广告方案 |
| ASIN 产品分析 | 抓取竞品标题、卖点、类目、评分与主图 |
| 关键词五池分类 | 自动归入 Listing / 广告 / 观察 / 否定 / 品牌隔离 |
| Listing 优化 | 标题 + 五点 + 关键词反查 + 完整度自检 + 实战手册 |
| 竞品流量词对比 | 份额 → 绝对量口径校准，识别「口径陷阱」 |
| 选品评分器 | 0-100 多维度潜力评分 |
| BSR 销量预估 | 按类目 BSR 排名估算日 / 月销量 |
| FBA 利润计算器 | 单件毛利、毛利率与盈亏平衡点测算 |
| API 设置 | 配置 SP-API 凭据并测试连通性 |

每个工具页都带折叠的「使用说明」；首页展示后端健康状态与最近操作记录。

## 快速开始

要求 Node.js ≥ 18（建议 20）。

```bash
node server.js
# 打开 http://localhost:8000
```

端口可用环境变量覆盖：`PORT=9000 node server.js`。

## Docker

```bash
docker compose up -d --build
# 打开 http://localhost:8080
```

## Linux 自托管（nginx + systemd）

```bash
cp deploy/install.conf.example deploy/install.conf
# 编辑：域名、安装目录、运行用户、端口
bash deploy/render-deploy.sh
# 按输出命令安装 nginx / systemd / 健康检查 cron
```

需要 `envsubst`（Debian/Ubuntu：`apt install gettext-base`）。

## HTTP 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查，返回 `{ok:true,time}` |
| `GET /api/dashboard` | 首页聚合：后端状态、Alexa 缓存摘要 |
| `POST /api/alexa/insight` | 按 ASIN / 种子词抓取真实搜索词（实时，十几秒到几十秒） |
| `GET /api/alexa/cached` | 读取 3 小时定时刷新的缓存 |
| `POST /api/alexa/refresh` | 手动触发缓存刷新 |
| `GET /api/asin/{ASIN}` | 抓取 ASIN 详情 |
| `GET /api/listing/keywords` | 关键词反查 |

## 数据口径

- **实时抓取**：Alexa 搜索词与板块词、ASIN 详情、关键词反查，直连亚马逊，受对方限流影响，超时与错误会返回明确提示。
- **本地计算**：广告词判断、五池分类、词海生成、Listing 体检、利润、选品评分、BSR 预估，全部在浏览器本地完成，不上传服务器。
- **不编造数据**：关键词反查只给真实搜索词与覆盖情况，不提供搜索量 / 竞争度估算。

## 项目结构

```
server.js           # 全部后端：零依赖 http 服务 + 定时缓存 + 抓取逻辑
index.html          # 全部前端：单页 10 工具 + 任务台 + 使用说明
build.sh / run.sh   # 平台构建与启动脚本
Dockerfile          # 生产镜像（node:20-alpine，非 root，内置 HEALTHCHECK）
docker-compose.yml  # 8080 -> 8000
deploy/             # 自托管：nginx / systemd / cron 模板 + 渲染脚本
.github/            # CI（语法 / 冒烟 / 模板渲染 / Docker）与 Release 打包
```

## 开发

- 提交前：`node --check server.js`；`index.html` 内联脚本语法见 `.github/workflows/ci.yml`。
- 发版：打 `v*` tag 或手动触发 Release 工作流，自动产出 `amazon-seller-tools.zip`。
- 本版改动见 [CHANGELOG.md](CHANGELOG.md)。
