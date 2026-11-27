'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8000;
// ===== 定时抓取 & 内存缓存（每 3 小时自动刷新 Alexa 导购洞察） =====
const CACHE_SEEDS = ['water bottle', 'insulated bottle', 'power station portable', 'best seller home'];
const CACHE_MARKETPLACES = ['US'];
const CACHE_LIMIT = 20;
const CACHE_EXPAND = true;
const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
const MAX_TREND_HISTORY = 96;  // 3 小时一次 × 96 ≈ 12 天
// ====== 西柚找词风格：按 ASIN 监控排名变化 ======
// 可通过 /api/alexa/monitor 动态添加；空数组=未配置时不会跑 ASIN 快照
let MONITOR_ASINS = [];
let alexaCache = {
  data: null, updatedAt: null, status: 'idle', durationMs: 0, lastError: null, requests: 0,
  // 原始 seed 的排名快照：marketplace -> seed -> [{ time, ranked:[{kw,rank}] }]
  trend: null, trendUpdatedAt: null, trendLastError: null,
  // 按 ASIN 监控的排名快照：asin -> marketplace -> [{ time, seeds:[str], ranked:[{kw, rank, seed}] }]
  // 这里的 seed 是从该 ASIN 页面提取出来的（品牌、产品主词、类目等）
  trendAsin: {},  // { [asin]: { [market]: [{ time, seeds, ranked }] } }
};
let cacheRefreshing = false;

// ===== 真实买家搜索探针 =====
// Amazon suggestions 服务由真实用户搜索日志生成；用买家常用的问句/场景/价格/对比句式去探，
// 返回的就是"用户实际搜过的"关键词和句子（而不只是种子词的品牌补全噪声）。
const INTENT_PROBES = [
  '{seed} for',                    // 人群 / 场景（for kids / for travel / for home）
  '{seed} with',                   // 功能特征（with straw / with handle）
  '{seed} without',                // 排除型需求（without straw / without plastic）
  '{seed} under',                  // 价格区间（under 20 / under 10 dollars）
  '{seed} best',                   // 选购（best rated / best brand）
  '{seed} cheap',                  // 预算型（cheap / cheapest）
  '{seed} review',                 // 评测
  '{seed} vs',                     // 对比
  '{seed} near me',                // 就近购买
  'what is the best {seed}',       // 真人问句
  'how to choose {seed}',          // 真人问句
  'how to use {seed}',             // 真人问句
  'can i use {seed}',              // 真人问句
  'does {seed}',                   // 真人问句
  'which {seed}',                  // 真人问句
  'how much is {seed}',            // 真人问句
  '{seed} that',                   // 长尾需求（that keeps cold / that does not leak）
  '{seed} how',                    // 用法问句（how to clean / how long）
  '{seed} what',                   // 特征问句（what size / what material）
  'is {seed}',                     // 真人问句
  'do {seed}',                     // 真人问句
  'why {seed}',                    // 真人问句
];
const ALPHA_PROBES = 'abcde'.split('');  // 精简字母探针，压缩品牌噪声

// 并发执行，受 maxRequests 限制
async function runInsight({ seeds, marketplace, limit, expand }) {
  const keywordMap = new Map();       // 小写去重 -> 原始词
  const keywordSource = new Map();    // 小写 -> 'seed' | 'intent' | 'alpha'
  const sourceRank = { seed: 3, intent: 2, alpha: 1 };
  const allWidgets = [];
  const seenWidgets = new Set();

  const queue = seeds.map(s => ({ q: s, source: 'seed', seed: s }));
  if (expand) {
    for (const s of seeds) {
      for (const t of INTENT_PROBES) queue.push({ q: t.replace('{seed}', s), source: 'intent', seed: s });
      for (const ch of ALPHA_PROBES) queue.push({ q: s + ' ' + ch, source: 'alpha', seed: s });
    }
  }
  const maxRequests = expand ? Math.min(200, queue.length) : seeds.length;
  const CONCURRENCY = 5;
  const doneProbes = new Set();
  let requests = 0;

  while (queue.length && requests < maxRequests) {
    const batch = queue.splice(0, Math.min(CONCURRENCY, maxRequests - requests));
    requests += batch.length;
    const results = await Promise.all(batch.map(async (item) => {
      const key = String(item.q || '').toLowerCase().trim();
      if (!key || doneProbes.has(key)) return { item, keywords: [], widgets: [] };
      doneProbes.add(key);
      try {
        const r = await crawlOne(item.q, marketplace, limit);
        return { item, keywords: r.keywords, widgets: r.widgets };
      } catch (e) {
        return { item, keywords: [], widgets: [] };
      }
    }));
    for (const { item, keywords, widgets } of results) {
      widgets.forEach(w => { if (!seenWidgets.has(w.header)) { seenWidgets.add(w.header); allWidgets.push(w); } });
      for (const k of keywords) {
        const lower = k.toLowerCase().trim();
        // 过滤 Amazon 原样回显的探针片段（如 "do water bottle"），只保留真实补全结果
        if (lower === String(item.q).toLowerCase().trim()) continue;
        const seed = String(item.seed || '').toLowerCase();
        if (seed) {
          const escSeed = seed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp('^(do|does|is|are|was|will|can|how|what|why|where|when|which)\\s+' + escSeed + '$').test(lower)) continue;
        }
        const key = lower;
        const prev = keywordSource.get(key);
        // 同一关键词保留优先级更高的来源（seed > intent > alpha）
        if (!prev || sourceRank[item.source] > sourceRank[prev]) {
          keywordMap.set(key, k);
          keywordSource.set(key, item.source);
        }
      }
    }
  }

  const enriched = [...keywordMap.values()].filter(t => t.length >= 2).sort().map(t => {
    const kw = enrichKeyword(t, seeds);
    kw.source = keywordSource.get(t.toLowerCase()) || 'intent';
    return kw;
  });
  const levelCounts = [0,0,0,0,0];
  const coreCounts = {};
  let questionCount = 0;
  const intentCounts = {};
  const sources = { seed: 0, intent: 0, alpha: 0 };
  enriched.forEach(e => {
    if (e.level <= 4) levelCounts[e.level]++;
    if (e.core) coreCounts[e.core] = (coreCounts[e.core] || 0) + 1;
    if (e.isQuestion) questionCount++;
    intentCounts[e.intent] = (intentCounts[e.intent] || 0) + 1;
    if (sources[e.source] != null) sources[e.source]++;
  });
  return {
    ok: true, seeds, marketplace, keywords: enriched, widgets: allWidgets, requests, expanded: expand,
    stats: { total: enriched.length, questions: questionCount, levelCounts, coreCounts, intentCounts, sources },
  };
}

async function refreshAlexaCache() {
  if (cacheRefreshing) return;
  cacheRefreshing = true;
  const t0 = Date.now();
  alexaCache.status = 'refreshing';
  alexaCache.lastError = null;
  try {
    // 多种子 × 多站点：逐个调用 runInsight 并合并
    const allKeywords = new Map();
    const allWidgets = [];
    const seenWidgets = new Set();
    let totalRequests = 0;
    const perMarket = {};
    for (const mkt of CACHE_MARKETPLACES) {
      const res = await runInsight({ seeds: CACHE_SEEDS, marketplace: mkt, limit: CACHE_LIMIT, expand: CACHE_EXPAND });
      res.keywords.forEach(k => { if (!allKeywords.has(k.text)) allKeywords.set(k.text, { ...k }); });
      res.widgets.forEach(w => { const key = mkt + ':' + w.header; if (!seenWidgets.has(key)) { seenWidgets.add(key); allWidgets.push({ ...w, marketplace: mkt }); } });
      totalRequests += res.requests;
      perMarket[mkt] = res.stats;
    }
    // 合并统计
    const merged = [...allKeywords.values()];
    const levelCounts = [0,0,0,0,0];
    const coreCounts = {};
    let qCount = 0;
    const intentCounts = {};
    const sources = { seed: 0, intent: 0, alpha: 0 };
    merged.forEach(e => {
      if (e.level <= 4) levelCounts[e.level]++;
      if (e.core) coreCounts[e.core] = (coreCounts[e.core] || 0) + 1;
      if (e.isQuestion) qCount++;
      intentCounts[e.intent] = (intentCounts[e.intent] || 0) + 1;
      if (e.source && sources[e.source] != null) sources[e.source]++;
    });
    alexaCache = {
      data: {
        seeds: CACHE_SEEDS, marketplaces: CACHE_MARKETPLACES,
        keywords: merged, widgets: allWidgets, requests: totalRequests,
        stats: { total: merged.length, questions: qCount, levelCounts, coreCounts, intentCounts, sources },
        perMarket,
      },
      updatedAt: new Date().toISOString(),
      status: 'ok',
      durationMs: Date.now() - t0,
      lastError: null,
      requests: totalRequests,
    };
    console.log('[cache] Alexa refresh OK:', merged.length, 'keywords,', totalRequests, 'requests,', ((Date.now()-t0)/1000).toFixed(1), 's');

    // ===== 排名快照（西柚找词风格：监控每个 seed 下 ABA 排名 / 热度变化） =====
    try {
      const trendNow = {};
      for (const mkt of CACHE_MARKETPLACES) {
        trendNow[mkt] = await crawlSeedTrend(CACHE_SEEDS, mkt, CACHE_LIMIT);
      }
      const nowIso = new Date().toISOString();
      if (!alexaCache.trend) alexaCache.trend = {};
      for (const mkt of CACHE_MARKETPLACES) {
        if (!alexaCache.trend[mkt]) alexaCache.trend[mkt] = {};
        for (const seed of CACHE_SEEDS) {
          const sk = seed.toLowerCase();
          if (!alexaCache.trend[mkt][sk]) alexaCache.trend[mkt][sk] = [];
          alexaCache.trend[mkt][sk].push({ time: nowIso, ranked: trendNow[mkt][sk] || [] });
          if (alexaCache.trend[mkt][sk].length > MAX_TREND_HISTORY) {
            alexaCache.trend[mkt][sk].shift();
          }
        }
      }
      alexaCache.trendUpdatedAt = nowIso;
      alexaCache.trendLastError = null;
      console.log('[trend] snapshot OK:', nowIso);
    } catch (te) {
      console.error('[trend] snapshot FAIL:', te.message);
      alexaCache.trendLastError = te.message;
    }

    // ====== 按 ASIN 监控排名（西柚找词核心） ======
    if (MONITOR_ASINS.length) {
      try {
        const nowIso = new Date().toISOString();
        const limitPerSeed = 20;
        // 每个 ASIN × 每个 marketplace：先 scrape 拿 product，再抽 seed，再 crawl autocomplete
        for (const asinObj of MONITOR_ASINS) {
          const asin = (asinObj.asin || '').toUpperCase();
          const marketplace = (asinObj.marketplace || 'US').toUpperCase();
          if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) continue;
          try {
            const { html, status } = await fetchAsinPage(asin, marketplace);
            if (status !== 200 || (html || '').length < 50000) continue;
            const product = parseAsinProduct(html, asin, marketplace);
            if (!product || !product.title) continue;

            const { seeds, ranked } = await runAsinSnapshot(asin, marketplace, product, limitPerSeed);
            if (!seeds.length) continue;

            // 存进 trendAsin[asin][marketplace]
            if (!alexaCache.trendAsin[asin]) alexaCache.trendAsin[asin] = {};
            if (!alexaCache.trendAsin[asin][marketplace]) alexaCache.trendAsin[asin][marketplace] = [];
            alexaCache.trendAsin[asin][marketplace].push({ time: nowIso, seeds, ranked });
            if (alexaCache.trendAsin[asin][marketplace].length > MAX_TREND_HISTORY) {
              alexaCache.trendAsin[asin][marketplace].shift();
            }
            console.log('[trend-asin]', asin, marketplace, seeds.length, 'seeds,', ranked.length, 'ranked words');
          } catch (ae) {
            console.error('[trend-asin]', asin, marketplace, 'FAIL:', ae.message);
          }
        }
      } catch (ae2) {
        console.error('[trend-asin] batch FAIL:', ae2.message);
      }
    }
  } catch (e) {
    console.error('[cache] Alexa refresh FAIL:', e.message);
    alexaCache.status = 'error';
    alexaCache.lastError = e.message;
    alexaCache.updatedAt = new Date().toISOString();
  } finally {
    cacheRefreshing = false;
  }
}


