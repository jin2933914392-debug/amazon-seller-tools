<!-- 发行包的固定安装说明。发版时由 release.yml 接在 GitHub Release 里。
     版本相关的内容写进 CHANGELOG.md，别写在这里。 -->
**源码发行包** —— 只有一个 Node 进程，没有 npm 依赖，解压即可运行。

### 直接运行（Node 20+）
下载下方 `amazon-seller-tools.zip` → 解压 → 执行 `node server.js` → 打开 http://localhost:8000

### Docker
```bash
docker compose up -d --build
# 打开 http://localhost:8080
```

### Linux 服务器（nginx + systemd）
```bash
cp deploy/install.conf.example deploy/install.conf
# 填写域名、安装目录、运行用户、端口
bash deploy/render-deploy.sh
# 按输出命令安装 nginx / systemd / 健康检查 cron
```

### 数据说明
- Alexa 搜索词、ASIN 详情、关键词反查：直连亚马逊实时抓取，受对方限流影响。
- 广告判断、五池分类、利润、选品评分、BSR：纯本地计算，不上传服务器。
- 关键词反查只给真实搜索词与覆盖情况，不提供搜索量 / 竞争度估算。
