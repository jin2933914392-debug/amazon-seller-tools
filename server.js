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
let alexaCache = { data: null, updatedAt: null, status: 'idle', durationMs: 0, lastError: null, requests: 0,
                   trend: null, trendUpdatedAt: null, trendLastError: null };
// 排名快照历史：marketplace -> seed -> [{ time, ranked:[{kw,rank}] }]，最近 MAX_TREND_HISTORY 次
const MAX_TREND_HISTORY = 96;  // 3 小时一次 × 96 ≈ 12 天
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
      // 初始化 trend 结构
      if (!alexaCache.trend) alexaCache.trend = {};
      for (const mkt of CACHE_MARKETPLACES) {
        if (!alexaCache.trend[mkt]) alexaCache.trend[mkt] = {};
        for (const seed of CACHE_SEEDS) {
          const sk = seed.toLowerCase();
          if (!alexaCache.trend[mkt][sk]) alexaCache.trend[mkt][sk] = [];
          alexaCache.trend[mkt][sk].push({ time: nowIso, ranked: trendNow[mkt][sk] || [] });
          // 截断
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
  region: process.env.SP_API_REGION || 'na', // na / eu / fe
  marketplaceId: process.env.SP_API_MARKETPLACE_ID || 'ATVPDKIKX0DER', // 默认美国站
};

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

  // Alexa 导购洞察：抓取亚马逊 autocomplete 提示词
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

  // 西柚找词风格：ABA 排名 / 热度变化监控
  // 对每个 marketplace × seed，对比"最新快照 vs 上一次快照"，算出：
  //   - 同词 rank 变化 delta（负=涨，正=跌）
  //   - 新冒出来的词（isNew）
  //   - 消失的词（isGone）
  if (pathname === '/api/alexa/trend') {
    const trendCache = alexaCache.trend;
    if (!trendCache) {
      return sendJson(res, 200, { ok: true, trendUpdatedAt: null, items: [], note: '暂无排名历史，首次运行后每 3 小时刷新一次快照' });
    }
    const now = new Date().toISOString();
    const hours = Math.floor(REFRESH_INTERVAL_MS / 3600000);

    // 聚合所有 marketplace × seed 的变化
    const items = [];
    const perSeed = {};  // seed -> [{...变化项}] 方便前端按 seed 分组

    for (const mkt of Object.keys(trendCache)) {
      for (const seed of Object.keys(trendCache[mkt])) {
        const history = trendCache[mkt][seed];
        if (history.length === 0) continue;

        const curr = history[history.length - 1];
        const prev = history.length >= 2 ? history[history.length - 2] : null;

        const currMap = new Map();
        for (const r of curr.ranked || []) currMap.set(r.kw, r.rank);

        const prevMap = new Map();
        if (prev) for (const r of prev.ranked || []) prevMap.set(r.kw, r.rank);

        const seedChanges = [];

        // 本次快照里的词
        for (const [kw, rank] of currMap) {
          const prevRank = prevMap.has(kw) ? prevMap.get(kw) : null;
          let delta = null;
          let isNew = false;
          if (prevRank == null) {
            isNew = true;
          } else {
            delta = rank - prevRank;  // 负 = rank 变小 = 涨了；正 = rank 变大 = 跌了
          }
          const item = {
            keyword: kw,
            seed,
            marketplace: mkt,
            rankNow: rank,
            rankPrev: prevRank,
            delta,
            isNew,
            isGone: false,
          };
          items.push(item);
          seedChanges.push(item);
        }

        // 上次快照里有但这次没了 = 消失词
        for (const [kw, prevRank] of prevMap) {
          if (!currMap.has(kw)) {
            const item = {
              keyword: kw,
              seed,
              marketplace: mkt,
              rankNow: null,
              rankPrev: prevRank,
              delta: null,
              isNew: false,
              isGone: true,
            };
            items.push(item);
            seedChanges.push(item);
          }
        }

        perSeed[seed] = seedChanges;
      }
    }

    // 排序：涨词（delta 最负）→ 跌词（delta 最正）→ 新词 → 消失
    const rankedItems = items.filter(i => !i.isNew && !i.isGone).sort((a, b) => {
      if (a.delta == null) return 1;
      if (b.delta == null) return -1;
      return a.delta - b.delta;  // 升序：最负（涨最多）排最前
    });
    const newItems = items.filter(i => i.isNew);
    const goneItems = items.filter(i => i.isGone);

    return sendJson(res, 200, {
      ok: true,
      trendUpdatedAt: alexaCache.trendUpdatedAt,
      trendLastError: alexaCache.trendLastError,
      refreshIntervalHours: hours,
      latestCount: (rankedItems.length + newItems.length + goneItems.length),
      rising: rankedItems.slice(0, 30),       // Top 30 涨词
      falling: rankedItems.slice(-30).reverse(), // Top 30 跌词（排序末尾倒转）
      newKeywords: newItems.slice(0, 30),
      goneKeywords: goneItems.slice(0, 30),
      perSeed,  // 前端可按 seed 展开看单个种子词的全貌
    });
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
const ASIN_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function cleanHtml(s) { return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim(); }

async function fetchAsinPage(asin, marketplace) {
  const host = ASIN_HOSTS[marketplace] || ASIN_HOSTS.US;
  const url = 'https://www.' + host + '/dp/' + asin;
  const ua = ASIN_UAS[Math.floor(Math.random() * ASIN_UAS.length)];

  // Step 1: 访问首页拿 Cookie（反 CAPTCHA 关键一步）
  const cookieJar = new Map();
  try {
    const homeRes = await fetch('https://www.' + host + '/', {
      headers: {
        'User-Agent': ua,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const setCookies = homeRes.headers.getSetCookie ? homeRes.headers.getSetCookie() : (homeRes.headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z])/);
    setCookies.forEach(c => {
      const m = (c || '').trim().match(/^([^=]+)=([^;]+)/);
      if (m) cookieJar.set(m[1], m[2]);
    });
  } catch (e) { /* 首页失败不致命 */ }

  // Step 2: 带 Cookie + 完整浏览器头访问产品页
  const cookieStr = [...cookieJar.entries()].map(([k, v]) => k + '=' + v).join('; ') || 'i18n-prefs=USD; lc-main=en_US';
  const r = await fetch(url, {
    headers: {
      'User-Agent': ua,
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'identity',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'DNT': '1',
      'Cookie': cookieStr,
      'Referer': 'https://www.' + host + '/',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();
  return { url, host, status: r.status, html };
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

  // 10. Sales Rank
  const sr = html.match(/Best Sellers Rank[^>]*>([\s\S]{0,300}?)/i);
  result.salesRank = cleanHtml(sr?.[1])?.slice(0, 200) || null;

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
    return sendJson(res, 200, {
      ok: true,
      product,
      related,
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