const HOST = '0.0.0.0';

// ===== 亚马逊 autocomplete 端点（Alexa 导购洞察用） =====
const AMAZON_SUGGEST_HOST = {
  US: { host: 'www.amazon.com',  alias: 'aps',   mid: 'ATVPDKIKX0DER',   lang: 'en_US' },
  UK: { host: 'www.amazon.co.uk', alias: 'aps',   mid: 'A3P5ROKL5A1OLE',  lang: 'en_GB' },
  DE: { host: 'www.amazon.de',   alias: 'aps',   mid: 'A1PA6795UKMFR9',  lang: 'de_DE' },
  FR: { host: 'www.amazon.fr',   alias: 'aps',   mid: 'A13V1IB3VIYZZH',  lang: 'fr_FR' },
  IT: { host: 'www.amazon.it',   alias: 'aps',   mid: 'APJ6JRA9NG5V4',   lang: 'it_IT' },
  ES: { host: 'www.amazon.es',   alias: 'aps',   mid: 'A1RKKUPIHCS9HS',  lang: 'es_ES' },
  JP: { host: 'www.amazon.co.jp',alias: 'aps',   mid: 'A1VC38T7YXB528',  lang: 'ja_JP' },
  CA: { host: 'www.amazon.ca',   alias: 'aps',   mid: 'A2EUQ1WTGCTBG2',  lang: 'en_CA' },
};

async function amazonSuggest(prefix, marketplace, limit) {
  const m = AMAZON_SUGGEST_HOST[marketplace] || AMAZON_SUGGEST_HOST.US;
  const url = 'https://' + m.host + '/suggestions' +
    '?limit=' + Math.min(50, limit || 15) +
    '&prefix=' + encodeURIComponent(prefix) +
    '&alias=' + m.alias +
    '&mid=' + m.mid +
    '&page-type=Gateway' +
    '&site-variant=desktop' +
    '&lop=' + m.lang;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': m.lang,
      'Origin': 'https://' + m.host,
      'Referer': 'https://' + m.host + '/',
    },
  });
  if (!res.ok) throw new Error('Amazon suggestions HTTP ' + res.status);
  return res.json();
}

// 抓取单个种子词，返回 {keywords:[], widgets:[], ranked:[{kw,rank}]}
// rank 取 KeywordSuggestion 在 suggestions 数组中的位置（从 0 起），这是 Amazon autocomplete 真实排名
async function crawlOne(prefix, marketplace, limit) {
  const data = await amazonSuggest(prefix, marketplace, limit);
  const keywords = [];
  const widgets = [];
  const ranked = [];
  let rank = 0;
  for (const s of data.suggestions || []) {
    if (s.suggType === 'KeywordSuggestion') {
      if (isCleanKeyword(s.value)) {
        keywords.push(s.value);
        ranked.push({ kw: s.value.toLowerCase().trim(), rank });
      }
      rank++;  // 不管过不过滤，position 递增（Amazon 返回的顺序就是真实排名）
    } else if (s.suggType === 'WidgetSuggestion') {
      const items = (s.widgetItems || []).map(w => w.value).filter(Boolean).filter(isCleanKeyword);
      if (items.length) widgets.push({ header: (s.metadata && s.metadata.header) || s.value, items });
      // WidgetSuggestion 也算在 position 序列里
      rank++;
    }
  }
  return { keywords, widgets, ranked };
}

// 仅用原始种子词跑一次 autocomplete，保留完整 rank 序列，作为"当前快照"
// 这才是西柚找词那种 ABA 排名监控——每个 seed 下关键词在 autocomplete 列表里的位置就是热度
async function crawlSeedTrend(seeds, marketplace, limit) {
  const out = {};
  for (const seed of seeds) {
    try {
      const { ranked } = await crawlOne(seed, marketplace, limit);
      out[seed.toLowerCase()] = ranked;
    } catch (e) {
      out[seed.toLowerCase()] = [];
    }
  }
  return out;
}

// ===== 从 ASIN 产品页提取监控用的 seed =====
// 规则：品牌词 + 产品主词（标题主部分）+ 类目名词 + 卖点里重复出现的名词短语
// 避免太长的 seed，只取 3-5 个能直接扔进 Amazon autocomplete 有意义的词
function extractSeedsFromProduct(product) {
  if (!product) return [];
  const seen = new Set();
  const out = [];
  const add = (s) => {
    if (!s) return;
    const t = s.trim().toLowerCase();
    if (t.length < 3 || t.length > 40) return;
    if (!/^[a-z0-9\s\-+&]+$/.test(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(s.trim());
  };

  // 1) 品牌词——一般是这个 ASIN 下所有流量词的核心锚点
  if (product.brand) add(product.brand);

  // 2) 标题主词：去掉品牌、数字规格、长描述后取剩余名词短语
  //    "Stanley Quencher H2.0 FlowState 40 oz Tumbler" → "Quencher FlowState Tumbler"
  let titleMain = (product.title || '')
    .split('|')[0].split(/[:–—\-]/)[0].trim()
    .replace(/\b\d{1,3}(?:oz|ml|l|w|mah|v|in|inch|cm|ft|pack|pcs|pieces?|count|set|kit)\b/gi, '')
    .replace(/\b\d{2,4}\b/g, '')
    .replace(/\b[a-z]{1,2}\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  // 去掉开头的品牌词（避免和 #1 重复）
  if (product.brand && titleMain.toLowerCase().startsWith(product.brand.toLowerCase())) {
    titleMain = titleMain.slice(product.brand.length).trim();
  }
  // 拆成 2-3 词的短语
  const words = titleMain.split(/\s+/).filter(w => w.length > 2);
  if (words.length >= 2) add(words.slice(0, 2).join(' '));
  if (words.length >= 3) add(words.slice(0, 3).join(' '));
  if (words.length === 1 && words[0]) add(words[0]);

  // 3) 类目里的具体名词（剔除 Electronics / Home & Kitchen 这种大类，以及 Amazon UI 文案）
  //    关键：类目链里只取**最后一级**（最具体的那个），前面的大类 Patio / Lawn 全丢
  if (product.categories && product.categories.length) {
    // 大类黑名单：Amazon 页面上经常出现但和具体产品完全无关的词
    const CAT_BLACKLIST = /^(electronics|home|kitchen|health|beauty|toys|games|sports|outdoors|clothing|shoes|jewelry|books|grocery|pet|office|tools|automotive|baby|industrial|handmade|arts|crafts|collectibles|fine art|musical instruments|software|videogames|see more|make money|with us|more|amazon|prime|see all|patio|lawn|garden|furniture|outdoor|indoor|room|bedroom|bathroom|kitchen|living room|dining|home decor|storage|cleaning|school|college|work|business|car|truck|vehicle|boat|rv|motorcycle)$/i;
    // 只取类目链的最后一级——前面的 Patio / Lawn 这种大类丢了
    const lastCat = product.categories[product.categories.length - 1];
    if (lastCat && !CAT_BLACKLIST.test(lastCat) && lastCat.length >= 6 && lastCat.length <= 50 && lastCat.split(/\s+/).length >= 2) {
      add(lastCat);
    }
  }

  // 4) 卖点里高频出现的产品名（兜底）
  if (product.bullets && product.bullets.length) {
    // 先把 Amazon 页面底部的排名区 / 对比区行过滤掉
    const CLEANED_BULLETS = product.bullets.filter(b => {
      if (!b) return false;
      const t = b.toLowerCase();
      // 排名区：#848 in Patio, Lawn & Garden
      if (/^\s*#?\s*\d+\s*(?:in|on|for)\s+/.test(t)) return false;
      // 类目标签行："Patio, Lawn & Garden"（纯类目名，没有描述性内容）
      if (/^[a-z\s,&-]{3,40}$/.test(t) && /(patio|lawn|garden|outdoor|indoor|kitchen|bathroom|bedroom|living|office|car|truck|boat)/.test(t)) return false;
      // See Top / Best Sellers / Amazon Choice
      if (/see top|best sellers|amazon choice|best rank|best seller|see all/.test(t)) return false;
      // 过短（<15 字符）且不含动词的很可能是类目标签
      if (t.length < 15 && !/\b(is|for|with|that|keeps|made|works|comes|includes|provides|offers|featuring)\b/.test(t)) return false;
      return true;
    });

    const STOPWORDS = new Set([
      'with','your','that','this','have','from','were','what','when','how','why','who','which',
      'their','them','they','than','then','than','there','here','just','also','only','such',
      'into','over','after','before','about','under','between','through','while','because',
      'being','having','doing','getting','making','using','those','these','other','another',
      'plus','plus','free','best','most','more','less','new','old','good','great','easy',
      'fast','slow','high','low','full','half','part','whole','one','two','three','first','second','third',
      'every','each','any','all','some','many','much','few','lot','lots','pair','pairs',
    ]);
    // 典型组件名词 → 作为 autocomplete seed 会抓出大量无关词
    const COMPONENT_NOISE = /^(liquid|retina|chip|display|battery|camera|screen|touch|usb|c|wi|fi|wi-fi|gen|generation|rear|front|back|wide|ultra|true|tone|face|center|stage|cable|connector|port|slot|drive|card|dock|charger|adapter|keyboard|case|cover|pen|pencil|airpods|airtag|mouse|speaker|headset|trackpad)$/i;
    // 纯规格词：100w / 89.6wh / 200w / 32oz / 12gb → 作为 seed 只会抓出对应规格的所有品类
    const SPEC_NOISE = /^\d+[a-z]{1,4}$/i;
    // 太泛的通用形容词：portable / compact / lightweight / portable → 任何产品都能用
    const GENERIC_NOISE = /^(portable|compact|lightweight|mini|small|large|medium|big|heavy|thin|thick|flat|round|square|oval|wide|narrow|short|long|single|double|triple|basic|standard|premium|professional|personal|home|office|travel)$/i;
    const nounCounts = {};
    for (const b of CLEANED_BULLETS) {
      const tokens = b.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w =>
        w.length > 3 &&
        !STOPWORDS.has(w) &&
        !COMPONENT_NOISE.test(w) &&
        !SPEC_NOISE.test(w) &&
        !GENERIC_NOISE.test(w)
      );
      for (const t of tokens) nounCounts[t] = (nounCounts[t] || 0) + 1;
    }
    const topNouns = Object.entries(nounCounts).sort((a,b)=>b[1]-a[1]).slice(0, 3).filter(([w,c])=>c>=2).map(([w])=>w);
    for (const n of topNouns) add(n);
  }

  return out.slice(0, 5);  // 最多 5 个 seed，太多会稀释排名信号
}

// ====== 针对单个 ASIN 跑排名快照 ======
// 返回 { seeds, ranked:[{kw, rank, seed}] }，seed 标记该词是哪个 seed 下的 autocomplete 结果
async function snapshotAsinTrend(asin, marketplace) {
  // 先拿到 product 才能抽 seed——如果已经缓存过就用缓存
  const product = await (async () => {
    // 从 trendAsin 历史里拿上次存的 seeds 也行，但如果有 product 快照更准
    return null;  // 让调用方先 scrape 再传 seeds 进来
  })();
  return product;
}
async function runAsinSnapshot(asin, marketplace, product, limit = 20) {
  const seeds = extractSeedsFromProduct(product);
  if (!seeds.length) return { seeds: [], ranked: [] };

  const all = [];
  for (const seed of seeds) {
    try {
      const { ranked } = await crawlOne(seed, marketplace, limit);
      for (const r of ranked) all.push({ kw: r.kw, rank: r.rank, seed: seed.toLowerCase() });
    } catch {}
  }
  return { seeds, ranked: all };
}

// 脏词过滤：亚马逊 autocomplete 有时会把产品标题片段当 "suggestion" 返回
function isCleanKeyword(s) {
  if (!s) return false;
  // 1) 过短（单字、纯数字、纯标点）
  if (s.length < 2) return false;
  // 2) 过长（> 45 字符，正常搜索词一般 ≤ 20，标题才会这么长）
  if (s.length > 45) return false;
  // 3) 含产品型号符号：#、$、连续编号 cr-1009s / sw-fce75-ab
  if (/[#$]/.test(s)) return false;
  if (/\b[a-z]{2,}-\d{3,}[a-z0-9-]*\b/i.test(s)) return false;  // 型号 pattern
  // 4) 明显的非搜索词：< > | \ / @ { } [ ] 控制字符
  if (/[<>|\\@{}]/.test(s)) return false;
  // 5) 连续 3+ 空格或 tab
  if (/[ \t]{3,}/.test(s)) return false;
  // 6) 含 emoji（surrogate pair）
  if (/[\u{1F300}-\u{1FAFF}]/u.test(s)) return false;
  // 7) 英文 + 多数字（如 "water bottle 750ml cr-1009"）
  if (/\d{4,}/.test(s)) return false;
  return true;
}

// ===== 关键词富集：级别 / 核心词 / 限定词 / 问句 / 意图 =====
const QUESTION_STARTS = /^(what|how|can|which|when|why|where|who|does|do|is|are|will|should|would|could|i need|i want|looking for|find)\b/i;

function classifyLevel(text) {
  const words = text.trim().split(/\s+/);
  const hasNumbers = /\d/.test(text);
  const len = words.length;
  if (len <= 2 && !hasNumbers) return 0;
  if (len <= 3) return 1;
  if (len <= 5) return 2;
  if (len <= 8) return 3;
  return 4;
}

function isQuestionText(text) {
  if (QUESTION_STARTS.test(text)) return true;
  if (text.includes('?')) return true;
  // 隐含问句模式：best / top / review / vs / comparison / buy / cheap / deal / for beginners / for kids / for home / how to / near me / gift for / alternative / knockoff
  if (/^(best|top|how to|how do|how does|which|what|should i|must have)\b/i.test(text)) return true;
  if (/\b(best|top|review|comparison|compare|vs|versus|ranked|rated|recommend)\b/i.test(text)) return true;
  if (/\b(buy|cheap|cheapest|discount|deal|sale|affordable|worth it|need|must have)\b/i.test(text)) return true;
  if (/\bfor\s+(beginners|kids|boys|girls|women|men|teens|baby|elderly|senior|dog|cat|pets|home|travel|camping|office|school|bedroom|kitchen|living room|outdoor|gym|gaming)\b/i.test(text)) return true;
  if (/\b(how to clean|how to use|how to make|how to install|how to set up|how do|how does|how long|how much|how many)\b/i.test(text)) return true;
  if (/\b(near me|where to buy|local store|shop near)\b/i.test(text)) return true;
  if (/\bgift\s+(for|ideas|guide)\b/i.test(text)) return true;
  if (/\b(for starters|for dummies|for noobs)\b/i.test(text)) return true;
  if (/\b(alternative|knockoff|dupe|similar|like)\b/i.test(text)) return true;
  return false;
}

function extractCore(text, seeds) {
  const t = text.toLowerCase();
  // 1) 先匹配种子词中的完整短语（优先长的）
  const sortedSeeds = [...seeds].sort((a, b) => b.length - a.length);
  for (const s of sortedSeeds) {
    if (s && t.includes(s.toLowerCase())) return s.toLowerCase();
  }
  // 2) fallback：英文取前 1-2 词，中文取前 1-2 字（保守）
  const words = text.trim().split(/\s+/);
  if (words.length >= 2 && /^[a-z]/i.test(words[0])) return words[0] + ' ' + words[1];
  return words[0] || text;
}

function classifyIntent(text, isQ) {
  const t = text.toLowerCase();
  if (isQ) {
    if (/^(can|does|do|is|are|will|could)\b/i.test(text)) return 'Purchase'; // 能否能用/兼容
    if (/^(what|which|who|where)\b/i.test(text)) return 'FAQ';
    if (/^(how|why)\b/i.test(text)) return 'FAQ';
    return 'FAQ';
  }
  if (/\b(best|top|review|comparison|vs|versus)\b/.test(t)) return 'Comparison';
  if (/\b(buy|cheap|discount|sale|deal)\b/.test(t)) return 'Purchase';
  if (/\b(near me|store|shop)\b/.test(t)) return 'Purchase';
  return 'Informational';
}

// 从 text 中扣掉 core，剩下的就是 qualifier
function extractQualifier(text, core) {
  if (!core) return '';
  // 大小写不敏感替换第一个出现
  const re = new RegExp('\\b' + core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  const rest = text.replace(re, '').trim().replace(/\s+/g, ' ');
  return rest;
}

function enrichKeyword(text, seeds) {
  const level = classifyLevel(text);
  const isQ = isQuestionText(text);
  const core = extractCore(text, seeds);
  const qualifier = extractQualifier(text, core);
  const intent = classifyIntent(text, isQ);
  return { text, level, core, qualifier, isQuestion: isQ, qtype: isQ ? questionType(text) : null, intent };
}

// 问句细分：sentence = 用户真实问句（what/how/can/does/is…）；phrase = 买家意图短语（best/for kids/cheap…）
const SENTENCE_Q_START = /^(what|how|can|which|when|why|where|who|does|do|is|are|will|should|would|could|i need|i want|looking for|find)\b/i;
function questionType(text) {
  if (text.includes('?')) return 'sentence';
  if (SENTENCE_Q_START.test(text)) return 'sentence';
  if (/\b(does not|does it|can i|can you|should i|is it|will it|are they|that does|how to|how much|how many|how long|what size|what material)\b/i.test(text)) return 'sentence';
  return 'phrase';
}

// ===== SP-API 配置（从环境变量读取，绝不硬编码密钥） =====
const CFG = {
  lwaClientId: process.env.SP_API_LWA_CLIENT_ID || '',
  lwaClientSecret: process.env.SP_API_LWA_CLIENT_SECRET || '',
  lwaRefreshToken: process.env.SP_API_LWA_REFRESH_TOKEN || '',
  awsAccessKey: process.env.SP_API_AWS_ACCESS_KEY_ID || '',
  awsSecretKey: process.env.SP_API_AWS_SECRET_ACCESS_KEY || '',
  roleArn: process.env.SP_API_ROLE_ARN || '',
  region: process.env.SP_API_REGION || 'na',
  marketplaceId: process.env.SP_API_MARKETPLACE_ID || 'ATVPDKIKX0DER',
  keepaToken: process.env.KEEPA_TOKEN || '',
};

// Keepa domain 映射 (marketplace → Keepa domain id)
const KEEPA_DOMAINS = { US: 1, UK: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 7, ES: 8, IN: 9, MX: 10, BR: 11 };

// SP-API 端点与 AWS 签名 region 映射
const SP_API_HOSTS = {
  na: 'sellingpartnerapi-na.amazon.com',
  eu: 'sellingpartnerapi-eu.amazon.com',
  fe: 'sellingpartnerapi-fe.amazon.com',
};
const SP_API_AWS_REGIONS = { na: 'us-east-1', eu: 'eu-west-1', fe: 'us-west-2' };

// ===== 工具函数 =====
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function configStatus() {
  const keys = ['lwaClientId', 'lwaClientSecret', 'lwaRefreshToken', 'awsAccessKey', 'awsSecretKey', 'roleArn'];
  const configured = keys.filter((k) => CFG[k]);
  const missing = keys.filter((k) => !CFG[k]);
  return {
    ready: missing.length === 0,
    configuredCount: configured.length,
    total: keys.length,
    missing: missing.map((k) => ({ key: k, label: k.toUpperCase() })),
    region: CFG.region,
    marketplaceId: CFG.marketplaceId,
  };
}

// ===== AWS SigV4 签名 =====
function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}
function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function signV4({ method, host, pathAndQuery, service, region, body, accessKey, secretKey, sessionToken }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payload = body || '';
  const payloadHash = sha256Hex(payload);

  const canonicalHeaders = [`host:${host}`, `x-amz-date:${amzDate}`];
  if (sessionToken) canonicalHeaders.push(`x-amz-security-token:${sessionToken}`);
  canonicalHeaders.sort();
  const signedHeaders = canonicalHeaders.map((h) => h.split(':')[0]).join(';');

  const canonicalRequest = [
    method,
    pathAndQuery,
    '',
    canonicalHeaders.join('\n') + '\n',
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const headers = {
    host: host,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  return headers;
}

// ===== LWA Token =====
async function getLwaToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: CFG.lwaRefreshToken,
    client_id: CFG.lwaClientId,
    client_secret: CFG.lwaClientSecret,
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('LWA token 获取失败: ' + (data.error_description || data.error || res.status));
  }
  return data.access_token;
}

// ===== STS AssumeRole（获取临时 AWS 凭证用于 SP-API 签名） =====
async function assumeRole() {
  const host = 'sts.amazonaws.com';
  const params = new URLSearchParams({
    Action: 'AssumeRole',
    Version: '2011-06-15',
    RoleArn: CFG.roleArn,
    RoleSessionName: 'amazon-seller-tools',
    DurationSeconds: '3600',
  });
  const body = params.toString();
  const headers = signV4({
    method: 'POST', host, pathAndQuery: '/', service: 'sts', region: 'us-east-1',
    body, accessKey: CFG.awsAccessKey, secretKey: CFG.awsSecretKey,
  });
  headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetch('https://' + host + '/', { method: 'POST', headers, body });
  const text = await res.text();
  const mAccess = /<AccessKeyId>([^<]+)<\/AccessKeyId>/.exec(text);
  const mSecret = /<SecretAccessKey>([^<]+)<\/SecretAccessKey>/.exec(text);
  const mToken = /<SessionToken>([^<]+)<\/SessionToken>/.exec(text);
  if (!mAccess || !mSecret || !mToken) {
    const code = /<Code>([^<]+)<\/Code>/.exec(text);
    const msg = /<Message>([^<]+)<\/Message>/.exec(text);
    throw new Error('STS AssumeRole 失败: ' + ((code && code[1]) || 'Unknown') + ' - ' + ((msg && msg[1]) || text.slice(0, 300)));
  }
  return {
    accessKeyId: mAccess[1],
    secretAccessKey: mSecret[1],
    sessionToken: mToken[1],
  };
}

// ===== SP-API 请求 =====
async function spApiRequest(method, pathAndQuery, opts = {}) {
  const host = SP_API_HOSTS[CFG.region];
  const awsRegion = SP_API_AWS_REGIONS[CFG.region];
  const lwaToken = await getLwaToken();
  const creds = await assumeRole();
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  const headers = signV4({
    method, host, pathAndQuery, service: 'execute-api', region: awsRegion,
    body, accessKey: creds.accessKeyId, secretKey: creds.secretAccessKey, sessionToken: creds.sessionToken,
  });
  headers['x-amz-access-token'] = lwaToken;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch('https://' + host + pathAndQuery, { method, headers, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { _raw: text }; }
  return { status: res.status, body: json };
}

// ===== API 处理器 =====
async function handleApi(req, res, pathname, query) {
  // 健康检查
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }

  // 凭据配置状态（只返回是否配置，不返回密钥值）
  if (pathname === '/api/spapi/config') {
    return sendJson(res, 200, configStatus());
  }

  // 测试连接：拉取 marketplace 参与信息
  if (pathname === '/api/spapi/test') {
    try {
      const st = configStatus();
      if (!st.ready) {
        return sendJson(res, 400, { ok: false, error: '凭据未配置完整', missing: st.missing });
      }
      const result = await spApiRequest('GET', '/sellers/v1/marketplaceParticipations');
      return sendJson(res, result.status, { ok: result.status < 400, status: result.status, body: result.body });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 拉取订单（近 7 天）
  if (pathname === '/api/spapi/orders') {
    try {
      const st = configStatus();
      if (!st.ready) {
        return sendJson(res, 400, { ok: false, error: '凭据未配置完整', missing: st.missing });
      }
      const days = Math.min(30, parseInt(query.days || '7', 10) || 7);
      const createdAfter = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      const qs = '?MarketplaceIds=' + CFG.marketplaceId + '&CreatedAfter=' + encodeURIComponent(createdAfter);
      const result = await spApiRequest('GET', '/orders/v0/orders' + qs);
      return sendJson(res, result.status, { ok: result.status < 400, status: result.status, body: result.body });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ===== Brand Analytics 搜索词报告（真实 ABA 排名 + 搜索频率 + 点击份额） =====
  // 流程: createReport → getReport 轮询 → getReportDocument 下载 → 解析 TSV
  // 参考: https://developer-docs.amazon.com/sp-api/docs/reports-api-v2021-06-30-reference
  if (pathname === '/api/spapi/brand-search-terms') {
    try {
      const st = configStatus();
      if (!st.ready) {
        return sendJson(res, 400, { ok: false, error: 'SP-API 凭据未配置完整', missing: st.missing });
      }
      // 日期范围（默认最近 30 天）
      const days = Math.min(90, Math.max(7, parseInt(query.days || '30', 10) || 30));
      const dataEndDate = new Date().toISOString().slice(0, 10);
      const dataStartDate = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const marketplaceId = query.marketplaceId || CFG.marketplaceId;
      const sellerId = query.sellerId; // Brand Analytics 需要 sellerId（可选，SP-API 自己能推断）
      const asinFilter = (query.asin || '').trim().toUpperCase(); // 可选：只看这个 ASIN 相关的搜索词
      const keywordFilter = (query.keyword || '').trim().toLowerCase(); // 可选：关键词搜索

      // 1) 提交报告
      const createBody = {
        reportType: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
        marketplaceIds: [marketplaceId],
        dataStartDate,
        dataEndDate,
        reportOptions: {},
      };
      if (sellerId) createBody.sellerIds = [sellerId];
      const createRes = await spApiRequest('POST', '/reports/2021-06-30/reports', { body: createBody });
      if (createRes.status >= 400 || !createRes.body.reportId) {
        return sendJson(res, 400, { ok: false, step: 'createReport', status: createRes.status, body: createRes.body });
      }
      const reportId = createRes.body.reportId;

      // 2) 轮询报告状态（最多 2 分钟，10 秒间隔）
      let report = null;
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const gr = await spApiRequest('GET', '/reports/2021-06-30/reports/' + reportId);
        report = gr.body;
        if (report.processingStatus === 'DONE') break;
        if (report.processingStatus === 'FATAL' || report.processingStatus === 'CANCELLED') {
          return sendJson(res, 400, { ok: false, step: 'getReport', status: report.processingStatus, report });
        }
      }
      if (!report || report.processingStatus !== 'DONE') {
        return sendJson(res, 400, { ok: false, step: 'getReport', status: 'timeout', report });
      }

      // 3) 下载 document
      const docRes = await spApiRequest('GET', '/reports/2021-06-30/documents/' + report.reportDocumentId);
      const documentUrl = docRes.body.url;
      if (!documentUrl) {
        return sendJson(res, 400, { ok: false, step: 'getReportDocument', body: docRes.body });
      }

      // 4) 直接下载 TSV（Amazon 返回的是 gzip 压缩的 TSV，用 node zlib 解压）
      const { createGunzip } = require('zlib');
      const { Readable } = require('stream');
      const fetchRes = await fetch(documentUrl);
      const buf = Buffer.from(await fetchRes.arrayBuffer());
      // 解压 gzip
      const decompressed = await new Promise((resolve, reject) => {
        const gunzip = createGunzip();
        gunzip.on('data', chunk => chunks.push(chunk));
        gunzip.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        gunzip.on('error', reject);
        let chunks = [];
        Readable.from(buf).pipe(gunzip);
      });

      // 5) 解析 TSV
      const lines = decompressed.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) {
        return sendJson(res, 200, { ok: true, headers: [], items: [], note: '报告为空，可能这个时间段内 Brand Analytics 数据还未生成' });
      }
      const headers = lines[0].split('\t').map(h => h.trim());
      const idx = {}; // 找各列位置（Amazon 列名可能因站点略有不同，模糊匹配）
      const findIdx = (patterns) => headers.findIndex(h => patterns.some(p => new RegExp(p, 'i').test(h)));
      idx.term = findIdx(['^search term$', 'keyword term', 'query']);
      idx.abaRank = findIdx(['aba', 'brand analytics.*rank', 'search frequency rank']);
      idx.searchFreq = findIdx(['search frequency', 'frequency rank', 'search query performance']);
      idx.clickShare = findIdx(['click share', 'share of clicks']);
      idx.convShare = findIdx(['conversion share', 'share of conversions']);
      idx.products = findIdx(['products', 'asin.*in.*search']);

      const items = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split('\t');
        const kw = (cols[idx.term] || '').trim().toLowerCase();
        if (!kw) continue;
        // 可选过滤
        if (keywordFilter && !kw.includes(keywordFilter)) continue;
        if (asinFilter) {
          const ps = (cols[idx.products] || '').toUpperCase();
          if (!ps.includes(asinFilter)) continue;
        }
        items.push({
          keyword: kw,
          abaRank: idx.abaRank >= 0 ? parseInt(cols[idx.abaRank], 10) || null : null,
          searchFreq: idx.searchFreq >= 0 ? parseInt(cols[idx.searchFreq], 10) || null : null,
          clickShare: idx.clickShare >= 0 ? parseFloat(cols[idx.clickShare]) || null : null,
          convShare: idx.convShare >= 0 ? parseFloat(cols[idx.convShare]) || null : null,
        });
      }
      items.sort((a, b) => (a.abaRank ?? 999999) - (b.abaRank ?? 999999));

      return sendJson(res, 200, {
        ok: true,
        reportType: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
        dataStartDate, dataEndDate, marketplaceId,
        headers,
        itemCount: items.length,
        items: items.slice(0, 500), // 最多返回 500 条，避免 payload 太大
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message, stack: e.stack?.slice(0, 300) });
    }
  }

  // ===== Keepa API: 真实 BSR 排名 + 价格历史 + 180 天统计 =====
  if (pathname === '/api/keepa/product') {
    try {
      if (!CFG.keepaToken) {
        return sendJson(res, 400, { ok: false, error: 'Keepa Token 未配置 (环境变量 KEEPA_TOKEN)' });
      }
      const asin = (query.asin || '').toUpperCase().trim();
      if (!/^B0[A-Z0-9]{8}$/.test(asin)) {
        return sendJson(res, 400, { ok: false, error: '无效 ASIN 格式，应为 B0 开头 10 位' });
      }
      const marketplace = (query.marketplace || query.mkt || 'US').toUpperCase();
      const domain = KEEPA_DOMAINS[marketplace] || 1;
      const days = Math.min(365, Math.max(7, parseInt(query.days || '180', 10) || 180));

      const url = 'https://api.keepa.com/product' +
        '?key=' + CFG.keepaToken +
        '&domain=' + domain +
        '&asin=' + asin +
        '&stats=' + days +   // 直接拿解码后的 stats（avg/min/max/current）
        '&history=1' +        // 也拿时间序列（CSV 格式）
        '&offers=0';          // 不拿 offers（节省 token 配额）

      const resp = await fetch(url);
      if (resp.status >= 400) {
        const text = await resp.text();
        return sendJson(res, resp.status, { ok: false, error: 'Keepa API error', keepaStatus: resp.status, body: text.slice(0, 300) });
      }
      const data = await resp.json();
      const product = data.products?.[0];
      if (!product) {
        return sendJson(res, 404, { ok: false, error: 'Keepa 查不到这个 ASIN', asin });
      }

      // Keepa productType 快速检查（官方说一定要先看）
      // 0=STANDARD ✅  1=DOWNLOADABLE  2=EBOOK  3=INACCESSIBLE  4=INVALID ❌  5=VARIATION_PARENT
      const PTYPE_MSG = {
        0: 'STANDARD — 所有数据可访问',
        1: 'DOWNLOADABLE — 无可访问的价格/评分/offers',
        2: 'EBOOK — 无可访问的价格/评分/offers',
        3: 'INACCESSIBLE — 数据更新不频繁',
        4: 'INVALID — ASIN 无效或已废弃',
        5: 'VARIATION_PARENT — 这是父 ASIN，含 variations',
      };
      if (product.productType === 4) {
        return sendJson(res, 404, { ok: false, error: 'Keepa 标记此 ASIN 为 INVALID（已废弃或不存在）', asin, productType: 4 });
      }

      // ===== Keepa CSV 解码（差分编码） =====
      // Keepa CSV 格式是 [[type, timestamp, value], ...] 的 base64 + 自定义整数序列
      // 我们用 stats 字段（Keepa 已帮我们解好）+ 手动解 salesRank 历史
      const keepaDecode = (csv) => {
        if (!csv || !csv.length) return [];
        const out = [];
        let lastTimestamp = 0;
        let lastValue = 0;
        for (let i = 0; i < csv.length; i++) {
          const row = csv[i];
          if (!Array.isArray(row) || row.length < 3) continue;
          const [type, tsDelta, valDelta] = row;
          // Keepa: 第一个 timestamp 是绝对毫秒，后续是 delta
          const ts = i === 0 ? tsDelta : lastTimestamp + tsDelta;
          const val = i === 0 ? valDelta : lastValue + valDelta;
          out.push({ type, timestamp: ts, value: val });
          lastTimestamp = ts;
          lastValue = val;
        }
        return out;
      };

      // Keepa CSV type 常量
      const TYPE = {
        AMAZON_NEW_PRICE: 0,
        NEW_3RD_PARTY_PRICE: 1,
        USED_PRICE: 2,
        NEW_SALES_RANK: 3,        // ← 这个就是类目 BSR 排名
        USED_SALES_RANK: 4,
        AMAZON_OFFER_COUNT: 5,
        NEW_OFFER_COUNT: 6,
        USED_OFFER_COUNT: 7,
        NEW_FBM_PRICE: 10,
        NEW_FBA_PRICE: 11,
        NEW_FBA_SHIPPING: 12,
      };

      // 解各时间序列
      const priceHistory = keepaDecode(product.csvPrice || []);
      const rankHistory = keepaDecode(product.csv[TYPE.NEW_SALES_RANK] || []);
      const offerHistory = keepaDecode(product.csv[TYPE.NEW_OFFER_COUNT] || []);

      // 取当前 stats（Keepa stats 数组顺序 = CSV type 顺序）
      const stats = product.stats || {};
      const current = stats.current || [];  // 数组按 CSV type 顺序
      const avg180 = stats.avg180 || [];
      const min180 = stats.minInInterval || [];
      const max180 = stats.maxInInterval || [];

      // 把 rankHistory 转成 { date, bsr } 用于前端 sparkline
      const rankSeries = rankHistory
        .filter(r => r.type === TYPE.NEW_SALES_RANK && r.value > 0)
        .map(r => ({
          date: new Date(r.timestamp).toISOString().slice(0, 10),
          bsr: r.value,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // 取最新 BSR 快照
      const latestRank = rankSeries[rankSeries.length - 1];

      // 算 7 天 / 30 天排名变化
      const rankDelta = {};
      const daysAgo = (n) => {
        const cutoff = Date.now() - n * 86400000;
        for (let i = rankSeries.length - 1; i >= 0; i--) {
          if (new Date(rankSeries[i].date).getTime() <= cutoff) return rankSeries[i];
        }
        return rankSeries[0];
      };
      const rNow = latestRank?.bsr;
      const r7d = daysAgo(7)?.bsr;
      const r30d = daysAgo(30)?.bsr;
      rankDelta.now = rNow;
      rankDelta.d7 = r7d ? { rank: r7d, delta: rNow != null ? rNow - r7d : null } : null;
      rankDelta.d30 = r30d ? { rank: r30d, delta: rNow != null ? rNow - r30d : null } : null;

      return sendJson(res, 200, {
        ok: true,
        asin,
        marketplace,
        productType: product.productType,
        title: product.title,
        brand: product.brand,
        categoryTree: product.categoryTree,  // [{ name, categoryId }]
        mainImage: product.image || product.images?.[0],

        // ⭐ 关键销量指标（Keepa 真实估算，非 proxy）
        monthlySold: product.monthlySold || null,                    // 月销量估算
        monthlySoldHistory: (product.monthlySoldHistory || []).map((v, i) => ({ day: i, sold: v })),
        totalSold: product.monthlySold ? Math.round(product.monthlySold * 12) : null,   // 年销量估算

        // 时间戳（Keepa Time Minutes → ISO）
        lastUpdate: product.lastUpdate ? new Date(product.lastUpdate * 60000).toISOString() : null,
        trackingSince: product.trackingSince ? new Date(product.trackingSince * 60000).toISOString() : null,
        listedSince: product.listedSince ? new Date(product.listedSince * 60000).toISOString() : null,

        // 星级 / 评论
        rating: product.reviews?.rating || null,
        reviewCount: product.reviews?.reviewCount || null,

        current: {
          amazonPrice: current[0] != null ? current[0] / 100 : null,   // 分→美元
          newPrice: current[1] != null ? current[1] / 100 : null,
          usedPrice: current[2] != null ? current[2] / 100 : null,
          bsrNew: current[3] || null,           // 类目 BSR 排名
          bsrUsed: current[4] || null,
          amazonOffers: current[5] || null,
          newOffers: current[6] || null,         // 第三方卖家数
          usedOffers: current[7] || null,
        },
        avg: {
          amazonPrice: avg180[0] != null ? avg180[0] / 100 : null,
          newPrice: avg180[1] != null ? avg180[1] / 100 : null,
          bsrNew: avg180[3] || null,
          newOffers: avg180[6] || null,
        },
        min: {
          amazonPrice: min180[0] != null ? min180[0] / 100 : null,
          newPrice: min180[1] != null ? min180[1] / 100 : null,
          bsrNew: min180[3] || null,
        },
        max: {
          bsrNew: max180[3] || null,
        },
        rankDelta,          // { now, d7:{rank,delta}, d30:{rank,delta} }
        rankSeries,         // [{date, bsr}] 用于 sparkline
        priceHistory: priceHistory.slice(-30).map(p => ({   // 最近 30 天价格
          date: new Date(p.timestamp).toISOString().slice(0, 10),
          price: p.value / 100,
        })),
        offerCount: current[6] || null,
        statsIntervalDays: days,
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message, stack: e.stack?.slice(0, 400) });
    }
  }

  // Keepa token 状态检查
  if (pathname === '/api/keepa/status') {
    return sendJson(res, 200, {
      ok: true,
      configured: !!CFG.keepaToken,
      tokenPrefix: CFG.keepaToken ? CFG.keepaToken.slice(0, 4) + '...' : null,
      usageNote: 'Keepa 按 token 计费：product 端点每次 ~1 token，CSV 解码后返回 BSR + 价格历史 + 卖家数历史',
    });
  }
  if (pathname === '/api/alexa/insight') {
    try {
      const rawQ = query.seeds || query.q || query.prefix || '';
      if (!rawQ) return sendJson(res, 400, { ok: false, error: '缺少参数 q 或 seeds（关键词）' });
      const seeds = rawQ.split(/[|\n,，、;；]/).map(s => s.trim()).filter(Boolean).slice(0, 8);
      if (!seeds.length) return sendJson(res, 400, { ok: false, error: '关键词为空' });
      const marketplace = (query.marketplace || query.mkt || 'US').toUpperCase();
      const limit = parseInt(query.limit || '15', 10) || 15;
      const expand = query.expand === '1' || query.expand === 'true';

      const result = await runInsight({ seeds, marketplace, limit, expand });
      result.host = (AMAZON_SUGGEST_HOST[marketplace] || AMAZON_SUGGEST_HOST.US).host;
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // Alexa 缓存读取：返回后台定时刷新的聚合数据
  if (pathname === '/api/alexa/cached') {
    const force = query.refresh === '1' || query.refresh === 'true';
    if (force) { refreshAlexaCache(); } // 异步触发，不等
    const cache = alexaCache;
    if (!cache.data) {
      return sendJson(res, 202, { ok: false, status: cache.status, message: '缓存尚未就绪，首次抓取中…', updatedAt: cache.updatedAt });
    }
    return sendJson(res, 200, { ok: true, cache: cache.data, updatedAt: cache.updatedAt, status: cache.status, durationMs: cache.durationMs });
  }

  // 手动触发一次缓存刷新（同步等待完成，最多 120s）
  if (pathname === '/api/alexa/refresh') {
    try {
      if (cacheRefreshing) return sendJson(res, 200, { ok: true, alreadyRefreshing: true, updatedAt: alexaCache.updatedAt });
      await Promise.race([
        refreshAlexaCache(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 120000)),
      ]);
      return sendJson(res, 200, { ok: true, updatedAt: alexaCache.updatedAt, status: alexaCache.status, durationMs: alexaCache.durationMs });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ===== 辅助：对比两次快照 =====
  // currRanked / prevRanked 每项都应该是 { kw, rank, seed? }
  function compareSnapshots(currRanked, prevRanked, extra = {}) {
    // 把 kw -> { rank, seed } 存起来，别丢 seed
    const currMap = new Map();
    for (const r of currRanked || []) currMap.set(r.kw.toLowerCase(), { rank: r.rank, seed: r.seed || null });
    const prevMap = new Map();
    for (const r of prevRanked || []) prevMap.set(r.kw.toLowerCase(), { rank: r.rank, seed: r.seed || null });

    const items = [];
    for (const [kw, cur] of currMap) {
      const prev = prevMap.has(kw) ? prevMap.get(kw) : null;
      const isNew = prev == null;
      // seed 优先用当前快照的，没有就用之前快照的
      const seed = cur.seed || (prev && prev.seed) || null;
      items.push({
        keyword: kw,
        seed,
        rankNow: cur.rank,
        rankPrev: isNew ? null : prev.rank,
        delta: isNew ? null : cur.rank - prev.rank,
        isNew, isGone: false,
        ...extra,
      });
    }
    for (const [kw, prev] of prevMap) {
      if (!currMap.has(kw)) {
        items.push({
          keyword: kw,
          seed: prev.seed || null,
          rankNow: null,
          rankPrev: prev.rank,
          delta: null,
          isNew: false, isGone: true,
          ...extra,
        });
      }
    }
    return items;
  }

  // 西柚找词风格：ABA 排名 / 热度变化监控
  // query.asin 为空时返回全局 seed 趋势；指定 asin 时返回该 ASIN 的流量词涨跌
  if (pathname === '/api/alexa/trend') {
    const targetAsin = (query.asin || '').trim().toUpperCase();
    const targetMarket = (query.marketplace || 'US').toUpperCase();

    // ==== 按 ASIN 查看（西柚找词核心） ====
    if (targetAsin && /^[A-Z0-9]{10}$/.test(targetAsin)) {
      const asinHistory = alexaCache.trendAsin?.[targetAsin]?.[targetMarket] || [];
      if (!asinHistory.length) {
        return sendJson(res, 200, { ok: true, scope: 'asin', asin: targetAsin, marketplace: targetMarket, updatedAt: null, items: [], note: '暂无该 ASIN 的排名历史，可手动查询一次触发快照（/api/asin/' + targetAsin + '?trend=1），或等待后台每 3 小时自动刷新' });
      }
      const curr = asinHistory[asinHistory.length - 1];
      const prev = asinHistory.length >= 2 ? asinHistory[asinHistory.length - 2] : null;
      const items = compareSnapshots(curr.ranked, prev ? prev.ranked : null, { asin: targetAsin, marketplace: targetMarket });

      const rankedItems = items.filter(i => !i.isNew && !i.isGone);
      // rising = delta < 0（rank 变小 = 排名上升 = 热度涨了）
      const risingItems = rankedItems.filter(i => i.delta != null && i.delta < 0).sort((a, b) => a.delta - b.delta);
      // falling = delta > 0（rank 变大 = 排名下降 = 热度跌了）
      const fallingItems = rankedItems.filter(i => i.delta != null && i.delta > 0).sort((a, b) => b.delta - a.delta);
      const newItems = items.filter(i => i.isNew);
      const goneItems = items.filter(i => i.isGone);

      // 按 seed 分组（该词是从哪个 seed 的 autocomplete 来的）
      const perSeed = {};
      for (const it of items) {
        const seed = it.seed || 'unknown';
        if (!perSeed[seed]) perSeed[seed] = [];
        perSeed[seed].push(it);
      }

      return sendJson(res, 200, {
        ok: true, scope: 'asin',
        asin: targetAsin, marketplace: targetMarket,
        updatedAt: curr.time, prevUpdatedAt: prev ? prev.time : null,
        seeds: curr.seeds,
        snapshotCount: asinHistory.length,
        latestCount: items.length,
        rising: risingItems.slice(0, 30),
        falling: fallingItems.slice(0, 30),
        newKeywords: newItems.slice(0, 30),
        goneKeywords: goneItems.slice(0, 30),
        perSeed,
      });
    }

    // ==== 全局 seed 趋势（兼容旧 API） ====
    const trendCache = alexaCache.trend;
    if (!trendCache) {
      return sendJson(res, 200, { ok: true, scope: 'global', trendUpdatedAt: null, items: [], note: '暂无排名历史，首次运行后每 3 小时刷新一次快照' });
    }
    const hours = Math.floor(REFRESH_INTERVAL_MS / 3600000);
    const items = [];
    const perSeed = {};
    for (const mkt of Object.keys(trendCache)) {
      for (const seed of Object.keys(trendCache[mkt])) {
        const history = trendCache[mkt][seed];
        if (history.length === 0) continue;
        const curr = history[history.length - 1];
        const prev = history.length >= 2 ? history[history.length - 2] : null;
        const seedItems = compareSnapshots(curr.ranked, prev ? prev.ranked : null, { seed, marketplace: mkt });
        items.push(...seedItems);
        perSeed[seed] = seedItems;
      }
    }
    const rankedItems = items.filter(i => !i.isNew && !i.isGone);
    const risingItems = rankedItems.filter(i => i.delta != null && i.delta < 0).sort((a, b) => a.delta - b.delta);
    const fallingItems = rankedItems.filter(i => i.delta != null && i.delta > 0).sort((a, b) => b.delta - a.delta);
    const newItems = items.filter(i => i.isNew);
    const goneItems = items.filter(i => i.isGone);
    return sendJson(res, 200, {
      ok: true, scope: 'global',
      trendUpdatedAt: alexaCache.trendUpdatedAt, trendLastError: alexaCache.trendLastError,
      refreshIntervalHours: hours,
      rising: risingItems.slice(0, 30),
      falling: fallingItems.slice(0, 30),
      newKeywords: newItems.slice(0, 30),
      goneKeywords: goneItems.slice(0, 30),
      perSeed,
    });
  }

  // ===== 监控管理：动态注册/删除要跟踪的 ASIN =====
  // GET    /api/alexa/monitor              → 列出当前监控的 ASIN
  // POST   /api/alexa/monitor              → 添加 { asin, marketplace } 到监控列表
  // DELETE /api/alexa/monitor?asin=XXX     → 从监控列表移除
  if (pathname === '/api/alexa/monitor') {
    try {
      const method = req.method.toUpperCase();
      if (method === 'GET') {
        const asinsNow = MONITOR_ASINS.map(a => ({ asin: a.asin, marketplace: a.marketplace, hasHistory: !!(alexaCache.trendAsin[a.asin] && alexaCache.trendAsin[a.asin][a.marketplace] && alexaCache.trendAsin[a.asin][a.marketplace].length) }));
        return sendJson(res, 200, { ok: true, count: MONITOR_ASINS.length, asins: asinsNow });
      }
      if (method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        await new Promise(r => req.on('end', r));
        let payload;
        try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
        const asin = String(payload.asin || query.asin || '').toUpperCase();
        const marketplace = String(payload.marketplace || query.marketplace || 'US').toUpperCase();
        if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return sendJson(res, 400, { ok: false, error: 'ASIN 格式无效（应为 10 位大写字母数字）' });
        const exists = MONITOR_ASINS.find(a => a.asin === asin && a.marketplace === marketplace);
        if (exists) return sendJson(res, 200, { ok: true, alreadyExists: true, asins: MONITOR_ASINS });
        MONITOR_ASINS.push({ asin, marketplace });
        return sendJson(res, 200, { ok: true, added: { asin, marketplace }, asins: MONITOR_ASINS });
      }
      if (method === 'DELETE') {
        const asin = String(query.asin || '').toUpperCase();
        const marketplace = String(query.marketplace || 'US').toUpperCase();
        const before = MONITOR_ASINS.length;
        MONITOR_ASINS = MONITOR_ASINS.filter(a => !(a.asin === asin && a.marketplace === marketplace));
        return sendJson(res, 200, { ok: true, removed: before - MONITOR_ASINS.length, asins: MONITOR_ASINS });
      }
      return sendJson(res, 405, { ok: false, error: 'Method not allowed (use GET / POST / DELETE)' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // 仪表盘聚合数据：首页用
  if (pathname === '/api/dashboard') {
    const a = alexaCache;
    const st = configStatus();
    const hours = Math.floor(REFRESH_INTERVAL_MS / 3600000);
    const nextAt = a.updatedAt ? new Date(new Date(a.updatedAt).getTime() + REFRESH_INTERVAL_MS).toISOString() : null;
    return sendJson(res, 200, {
      ok: true,
      refreshIntervalHours: hours,
      nextRefreshAt: nextAt,
      alexa: a.data ? {
        total: a.data.stats.total,
        questions: a.data.stats.questions,
        levelCounts: a.data.stats.levelCounts,
        topCores: Object.entries(a.data.stats.coreCounts).sort((x,y)=>y[1]-x[1]).slice(0,6),
        intents: a.data.stats.intentCounts,
        requests: a.requests,
        durationMs: a.durationMs,
      } : null,
      alexaUpdatedAt: a.updatedAt,
      alexaStatus: a.status,
      trendUpdatedAt: a.trendUpdatedAt,
      trendLastError: a.trendLastError,
      spapiReady: st.ready,
      spapiConfigured: st.configuredCount + '/' + st.total,
      serverTime: new Date().toISOString(),
    });
  }


// ===== ASIN 产品分析 =====
const ASIN_HOSTS = { US: 'amazon.com', UK: 'amazon.co.uk', DE: 'amazon.de', FR: 'amazon.fr', IT: 'amazon.it', ES: 'amazon.es', JP: 'amazon.co.jp', CA: 'amazon.ca' };

// 全局节流：每个 marketplace 至少间隔 3 秒，防止触发 Amazon 反爬
const _asinLastCall = {};
async function throttleAsin(marketplace) {
  const now = Date.now();
  const last = _asinLastCall[marketplace] || 0;
  const wait = Math.max(0, 3000 - (now - last));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _asinLastCall[marketplace] = Date.now();
}
const ASIN_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function cleanHtml(s) { return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(); }

async function fetchAsinPage(asin, marketplace) {
  // 先节流，防止 IP 被 block
  await throttleAsin(marketplace);

  const host = ASIN_HOSTS[marketplace] || ASIN_HOSTS.US;
  const url = 'https://www.' + host + '/dp/' + asin;

  // 验证码检测关键词
  const CAPTCHA_SIGNS = [
    /robot check/i, /captcha/i, /enter the characters/i,
    /sorry..we just need to make sure/i, /Enter the characters below/i,
    /type the characters you see in this image/i,
  ];
  const isCaptcha = (html) => {
    if (!html || html.length < 50000) return true;
    return CAPTCHA_SIGNS.some(re => re.test(html));
  };

  // 最多尝试 3 次，每次换 UA + 随机延迟
  const MAX_TRIES = 3;
  let lastResult = { url, host, status: 0, html: '' };

  for (let tryIdx = 0; tryIdx < MAX_TRIES; tryIdx++) {
    // 每次换一个新 UA
    const ua = ASIN_UAS[(Math.floor(Math.random() * ASIN_UAS.length) + tryIdx) % ASIN_UAS.length];

    // 尝试间随机延迟（第 1 次不延迟，后续 1.5-3.5s）
    if (tryIdx > 0) {
      const delay = 1500 + Math.floor(Math.random() * 2000);
      await new Promise(r => setTimeout(r, delay));
    }

    // Step 1: 访问首页拿 Cookie
    const cookieJar = new Map();
    try {
      const homeRes = await fetch('https://www.' + host + '/', {
        headers: {
          'User-Agent': ua,
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
        },
        redirect: 'follow', signal: AbortSignal.timeout(15000),
      });
      const setCookies = homeRes.headers.getSetCookie ? homeRes.headers.getSetCookie() : (homeRes.headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z])/);
      setCookies.forEach(c => {
        const m = (c || '').trim().match(/^([^=]+)=([^;]+)/);
        if (m) cookieJar.set(m[1], m[2]);
      });
    } catch (e) { /* 首页失败不致命 */ }

    // Step 2: 带 Cookie 访问产品页
    const cookieStr = [...cookieJar.entries()].map(([k, v]) => k + '=' + v).join('; ') || 'i18n-prefs=USD; lc-main=en_US';
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache', 'Pragma': 'no-cache',
          'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1', 'DNT': '1',
          'Cookie': cookieStr, 'Referer': 'https://www.' + host + '/',
        },
        redirect: 'follow', signal: AbortSignal.timeout(30000),
      });
      const html = await r.text();
      lastResult = { url, host, status: r.status, html };

      // 如果不是验证码，直接返回
      if (!isCaptcha(html)) return lastResult;
      // 是验证码 -> 继续重试
      lastResult.error = 'captcha';
    } catch (e) {
      lastResult = { url, host, status: 0, html: '', error: e.message };
    }
  }

  // 3 次都挂了，返回最后一次结果
  return lastResult;
}

function parseAsinProduct(html, asin, marketplace) {
  if (!html || html.length < 50000) return null;
  const result = { asin, marketplace, host: ASIN_HOSTS[marketplace] || 'amazon.com' };

  // 1. Title
  const tm = html.match(/<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/i);
  result.title = cleanHtml(tm?.[1]);

  // 2. Product Details 表格（先构建，brand 会用到）
  const details = {};
  [...html.matchAll(/<tr[^>]*class="[^"]*po-[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)].forEach(m => {
    const cells = [...m[0].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map(x => cleanHtml(x[1]));
    if (cells.length >= 2 && cells[0] && cells[1]) details[cells[0]] = cells[1];
  });
  [...html.matchAll(/<li[^>]*class="[^"]*detail-bullet[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)].forEach(m => {
    const label = cleanHtml(m[0].match(/<span[^>]*class="a-text-bold"[^>]*>([\s\S]*?)<\/span>/)?.[1]).replace(/:$/, '');
    const val = cleanHtml(m[0].replace(/<span[^>]*class="a-text-bold"[^>]*>[\s\S]*?<\/span>/g, ''));
    if (label && val && !details[label]) details[label] = val;
  });
  result.details = details;

  // 3. Brand - 优先从 Product Details 表格拿（最可靠）
  let brand = null;
  const dk = Object.keys(details);
  const brandKey = dk.find(k => /^Brand$/i.test(k));
  if (brandKey) brand = details[brandKey];
  if (!brand) {
    const bm3 = html.match(/Visit the\s+([A-Za-z0-9][\w\s\-.,&+]{1,30}?)\s+Store/i);
    if (bm3) brand = bm3[1].trim();
  }
  if (!brand) {
    const bm = html.match(/<a[^>]*id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/i);
    if (bm) {
      const allText = [...bm[0].matchAll(/>([^<]+)</g)].map(m => m[1].trim()).filter(Boolean);
      brand = allText.join(' ').replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').trim();
    }
  }
  result.brand = brand || null;

  // 4. Stars / Rating
  const sm = html.match(/a-icon-alt[^>]*>([0-9.]+) out of 5 stars/i);
  result.stars = sm ? parseFloat(sm[1]) : null;

  // 5. Reviews count
  let reviewsNum = null;
  const rm = html.match(/id="acrCustomerReviewText"[^>]*>([\s\S]*?)<\/span>/i);
  if (rm) {
    const m = cleanHtml(rm[1]).replace(/[\s,]/g, '').match(/(\d+)/);
    if (m) reviewsNum = parseInt(m[1], 10);
  }
  if (!reviewsNum) {
    const rm2 = html.match(/([\d,]+)\s+ratings?/i);
    if (rm2) reviewsNum = parseInt(rm2[1].replace(/,/g, ''), 10);
  }
  result.reviews = reviewsNum;

  // 6. Bullets 卖点
  const bullets = [];
  [...html.matchAll(/<span[^>]*class="a-list-item"[^>]*>([\s\S]*?)<\/span>/gi)].forEach(m => {
    const t = cleanHtml(m[1]);
    if (t && t.length > 15 && t.length < 300 && !/^(Image|›|Visit|©|‹|•|Learn|See|Details|Compare|Explore|Share|Help|Amazon|Add to|Free|Prime|Ship|Sold|Available|Buy|Order|Package|Includes|Quantity|Units?|›)/i.test(t) && !t.includes('›')) bullets.push(t);
  });
  result.bullets = bullets.slice(0, 8);

  // 7. 主图
  const imgs = [...new Set([
    ...([...html.matchAll(/data-old-hires="([^"]+)"/gi)].map(m => m[1])),
    ...([...html.matchAll(/data-a-dynamic-image='([^']+)'/gi)].map(m => { try { const j = JSON.parse(m[1]); return Object.keys(j)[0]; } catch { return null; } })).filter(Boolean),
  ])];
  result.mainImage = imgs[0] || null;

  // 8. Category breadcrumb - 只用 breadcrumb_widget 里的
  const breadcrumbBlock = html.match(/id="wayfinding-breadcrumb_feature_div"[\s\S]*?<\/div>\s*<\/div>/i);
  let cats = [];
  if (breadcrumbBlock) {
    cats = [...breadcrumbBlock[0].matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map(m => m[1].trim())
      .filter(t => t && t.length > 1 && t.length < 50 && !/›/.test(t));
  } else {
    cats = [...html.matchAll(/<a[^>]*class="a-breadcrumb-link[^"]*"[^>]*>([^<]+)<\/a>/gi)].map(m => m[1].trim());
  }
  if (!cats.length) {
    cats = [...html.matchAll(/href="\/b\/[^"]*"[^>]*>([^<]+)<\/a>/gi)].map(m => m[1].trim())
      .filter(t => t && t.length > 2 && t.length < 50 && !/^(Visit|Learn|Page|Amazon|Back|More)/i.test(t) && !/^\d/.test(t));
  }
  const seenC = new Set();
  const CAT_BLACKLIST = /^(sell|sells|on amazon|amazon|amazon\.com|feedback|customer service|help|sign in|account|returns|registry|gift cards|coupons|prime|whole foods|conditions of use|privacy notice)$/i;
  cats = cats.filter(c => {
    const t = c.trim();
    if (!t || CAT_BLACKLIST.test(t)) return false;
    if (seenC.has(t)) return false;
    seenC.add(t);
    return true;
  }).slice(0, 6);
  result.categories = cats;

  // 9. 卖家 / Buybox 信息
  let seller = null;
  const m1 = html.match(/id="merchant-info"[\s\S]{0,1000}/i);
  if (m1) {
    const sm = m1[0].match(/<a[^>]*>([^<]+)<\/a>/);
    if (sm) seller = sm[1].trim();
  }
  if (!seller) {
    const m2 = html.match(/Sold by\s+([^<]+?)\s*(?:\(|$)/i);
    if (m2) seller = m2[1].trim();
  }
  if (!seller && result.brand) seller = result.brand + ' (Brand Store)';
  result.seller = seller;
  const isFBA = /Fulfilled by Amazon/i.test(html) || /Ships from Amazon/i.test(html);
  result.isFBA = isFBA;

  // 10. Sales Rank — 结构化！拆成 bsr（数字）+ bsrCategory（类目）
  let bsr = null;
  let bsrCategory = null;
  const sr = html.match(/Best Sellers Rank[^>]*>([\s\S]{0,500})/i);
  const srText = cleanHtml(sr?.[1]) || '';
  // 匹配 "#1,234 in Patio, Lawn & Garden" 或 "#123 in Electronics"
  const bsrMatch = srText.match(/#([\d,]+)\s+in\s+([^\n]+?)(?:\s*\(|$)/i);
  if (bsrMatch) {
    bsr = parseInt(bsrMatch[1].replace(/,/g, ''), 10);
    bsrCategory = bsrMatch[2].trim();
  } else {
    // fallback: 第一个 #数字 in 后面的类目
    const bsrFallback = srText.match(/#([\d,]+)\s+in\s+([^&\n]+)/i);
    if (bsrFallback) {
      bsr = parseInt(bsrFallback[1].replace(/,/g, ''), 10);
      bsrCategory = bsrFallback[2].trim();
    }
  }
  result.salesRank = srText.slice(0, 200) || null;
  result.bsr = bsr;                    // 真实类目 BSR 排名（数字，越小越好）
  result.bsrCategory = bsrCategory;    // 所属类目名

  // ===== 价格策略：多路径抓取 =====
  let priceAmazon = null;
  let priceThird = null;
  let priceCurrent = null;

  // 路径 1：a-offscreen span（常见，可能被 bot 过滤）
  const offscreenPrices = [...html.matchAll(/<span[^>]*class="a-offscreen[^"]*"[^>]*>\$?([\d,]+\.?\d*)<\/span>/gi)]
    .map(m => parseFloat(m[1].replace(/,/g, '')))
    .filter(n => !isNaN(n) && n > 0);

  // 路径 2：corePrice_feature_div 附近的价格（如果没被 bot strip）
  if (!priceAmazon) {
    const coreBlock = html.match(/id="corePrice(?:_feature_div|Display_desktop_feature_div)?"[\s\S]{0,5000}/i);
    if (coreBlock) {
      const inCore = [...coreBlock[0].matchAll(/\$([\d,]+\.?\d*)/gi)]
        .map(m => parseFloat(m[1].replace(/,/g, '')))
        .filter(n => !isNaN(n) && n > 0);
      if (inCore.length) priceAmazon = Math.min(...inCore);
    }
  }

  // 路径 3：a-price-whole + a-price-fraction 组合（新 Amazon DOM）
  if (!priceAmazon) {
    // 找所有 a-price 容器，组合 whole + fraction
    const priceContainers = [...html.matchAll(/<span[^>]*class="a-price[^"]*"[^>]*>([\s\S]{0,300}?)<\/span>/gi)];
    const containerPrices = [];
    for (const c of priceContainers) {
      const wholeM = c[1].match(/class="a-price-whole[^"]*"[^>]*>([\d,]+)/i);
      const fracM = c[1].match(/class="a-price-fraction[^"]*"[^>]*>(\d+)/i);
      if (wholeM) {
        const whole = parseFloat(wholeM[1].replace(/,/g, ''));
        const frac = fracM ? parseFloat('.' + fracM[1]) : 0;
        const v = whole + frac;
        if (v > 0 && v < 50000) containerPrices.push(v);
      }
    }
    if (containerPrices.length) priceAmazon = Math.min(...containerPrices);
  }

  // 路径 4：全局直接搜 $XX.XX 模式（兜底）
  if (!priceAmazon) {
    const allDollarMatches = [...html.matchAll(/\$([\d,]+\.\d{2})/gi)]
      .map(m => parseFloat(m[1].replace(/,/g, '')))
      .filter(n => !isNaN(n) && n > 0 && n < 20000);
    if (allDollarMatches.length) {
      // 过滤掉 bundle/MSRP：取最小的
      priceAmazon = Math.min(...allDollarMatches);
    }
  }

  // 路径 5：offscreen prices 兜底（如果上面都没命中）
  if (!priceAmazon && offscreenPrices.length) {
    priceAmazon = Math.min(...offscreenPrices);
    // 如果还是 bundle 价（>=1000），排除最大 2 个再取 min
    if (priceAmazon >= 1000 && offscreenPrices.length >= 3) {
      const sorted = [...new Set(offscreenPrices)].sort((a,b) => a - b);
      priceAmazon = Math.min(...sorted.slice(0, Math.max(1, sorted.length - 2)));
    }
  }

  // 第三方最低价
  const lpBlock = html.match(/id="lowestPrice[^"]*"[\s\S]{0,2000}/i);
  if (lpBlock) {
    const lpSpans = [...lpBlock[0].matchAll(/<span[^>]*class="a-offscreen[^"]*"[^>]*>[$]?([\d,]+\.?\d*)<\/span>/gi)];
    const lpPrices = lpSpans.map(m => parseFloat(m[1].replace(/,/g, ''))).filter(n => !isNaN(n) && n > 0);
    if (lpPrices.length) priceThird = Math.min(...lpPrices);  // 取最低价
  }
  if (!priceThird) {
    const thirdDeal = html.match(/id="priceblock_dealprice"[^>]*>[\s\S]*?\$?([\d,]+\.?\d*)/i);
    if (thirdDeal) priceThird = parseFloat(thirdDeal[1].replace(/,/g, '')) || null;
  }

  // 0 值保护
  if (priceAmazon === 0) priceAmazon = null;
  if (priceThird === 0) priceThird = null;
  priceCurrent = priceAmazon || priceThird || null;
  result.priceAmazon = priceAmazon;
  result.priceThird = priceThird;
  result.priceCurrent = priceCurrent;

  // 10c. 卖家数（第三方 NEW offers 数量）
  let sellerCount = null;
  // "N more buying choices" / "N&hellip; other sellers" / "N sellers"
  const sellerPatterns = [
    /(\d+)\s+more\s+buying\s+choices/i,
    /(\d+)(?:,[\d]{3})*\s+other\s+sellers/i,
    /from\s+(\d+)\s+sellers/i,
    /(\d+)\s+sellers?\s+available/i,
    /(\d+)(?:,[\d]{3})*\s+offers?\s+from/i,
    /(\d{1,3}(?:,\d{3})*)\s+in\s+stock/i,
  ];
  for (const pat of sellerPatterns) {
    const m = html.match(pat);
    if (m) { sellerCount = parseInt(m[1].replace(/,/g, ''), 10); break; }
  }
  if (sellerCount != null && /more buying/i.test(html)) sellerCount += 1;
  result.sellerCount = sellerCount;

  // 11. 从 title + bullets 里提取关键词种子（去噪音）
  const NOISE = /^(with|the|and|for|from|that|this|your|our|has|but|not|are|was|were|all|any|both|each|few|more|most|other|some|such|than|too|very|can|will|just|into|also|over|under|plus|minus|like|need|want|make|take|use|get|set|put|let|say|may|new|old|good|best|great|well|back|down|high|low|last|next|same|different|right|left|page|book|set|kit|pack|pair|item|product|include|includes|package|quantity|count|size|type|model|style|color|material|feature|features|without|comes|come|buy|order|free|prime|ship|shipping|seller|sold|available|limited|while|since|because|though|although|whether|however|therefore|otherwise|connect|connection|use|using|used|support|supports|compatible|includes|including|featuring|designed|designed|quality|premium|original|genuine|official|authentic)$/i;
  const seedWords = new Set();
  const srcText = [result.title, ...(result.bullets || [])].filter(Boolean).join(' ').toLowerCase();
  srcText.split(/[\s,()\-.:;&\/“”‘’]+/).forEach(w => {
    if (w.length < 3 || w.length > 18) return;
    if (/^\d+$/.test(w)) return;
    if (NOISE.test(w)) return;
    if (/^(inch|inches|cm|mm|oz|lb|lbs|ml|l|g|kg|tb|gb|mb|hz|khz|ghz|v|w|ah|mah)$/.test(w)) return;
    seedWords.add(w);
  });
  result.seedWords = [...seedWords].slice(0, 20);

  // 12. Alexa 种子词：品牌 + 产品短语 + 类目短语（短语比单词更接近真实搜索）
  const alexaSeeds = [];
  const addSeed = (s) => {
    const v = String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (v && v.length >= 3 && !alexaSeeds.includes(v)) alexaSeeds.push(v);
  };
  if (result.brand) addSeed(result.brand);
  const titleWords = String(result.title || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !NOISE.test(w) &&
      !/^(the|and|for|with|from|this|that|you|your|inch|inches|generation|gen|new|latest|model)$/.test(w));
  if (titleWords.length >= 2) addSeed(titleWords.slice(0, 2).join(' '));
  if (titleWords.length >= 3) addSeed(titleWords.slice(0, 3).join(' '));
  if (titleWords.length >= 4) addSeed(titleWords.slice(0, 4).join(' '));
  const catList = Array.isArray(result.categories) ? result.categories : [];
  if (catList.length) addSeed(catList[catList.length - 1]);
  [...seedWords].forEach(w => { if (alexaSeeds.length < 5) addSeed(w); });
  result.alexaSeeds = alexaSeeds.slice(0, 5);

  return result;
}

// ===== Listing 关键词反查：ASIN → 真实搜索词（含覆盖检查所需字段） =====
const kwCache = new Map();
if (pathname === '/api/listing/keywords') {
  const rawSeeds = String(query.seeds || '').trim();
  const asin = String(query.asin || '').trim().toUpperCase();
  const marketplace = (query.marketplace || 'US').toUpperCase();
  const limit = Math.max(10, Math.min(50, parseInt(query.limit || '20', 10) || 20));
  if (!rawSeeds && !/^[A-Z0-9]{10}$/.test(asin)) {
    return sendJson(res, 400, { ok: false, error: '请输入 10 位 ASIN，或直接填入种子词' });
  }
  const key = (asin || 'seeds') + '|' + rawSeeds + '|' + marketplace + '|' + limit;
  const hit = kwCache.get(key);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) {
    return sendJson(res, 200, { ok: true, cached: true, ...hit.data });
  }
  try {
    const t0 = Date.now();
    let seeds = rawSeeds ? rawSeeds.split(/[|\n,，、;；]/).map(s => s.trim()).filter(Boolean).slice(0, 5) : [];
    let product = null;
    if (!seeds.length) {
      const { html, host, status, url } = await fetchAsinPage(asin, marketplace);
      if (status !== 200 || html.length < 50000) {
        return sendJson(res, 200, { ok: false, error: 'ASIN 页面未能有效加载（可能触发验证码），请稍后再试', host, url });
      }
      const p = parseAsinProduct(html, asin, marketplace);
      if (!p || !p.title) {
        return sendJson(res, 200, { ok: false, error: '未能解析出产品信息，请确认 ASIN 或站点是否正确' });
      }
      seeds = (p.alexaSeeds || []).slice(0, 5);
      product = {
        asin: p.asin, title: p.title, brand: p.brand || '', stars: p.stars,
        reviews: p.reviews, categories: p.categories || [], mainImage: p.mainImage || '',
      };
    }
    if (!seeds.length) {
      return sendJson(res, 200, { ok: false, error: '未能从 ASIN 生成种子词，请手动填入 1–5 个种子词' });
    }
    const insight = await runInsight({ seeds, marketplace, limit, expand: true });
    const keywords = insight.keywords.map(k => ({
      text: k.text, level: k.level, core: k.core || '', intent: k.intent || '',
      isQuestion: !!k.isQuestion, qtype: k.qtype || '',
    }));
    const data = {
      asin, product, seeds, marketplace, keywords,
      stats: insight.stats, requests: insight.requests, fetchedAt: new Date().toISOString(),
    };
    kwCache.set(key, { ts: Date.now(), data });
    return sendJson(res, 200, { ok: true, ...data, durationMs: Date.now() - t0 });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  }
}

// === ASIN handler ===
// GET /api/asin/{asin}?marketplace=US
if (pathname.startsWith('/api/asin/')) {
  const parts = pathname.split('/');
  const asin = (parts[3] || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
    return sendJson(res, 400, { ok: false, error: 'ASIN 格式无效（应为 10 位大写字母数字，如 B09V3KXJPB）' });
  }
  const marketplace = (query.marketplace || query.mkt || 'US').toUpperCase();
  try {
    const t0 = Date.now();
    const { html, host, status, url } = await fetchAsinPage(asin, marketplace);
    if (status !== 200 || html.length < 50000) {
      return sendJson(res, 200, { ok: false, status, error: '页面未能有效加载（可能触发验证码），请稍后再试', host, url });
    }
    const product = parseAsinProduct(html, asin, marketplace);
    if (!product || !product.title) {
      return sendJson(res, 200, { ok: false, error: '未能解析出产品信息，请确认 ASIN 是否正确', host, url, htmlLen: html.length });
    }
    // 可选：同时扩展 autocomplete 关键词（用 title + 品牌词）
    const expandRelated = query.related !== '0' && query.related !== 'false';
    let related = null;
    if (expandRelated) {
      const seeds = [];
      if (product.brand) seeds.push(product.brand);
      if (product.title) {
        const titleMain = product.title.split('|')[0].split(/[:–—-]/)[0].trim();
        seeds.push(titleMain);
      }
      const seen = new Set();
      const relatedKws = [];
      for (const s of seeds.slice(0, 2)) {
        if (!s) continue;
        try {
          const r = await runInsight({ seeds: [s], marketplace, limit: 10, expand: false });
          r.keywords.forEach(k => { if (!seen.has(k.text)) { seen.add(k.text); relatedKws.push(k); } });
        } catch {}
      }
      related = { seeds: seeds.filter(Boolean), keywords: relatedKws };
    }

    // ===== 西柚找词风格：跑一次排名快照并对比历史 =====
    let trend = null;
    if (query.trend === '1' || query.trend === 'true') {
      try {
        const nowIso = new Date().toISOString();
        const { seeds, ranked } = await runAsinSnapshot(asin, marketplace, product, 20);

        // 存进 trendAsin（即使没在 MONITOR_ASINS 里也存——手动查询触发的快照很有价值）
        if (!alexaCache.trendAsin) alexaCache.trendAsin = {};
        if (!alexaCache.trendAsin[asin]) alexaCache.trendAsin[asin] = {};
        if (!alexaCache.trendAsin[asin][marketplace]) alexaCache.trendAsin[asin][marketplace] = [];
        alexaCache.trendAsin[asin][marketplace].push({ time: nowIso, seeds, ranked });
        if (alexaCache.trendAsin[asin][marketplace].length > MAX_TREND_HISTORY) {
          alexaCache.trendAsin[asin][marketplace].shift();
        }

        // 对比：最新 vs 上一次
        const hist = alexaCache.trendAsin[asin][marketplace];
        const curr = hist[hist.length - 1];
        const prev = hist.length >= 2 ? hist[hist.length - 2] : null;
        const items = compareSnapshots(curr.ranked, prev ? prev.ranked : null, { asin, marketplace });
        const rankedItems = items.filter(i => !i.isNew && !i.isGone);
        const risingItems = rankedItems.filter(i => i.delta != null && i.delta < 0).sort((a, b) => a.delta - b.delta);
        const fallingItems = rankedItems.filter(i => i.delta != null && i.delta > 0).sort((a, b) => b.delta - a.delta);

        trend = {
          updatedAt: curr.time, prevUpdatedAt: prev ? prev.time : null,
          seeds, snapshotCount: hist.length,
          rising: risingItems.slice(0, 20),
          falling: fallingItems.slice(0, 20),
          newKeywords: items.filter(i => i.isNew).slice(0, 20),
          goneKeywords: items.filter(i => i.isGone).slice(0, 20),
          all: items,
        };
        console.log('[trend-asin] manual snapshot', asin, marketplace, seeds.length, 'seeds,', ranked.length, 'ranked');
      } catch (te) {
        console.error('[trend-asin] manual FAIL:', te.message);
        trend = { error: te.message };
      }
    }

    return sendJson(res, 200, {
      ok: true,
      product,
      related,
      trend,
      host,
      url,
      fetchMs: Date.now() - t0,
    });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  }
}


  return sendJson(res, 404, { ok: false, error: 'Not Found' });
}

// ===== 静态文件服务 =====
function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  // 防目录穿越
  const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(__dirname, safePath);
  if (!full.startsWith(__dirname)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ===== 服务器 =====
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, Object.fromEntries(url.searchParams));
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log('amazon-seller-tools server listening on ' + HOST + ':' + PORT);
  refreshAlexaCache();
  setInterval(refreshAlexaCache, REFRESH_INTERVAL_MS);
  console.log('[cache] Alexa auto-refresh every ' + (REFRESH_INTERVAL_MS/3600000) + 'h, seeds:', CACHE_SEEDS.join('/'));
});
