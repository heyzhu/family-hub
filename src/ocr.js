'use strict';
/**
 * AI 截图识别接入：**只负责账单截图识别**（v3.0.0 → v4.3.0；v4.24.0 通用化）。
 *
 * v4.24.0 需求 1：**通用平台接入** —— 不再限定千问（DashScope）。
 *   走业界通用的「OpenAI 兼容 chat/completions」协议：管理员填三样东西
 *   （接口地址 Base URL + API Key + 模型 ID），任何提供 OpenAI 兼容端点的平台都能用
 *   （OpenAI / Google Gemini 兼容端点 / 智谱 / 百炼 / 各类中转……）。
 *   · 新设置键：`ai_base_url` / `ai_api_key` / `ai_vl_model`；
 *   · ★ 老配置平滑迁移：`qwen_api_key` / `qwen_vl_model` 与环境变量
 *     `DASHSCOPE_API_KEY` / `QWEN_API_KEY` / `QWEN_VL_MODEL` 继续有效 ——
 *     且此时接口地址默认仍指向百炼兼容端点，升级后**零操作、行为不变**；
 *   · `enable_thinking` / `thinking_budget` 是百炼的扩展参数，只在百炼端点发送；
 *     其它平台不传（不认这些参数的平台会 400，参数自愈机制也会兜底剥离）。
 *
 * v4.25.0 需求 1/3：**提速 + 参数收敛**
 *   ① 下线「思考模式 / 思考预算 / 最大输出 / 采样温度」四个设置项（界面不再有，
 *      旧库里的值不再读取）—— 它们退化成内部常量 `SPEED`：固定关思考、输出上限 1024、温度 0。
 *      顺带修掉一个隐性耗时：推理型模型（o 系 / gpt-5）**不认** temperature / max_tokens，
 *      发了会 400 → 参数自愈剥一轮 → 整张图重发一次，耗时直接翻倍。
 *   ② 思考开关按模型能力自动关：百炼发 `enable_thinking:false`，
 *      其它平台的推理型模型（gemini-2.5 / qwen3 / deepseek / glm-4.5…）发 `reasoning_effort`。
 *   ③ 图片默认规格下调（长边 1024 / 质量 0.7 / 目标 480KB）：家庭宽带上行是硬成本。
 *   ④ 提示词更短（默认只列 8 个分类），输出更短。
 *   ⑤ 同一张图 10 分钟内复用模型原始输出（`clearCache()` 供测试）。
 *   ⑥ 响应里带 `timings { totalMs, modelMs, cached }` —— 「慢在哪」不再靠猜。
 *
 * v4.2.0 需求 1：一句话记账改为**完全本地解析**（src/billparse.js），
 *   本模块里所有「文本模型 / 一句话 AI 解析」的代码、设置项与配置入口**全部移除** ——
 *   一句话记账是一个纯本地、零外呼、零成本的功能。本文件只剩图片识别一条 AI 链路。
 *
 * v4.3.0 需求 1：**不再由系统自动获取模型列表**，改为管理员自定义 + 预设快选；
 *   凡影响使用体验的参数一律开放为可配置项（见 AI_DEFAULTS 与 loadConfig）。
 *   同时修复「自定义模型解析很慢」—— 根因是请求体里从来没传思考开关：
 *   百炼的 `enable_thinking` 对 Qwen3 系等混合思考模型有效，默认「开思考」
 *   （官方实测总耗时约为非思考的 3 倍、关闭后下降 60%~75%）。
 *   现在：百炼端点显式传 enable_thinking（默认关）+ max_tokens + 请求超时；
 *   上游不认这些参数时**自动剥离并记住**，不会因为提速而变得不可用。
 *
 * v4.3.0 需求 2：**结合式分类策略** —— 提示词里给出家里的现有分类清单，要求
 *   「优先复用、确信是新品类才起新名」；服务端再做三层归一
 *   （同名 → 别名表 → 包含匹配），仍不中的按 `ai_category_mode` 决定
 *   自动新建还是归「其他」。分类表不再被同义字撑爆。
 *
 * 沿用 v3.0.0 起的约定：
 *   1. **密钥只在后端**：前端永远拿不到 API Key，图片由后端转给 AI 平台。
 *   2. **月度额度保护**：本地按 `ocr_usage(month, used)` 计数；上限由管理员可配
 *      （settings 键 `ai_monthly_limit`，默认 MONTHLY_FREE=1000），到 95% 预警、
 *      达到上限即「熔断」—— 不再调用 AI，转为手动录入。
 *
 * 零依赖：用 Node 内置的 fetch，不引 SDK。`fetchImpl` 可注入，测试完全不打外网。
 */
const config = require('./config');
const { db } = require('./db');
const reminders = require('./reminders');
const billparse = require('./billparse');
const crypto = require('crypto');

/** 默认月度调用上限（成本护栏；管理员可在设置里改，键 ai_monthly_limit） */
const MONTHLY_FREE = 1000;
/** 默认预警线（达到即提示「快用完了」；随上限等比浮动） */
const WARN_AT = 950;
/** 单图限制：base64 编码后不超过 4MB */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/* ── v4.24.0 需求 1：通用平台接入 ───────────────────────────────
   接口地址（Base URL）由管理员填，指向任何「OpenAI 兼容」的 chat/completions 端点。
   两个内置值：
     · DEFAULT_BASE_URL —— 出厂默认（OpenAI 官方端点）；
     · LEGACY_DASHSCOPE_BASE —— 老配置（qwen_* 键）平滑迁移时默认指向的百炼兼容端点，
       保证「升级前用千问的家庭升级后零操作、行为不变」。 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const LEGACY_DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/** 保留旧常量名（老调用方与测试可能引用），不再被请求逻辑直接使用 */
const CHAT_URL = `${LEGACY_DASHSCOPE_BASE}/chat/completions`;
/** 拼一个平台的 chat/completions 地址：Base URL 去尾斜杠 + /chat/completions */
function chatUrlOf(base) {
  return `${String(base || '').trim().replace(/\/+$/, '')}/chat/completions`;
}
/** 这个 Base URL 是不是百炼兼容端点（决定要不要发 enable_thinking 等扩展参数） */
function isDashScope(base) {
  return /dashscope\.aliyuncs\.com/i.test(String(base || ''));
}

/**
 * 候选模型（预设快选；v4.24.0 起改为**跨平台通用示例** —— 模型只是 id，
 * 能不能识别截图取决于所选平台是否提供该模型，填其它任何 id 都可以）。
 */
const MODEL_PRESETS = [
  { id: 'gpt-4o-mini', label: 'gpt-4o-mini（OpenAI · 便宜稳定）', tier: 1 },
  { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash（Google · OpenAI 兼容端点）', tier: 2 },
  { id: 'glm-4v-flash', label: 'glm-4v-flash（智谱 · 视觉）', tier: 3 },
];
/** 出厂默认模型（管理员没自定义、也没有老配置时用它） */
const DEFAULT_VL_MODEL = 'gpt-4o-mini';
/** 老配置（qwen_*）平滑迁移时的默认模型 —— 保持升级前后行为一致 */
const DEFAULT_MODEL_LEGACY = 'qwen3-vl-flash';

/** 兼容旧名字（老调用方与老测试仍可能引用 VL_MODELS） */
const VL_MODELS = MODEL_PRESETS;

/**
 * 价格表：id → { in, out }（元 / 每百万 Token）。
 * 只收「确定知道」的档位；查不到的模型**如实说不知道**并指向服务商定价页，
 * 不编数字 —— 记账系统的成本提示宁可保守也不能骗人。
 */
const PRICE_TABLE = {
  'gpt-4o-mini': { in: '1.1', out: '4.4' },
  'gpt-4o': { in: '18', out: '72' },
  'glm-4v-flash': { in: '0', out: '0' },
  // 老配置（qwen_* 平滑迁移）还在用这些模型时，价格提示照样给出
  'qwen3-vl-flash': { in: '0.18', out: '1.8' },
  'qwen3-vl-plus': { in: '1.2', out: '12' },
};

/** 「家族款」价格兜底：`qwen3-vl-flash-2025-11-13` 这类版本号后缀与基础款同价 */
const PRICE_PREFIX = Object.keys(PRICE_TABLE).sort((a, b) => b.length - a.length);

/** 自定义模型 ID 的合法字符（放得很宽：各平台上新模型不改代码就能填） */
const MODEL_RE = /^[A-Za-z0-9._-]{2,64}$/;

/**
 * 混合思考模型的特征：这些模型（可能）认 `enable_thinking` 参数。
 * 只对它们传思考开关，能显著减少「给不支持的模型塞参数 → 400」的概率。
 */
const THINKING_RE = /qwen3|qwq|glm|kimi|deepseek|minimax|omni|qwen3\.[0-9]/i;

/**
 * v4.25.0 提速：**推理型模型**在 OpenAI 兼容端点上默认「先思考再回答」，
 * 一次截图识别 20~30 秒多半就是它 —— 账单抽取不需要思考，但界面已经没有
 * 「思考模式」开关了（需求 3 下线），所以由代码按模型名自动关。
 * `reasoning_effort` 是这类模型的通用旋钮：OpenAI 官方端点认 minimal，其余兼容层
 * 认 none；上游不认就由参数自愈剥掉并记住，不会把功能弄坏。
 */
const MAY_THINK_RE = /gemini-2\.5|gemini-3|qwen3|qwq|deepseek|glm-4\.[5-9]|glm-5|kimi|minimax|thinking|reasoner|^o[1-9]|gpt-5|gpt-6/i;

/**
 * 不接受 `temperature` / `max_tokens` 的模型（推理型）。给它们发这些参数会**直接 400**，
 * 触发参数自愈剥一轮 —— 那意味着整张图重发一次，耗时直接翻倍。所以干脆不发。
 */
const REASONING_MODEL_RE = /^o[1-9]|gpt-5|gpt-6|reasoner|thinking/i;

/** 视觉模型的粗略判定（只用于**给管理员的提示**，不再用于过滤列表/拒绝保存） */
const VL_RE = /(^|[-_.])vl([-_.]|$)|vision|vlm/i;
/** 明显不可能识图的模型特征（同样只用于提示） */
const NON_CHAT_RE = /embedding|rerank|tts|asr|speech|voice|audio|paraformer|sambert|cosyvoice|wanx|image-gen|translate|mt-/i;

/** 这个模型名看起来能不能用来做截图识别（**提示用**，不拦截保存） */
function looksVision(id) {
  const s = String(id || '').trim();
  if (!MODEL_RE.test(s)) return false;
  if (NON_CHAT_RE.test(s)) return false;
  return VL_RE.test(s);
}

/* ── v4.3.0：开放给管理员的 AI 参数（默认值 = 「极速档」） ──────────
   设计原则：凡影响使用体验、又因家而异（模型/网络/账单截图风格）的参数都开放，
   但给一套**开箱即好用**的默认值 —— 不动任何设置也能跑得又快又对。 */
/* v4.25.0 需求 3：**思考模式 / 思考预算 / 最大输出 / 采样温度** 四项一律从界面上撤掉，
   不再由管理员调 —— 它们的取值不是「各有偏好」而是「有唯一正确答案」：
   截图抽取要的是**不再思考、输出尽量短、温度取 0**。留在界面上只会出现
   「有人把思考打开 ⇒ 一次识别 30 秒」这种自己给自己挖的坑。
   现在它们退化成内部常量（见 SPEED），仍然会出现在请求体里，但不再有开关。 */
const SPEED = {
  /* 思考模式固定关：百炼端点显式发 enable_thinking=false。 */
  thinking: false,
  /* 输出上限固定 1024：JSON 一屏够用；上限越小，模型越不会「越写越长」。 */
  maxTokens: 1024,
  /* 温度固定 0：抽取任务要稳定，不要创意。 */
  temperature: 0,
};

const AI_DEFAULTS = {
  timeoutMs: 60000,       // 单次请求超时（v4.2.0 没有超时，慢请求会一直挂着）
  retry: 1,               // 失败重试次数（总请求数 = retry + 1）
  fallback: true,         // 选定的模型不可用时，自动改用默认模型重试
  categoryMode: 'auto',   // 分类策略：auto=新品类自动建分类；strict=只用现有分类
  imgCompress: true,      // 上传前压缩
  /* ★ v4.25.0 提速：长边 1280 → 1024、质量 0.75 → 0.7、目标体积 900KB → 480KB。
     原因很实在：识别链路上「我们 → AI 平台」的这段是家庭宽带**上行**，
     900KB 的图变成 base64 是 1.2MB，这段纯带宽成本经常比模型推理还长。
     账单截图缩到 1024px、480KB 以内，金额/日期/商户依旧清晰，上传时间却砍掉一半。 */
  imgEdge: 1024,          // 压缩后长边像素
  imgQuality: 0.7,        // JPEG 质量
  imgKb: 480,             // 目标体积（KB），超过就继续降
  /* ── v4.3.1 需求 4：把「提示词」也开放出来 ──────────────────
     ★ 服务商（阿里云百炼）官方明确：**降 max_pixels / 图片分辨率对端到端响应时间没有显著影响**
       （「Adjusting max_pixels is not a way to improve speed」），
       真正影响延迟的是**模型档位**与**输出长度**。
       所以本版提速走的两条路是：
         (1) 让模型少输出没用的东西 —— 提示词更短更硬，并允许用户直接改写（promptCustom）；
         (2) 少喂无用上下文 —— 提示词里只列前 N 个现有分类（catHint），不再硬塞 40 条。 */
  catHint: 8,             // 提示词里最多列几个现有分类（0 = 不列；越少提示词越短）
  promptCustom: '',       // 自定义提示词模板（留空 = 用内置）。支持 {today} / {categories} 占位符
};

/**
 * 某个模型的价格文案。
 * 命中价格表 → 「输入 ¥x / 输出 ¥y，每百万 Token」；
 * 只是版本号后缀不同 → 标注「同家族同价」；
 * 真查不到 → 明确说不知道 + 指向控制台（绝不编价格）。
 */
function priceOf(id) {
  const s = String(id || '').trim();
  if (PRICE_TABLE[s]) {
    const p = PRICE_TABLE[s];
    return `输入 ¥${p.in} / 输出 ¥${p.out}，每百万 Token`;
  }
  for (const base of PRICE_PREFIX) {
    if (s === base || s.startsWith(`${base}-`)) {
      const p = PRICE_TABLE[base];
      return `输入 ¥${p.in} / 输出 ¥${p.out}，每百万 Token（与 ${base} 同家族，同价）`;
    }
  }
  return '未收录该模型价格 · 以服务商控制台实时定价为准';
}

/** 价格档位（1 最省）：只用于把列表从省到准排序 */
function tierOf(id) {
  const hit = VL_MODELS.filter((m) => m.id === id)[0];
  if (hit && hit.tier) return hit.tier;
  for (const base of PRICE_PREFIX) {
    if (String(id || '').startsWith(base)) {
      const b = VL_MODELS.filter((m) => m.id === base)[0];
      if (b && b.tier) return b.tier;
    }
  }
  return 9;
}

/**
 * 这个模型名看着能不能用来做截图识别。
 * v4.3.0：**只用于给管理员的提示**（保存时不再拦截 —— 用户要能自由填任意模型），
 *   所以它就是 looksVision 的别名，保留旧名字以兼容既有调用方与测试。
 */
function isVisionChatModel(id) {
  return looksVision(id);
}

/* ── 配置：优先 settings 表（管理员在界面上填），其次环境变量 ── */

/**
 * 读一个数值型设置（带合法区间）。非法值一律回落默认 ——
 * 「保存成功了但值坏了」是本项目最忌讳的事，宁可当没填过。
 */
function numSetting(map, key, def, min, max) {
  const raw = map[key];
  if (raw == null || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return n;
}

/**
 * @returns {{apiKey:string, baseUrl:string, chatUrl:string, vlModel:string, defaultModel:string,
 *   enabled:boolean, source:'settings'|'env'|'legacy'|'',
 *   thinking:boolean, thinkingBudget:number, maxTokens:number, temperature:number,
 *   timeoutMs:number, retry:number, fallback:boolean, categoryMode:'auto'|'strict',
 *   imgCompress:boolean, imgEdge:number, imgQuality:number, imgKb:number,
 *   catHint:number, promptCustom:string}}
 *   v4.2.0：`textModel` 已随「一句话 AI 解析」一起移除。
 *   v4.3.0：所有影响使用体验的 AI 参数都从这里出来，全部存 settings（key/value，零结构变更）。
 *   v4.3.1：再加「提示词」两项（catHint / promptCustom）。
 *   v4.24.0：`baseUrl` / `chatUrl` / `defaultModel` —— 通用平台三件套的另外两件。
 *     取值优先级：新键 settings → 环境变量 → **旧键（qwen_*）平滑迁移** → 出厂默认。
 *     `source` 里的 'legacy' 表示密钥来自旧键，界面上据此提示「建议换填到新键」。
 */
function loadConfig() {
  const map = {};
  for (const r of db.all('SELECT key, value FROM settings')) map[r.key] = String(r.value == null ? '' : r.value);

  /* —— API Key：ai_api_key → 环境 AI_API_KEY → 旧键 qwen_api_key / DASHSCOPE_API_KEY —— */
  let apiKey = String(map.ai_api_key || '').trim();
  let source = '';
  let legacy = false;
  if (apiKey) source = 'settings';
  if (!apiKey) apiKey = String(process.env.AI_API_KEY || '').trim();
  if (!source && apiKey) source = 'env';
  if (!apiKey) {
    const oldKey = String(map.qwen_api_key || '').trim()
      || String(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '').trim();
    if (oldKey) {
      apiKey = oldKey;
      source = 'legacy';
      legacy = true;
    }
  }

  /* —— 接口地址：ai_base_url → 环境 AI_BASE_URL → 出厂默认。
     ★ 老配置平滑迁移：密钥还留在旧键（settings 或 qwen 环境变量）、且新键完全没配时，
       默认仍指向百炼兼容端点 —— 升级后不用任何操作，识别照常工作。 */
  let baseUrl = String(map.ai_base_url || '').trim()
    || String(process.env.AI_BASE_URL || '').trim();
  if (!baseUrl) baseUrl = legacy ? LEGACY_DASHSCOPE_BASE : DEFAULT_BASE_URL;

  /* —— 模型：ai_vl_model → 旧键 qwen_vl_model → 环境 → 出厂默认（随平台走） —— */
  let vlModel = String(map.ai_vl_model || '').trim();
  if (!MODEL_RE.test(vlModel)) vlModel = String(map.qwen_vl_model || '').trim();
  if (!MODEL_RE.test(vlModel)) vlModel = String(process.env.AI_VL_MODEL || process.env.QWEN_VL_MODEL || '').trim();
  if (!MODEL_RE.test(vlModel)) vlModel = legacy ? DEFAULT_MODEL_LEGACY : DEFAULT_VL_MODEL;

  const thinking = SPEED.thinking;   // v4.25.0：固定关思考，不再读 settings
  return {
    apiKey,
    baseUrl,
    chatUrl: chatUrlOf(baseUrl),
    vlModel,
    /* 「模型不可用自动换默认」的自愈目标：跟平台走（老配置仍是 qwen3-vl-flash） */
    defaultModel: legacy ? DEFAULT_MODEL_LEGACY : DEFAULT_VL_MODEL,
    enabled: map.ai_enabled !== '0',
    source,
    legacy,
    /* v4.25.0 需求 3：思考 / 思考预算 / 最大输出 / 采样温度已下线（内部常量，无设置项）。
       旧库里的 ai_thinking / ai_thinking_budget / ai_max_tokens / ai_temperature
       一律**不再读取** —— 留着也不生效，界面也不再回显（「先停读、再停校验」）。 */
    thinking,
    timeoutMs: Math.round(numSetting(map, 'ai_timeout_ms', AI_DEFAULTS.timeoutMs, 5000, 300000)),
    retry: Math.round(numSetting(map, 'ai_retry', AI_DEFAULTS.retry, 0, 3)),
    fallback: map.ai_fallback !== '0',
    categoryMode: map.ai_category_mode === 'strict' ? 'strict' : 'auto',
    imgCompress: map.ai_img_compress !== '0',
    imgEdge: Math.round(numSetting(map, 'ai_img_edge', AI_DEFAULTS.imgEdge, 640, 2400)),
    imgQuality: numSetting(map, 'ai_img_quality', AI_DEFAULTS.imgQuality, 0.4, 0.95),
    imgKb: Math.round(numSetting(map, 'ai_img_kb', AI_DEFAULTS.imgKb, 200, 4000)),
    // v4.3.1 需求 4：提示词可配（分类条数 + 自定义模板）
    catHint: Math.round(numSetting(map, 'ai_cat_hint', AI_DEFAULTS.catHint, 0, 40)),
    promptCustom: String(map.ai_prompt_custom || '').slice(0, 2000),
  };
}

/**
 * 一次「账单截图识别」的**完整参数集**（v4.8.0 需求 1：唯一来源）。
 *
 * 为什么要有它：网页上传（`POST /api/bills/ocr`）与企业微信发图（`wecomRecognizeImage`）
 * 是同一条识别链路的两个入口。参数原本各写各的默认值 —— 表面上都在读 settings，
 * 但只要有一处忘了透传（例如企业微信侧漏了图片压缩规格），两边行为就会悄悄分叉，
 * 表现为「同一张图在网页认得准、在微信里认不准」，极难查。
 *
 * ★ 规矩：两个入口都必须 `ocr.billParams()` 取值并原样透传给 `recognizeBill`，
 *   不许在调用点写任何字面量参数。（docker.test 的 C4s 段看着这条。）
 *
 * v4.25.0 需求 3：`temperature / maxTokens / thinking / thinkingBudget` 从参数集里删除 ——
 *   它们已经退化成模块内常量 `SPEED`（固定关思考 / 1024 / 0），不再允许按人按库配置。
 *
 * @returns {{vlModel:string, timeoutMs:number, retry:number, categoryMode:string,
 *   catHint:number, promptCustom:string,
 *   image:{compress:boolean, edge:number, quality:number, kb:number}}}
 */
function billParams() {
  const c = loadConfig();
  return {
    vlModel: c.vlModel,
    timeoutMs: c.timeoutMs,
    retry: c.retry,
    categoryMode: c.categoryMode,
    catHint: c.catHint,
    promptCustom: c.promptCustom,
    // 图片规格：网页端拿它做上传前压缩；服务端拿它做「发来的图是否超标」的判断
    image: { compress: c.imgCompress, edge: c.imgEdge, quality: c.imgQuality, kb: c.imgKb },
  };
}

/** 下发给前端的图片预处理参数（不含任何密钥，只决定上传前的压缩力度） */
function imagePrefs() {
  return billParams().image;
}

/**
 * v4.12.0 需求 6：读出图片的「事实」（格式 / 长宽），不依赖任何图像库。
 *
 * 为什么需要它：网页端上传前会在 canvas 里压到「长边 edge」，企业微信发来的是
 * 微信客户端压过的原图。要让两边「一致处理」，服务端至少得知道这张图到底多大 ——
 * 只靠体积判断会把「一张 4000px 的清晰小图」当成合格，实际识别又慢又容易认错。
 * 这里只解析文件头（JPEG 的 SOF 段 / PNG 的 IHDR），几十行、零依赖、不会读坏像素。
 *
 * @returns {{type:string, width:number, height:number, edge:number}} 解析不出来时 width/height = 0
 */
function imageFacts(buf) {
  const out = { type: '', width: 0, height: 0, edge: 0 };
  const b = buf;
  if (!b || b.length < 24) return out;
  // PNG：89 50 4E 47，IHDR 在固定偏移 16/20（大端）
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    out.type = 'png';
    out.width = b.readUInt32BE(16);
    out.height = b.readUInt32BE(20);
    out.edge = Math.max(out.width, out.height);
    return out;
  }
  // GIF：宽高是 16 位小端
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    out.type = 'gif';
    out.width = b.readUInt16LE(6);
    out.height = b.readUInt16LE(8);
    out.edge = Math.max(out.width, out.height);
    return out;
  }
  // JPEG：逐段扫到 SOF0/SOF2（0xC0–0xCF，排除 0xC4/0xC8/0xCC）
  if (b[0] === 0xff && b[1] === 0xd8) {
    out.type = 'jpeg';
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) break;
      const isSOF = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        out.height = b.readUInt16BE(i + 5);
        out.width = b.readUInt16BE(i + 7);
        out.edge = Math.max(out.width, out.height);
        return out;
      }
      i += 2 + len;
    }
    return out;
  }
  return out;
}

/**
 * v4.12.0 需求 6：企业微信图片的「与网页端一致」规整判定。
 *
 * 网页端链路：canvas 按 `edge / quality / kb` 压一遍 → 上传 → 识别。
 * 企业微信链路：微信客户端已把图压到几百 KB → 直接取原图识别。
 * 服务端没有 canvas，也不该为了压一张图引入图像库（本项目零依赖），所以这里做的是
 * **用同一份参数做同一套判定**，并把差异如实告诉用户，而不是假装两边一模一样：
 *   · 超过接口硬上限 → 明确告知（拒绝，而不是让上游报一个看不懂的错）
 *   · 超过目标体积 / 长边明显超规格 → 在回复里提一句「识别可能稍慢」，
 *     同时给出「网页端会自动压到 edge，企业微信是原图」的说明
 * @param {{buffer:Buffer}} media
 * @param {{edge:number, kb:number, compress:boolean}} image 来自 ocr.billParams().image
 */
function inspectIncomingImage(media, image) {
  const buf = (media && media.buffer) || Buffer.alloc(0);
  const bytes = buf.length;
  const facts = imageFacts(buf);
  const cfg = image || {};
  const kb = Number(cfg.kb) || 900;
  const edge = Number(cfg.edge) || 1280;
  const oversizeHard = bytes > MAX_IMAGE_BYTES;
  const overKb = bytes > kb * 1024;
  const overEdge = facts.edge > 0 && facts.edge > edge * 1.5;
  return {
    bytes,
    facts,
    overKb,
    overEdge,
    oversizeHard,
    // 是否需要在回复末尾补一句（体积或长边明显超出目标规格）
    note: '',
    block: oversizeHard
      ? `这张图 ${(bytes / 1048576).toFixed(1)}MB，超过识别接口能收的 `
        + `${Math.round(MAX_IMAGE_BYTES / 1048576)}MB。可以裁剪一下、或重新截一张更小的再发。`
      : '',
  };
}

/** 只看密钥（兼容旧语义：配没配过 Key） */
const isConfigured = () => !!loadConfig().apiKey;

/** AI 总开关是否可用（密钥已配 **且** 管理员没停用）。前端入口灰不灰以此为准。 */
function aiReady() {
  const cfg = loadConfig();
  return !!cfg.apiKey && cfg.enabled;
}

/* ── 额度 ─────────────────────────────────────────────────── */

/** 当前月份键（YYYY-MM），按「家里人的墙上时间」算 —— 不能依赖服务器本地时区 */
function currentMonth(tzOffsetMinutes) {
  return reminders.wallDateKey(new Date(), tzOffsetMinutes).slice(0, 7);
}

/** 月度上限（管理员可配；settings 键 ai_monthly_limit，非法值回落默认 1000） */
function monthlyLimit() {
  const row = db.get("SELECT value FROM settings WHERE key = 'ai_monthly_limit'");
  const n = Math.round(Number(row && row.value));
  return (Number.isFinite(n) && n >= 1 && n <= 1000000) ? n : MONTHLY_FREE;
}

function usedIn(month) {
  const row = db.get('SELECT used FROM ocr_usage WHERE month = ?', [month]);
  return row ? Number(row.used) || 0 : 0;
}

/**
 * 调用计数 +1。
 * ★ v4.3.1 需求 3：只在**识别成功**后调用（见 recognizeBill 的 attempt）。
 *   旧版在发起请求前就 +1，导致超时 / 网络失败 / 模型填错都白扣额度。
 */
function addUsage(month, n = 1) {
  db.run(
    'INSERT INTO ocr_usage (month, used) VALUES (?,?) ON CONFLICT(month) DO UPDATE SET used = used + ?',
    [month, n, n],
  );
  return usedIn(month);
}

/**
 * v4.2.0 需求 3：本月 token 消耗总额（自然月，按家里人的墙上时间划月）。
 *
 * ★ 「按自然月清零」不是去删数据，而是**按月键取数**：月份一换，key 自然变了，
 *   统计结果从 0 开始 —— 历史日志一条不动（管理端还能查上月），也不需要定时任务。
 * @param {number} [tzOffsetMinutes]
 * @returns {{month:string, calls:number, tokens:number, promptTokens:number, completionTokens:number}}
 */
function monthUsage(tzOffsetMinutes) {
  const tz = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : config.tzOffsetMinutes;
  const month = currentMonth(tz);
  const out = {
    month, calls: usedIn(month), tokens: 0, promptTokens: 0, completionTokens: 0,
  };
  if (!/^\d{4}-\d{2}$/.test(month)) return out;
  const y = Number(month.slice(0, 4));
  const mo = Number(month.slice(5, 7));
  // 下界：本月 1 号 00:00（墙上时间）对应的 UTC 瞬时 —— 只为缩小扫描范围，精确判定在下面
  const lower = new Date(Date.UTC(y, mo - 1, 1) - tz * 60000).toISOString();
  const rows = db.all(
    'SELECT created_at, prompt_tokens, completion_tokens, total_tokens FROM ai_logs WHERE created_at >= ?',
    [lower],
  );
  for (const r of rows) {
    const iso = String(r.created_at || '');
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    // 转成墙上时间再取 YYYY-MM：跨月边界（比如 1 号早上 8 点前的 UTC 值）才算得准
    if (new Date(ms + tz * 60000).toISOString().slice(0, 7) !== month) continue;
    out.promptTokens += Number(r.prompt_tokens) || 0;
    out.completionTokens += Number(r.completion_tokens) || 0;
    out.tokens += Number(r.total_tokens) || 0;
  }
  return out;
}

/**
 * 额度快照。
 * @param {number} [tzOffsetMinutes]
 * @returns {{month:string, used:number, limit:number, remaining:number,
 *            warn:boolean, exhausted:boolean, warnAt:number, enabled:boolean, ready:boolean}}
 */
function quota(tzOffsetMinutes) {
  const tz = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : config.tzOffsetMinutes;
  const month = currentMonth(tz);
  const used = usedIn(month);
  const limit = monthlyLimit();
  const warnAt = Math.min(limit - 1, Math.floor(limit * 0.95));
  const { enabled } = loadConfig();
  return {
    month,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    warnAt,
    warn: used >= warnAt && used < limit,
    exhausted: used >= limit,
    enabled,
    ready: !!loadConfig().apiKey && enabled && used < limit,
  };
}

const defaultFetch = (...args) => {
  if (typeof fetch !== 'function') {
    throw Object.assign(new Error('当前 Node 运行时不支持 fetch，无法调用 AI 服务'), { status: 500 });
  }
  return fetch(...args);
};

/** 测试用：清掉模型侧状态（AI 平台用 Bearer Key 直连，无 token 缓存，保留导出名兼容调用方） */
function resetTokenCache() { /* no-op */ }

/* ── AI 调用日志（需求 7：成本可审计） ────────────────────── */

/**
 * 记一条 AI 调用日志（ai_logs 表）。绝不抛错 —— 日志失败不能影响业务。
 * @param {{userId?:number, action:string, model:string, images?:number,
 *          usage?:object|null, ok?:boolean, error?:string, durationMs?:number}} p
 */
function logAi(p) {
  try {
    const u = p.usage || {};
    db.run(
      'INSERT INTO ai_logs (user_id, action, model, images, prompt_tokens, completion_tokens, total_tokens, ok, error, duration_ms)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?)',
      [p.userId == null ? null : Number(p.userId), String(p.action || '').slice(0, 20),
        String(p.model || '').slice(0, 64), Math.max(0, Math.round(Number(p.images) || 0)),
        Math.max(0, Math.round(Number(u.prompt_tokens) || 0)),
        Math.max(0, Math.round(Number(u.completion_tokens) || 0)),
        Math.max(0, Math.round(Number(u.total_tokens) || 0)),
        p.ok === false ? 0 : 1, String(p.error || '').slice(0, 300),
        Math.max(0, Math.round(Number(p.durationMs) || 0))],
    );
  } catch { /* 日志失败不影响业务（静默但表结构在，管理端能看到缺行即知异常） */ }
}

/**
 * 管理端读取调用日志（新的在前）。
 * @param {number} [limit]
 * @param {string} [month] 传 YYYY-MM 时**只回该自然月**的记录 ——
 *   v4.2.0 需求 3 的「按自然月清零」就靠它：跨月后界面自然是空的（数据一条不删）。
 */
function listLogs(limit, month) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const want = /^\d{4}-\d{2}$/.test(String(month || '')) ? String(month) : '';
  const tz = config.tzOffsetMinutes;
  const rows = db.all('SELECT * FROM ai_logs ORDER BY id DESC LIMIT ?', [want ? 2000 : n]);
  return rows
    .filter((r) => {
      if (!want) return true;
      const ms = Date.parse(String(r.created_at || ''));
      if (!Number.isFinite(ms)) return false;
      return new Date(ms + tz * 60000).toISOString().slice(0, 7) === want;
    })
    .slice(0, n)
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      userId: r.user_id,
      action: r.action,
      model: r.model,
      images: Number(r.images) || 0,
      promptTokens: Number(r.prompt_tokens) || 0,
      completionTokens: Number(r.completion_tokens) || 0,
      totalTokens: Number(r.total_tokens) || 0,
      ok: !!r.ok,
      error: r.error,
      durationMs: Number(r.duration_ms) || 0,
    }));
}

/** 把前端传上来的 dataUrl 拆出纯 base64 之外，还要校验大小；不是图片就直接报错 */
function base64Of(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(s);
  if (!m) throw Object.assign(new Error('请上传图片文件'), { status: 400, code: 'OCR_BAD_IMAGE' });
  const b64 = m[2];
  const bytes = Math.floor(b64.length * 3 / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error(`截图太大了（约 ${(bytes / 1048576).toFixed(1)}MB），请压缩到 4MB 以内`), { status: 413, code: 'OCR_TOO_BIG' });
  }
  return b64;
}

/* ── 标准 JSON 的清洗与归一 ───────────────────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 把模型吐出的各种日期写法统一成 YYYY-MM-DD；认不出来就回落到 todayKey */
function normDate(raw, todayKey) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return todayKey;
  if (DATE_RE.test(s)) return s;
  // 取前 10 位（兼容 "2026-10-09 14:23:05" 这类带时间的写法）
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) {
    const [y, m, d] = s.split(/[-\s]/).map((x) => parseInt(x, 10));
    if (y > 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  // 「2026年10月9日」
  let m = /^(\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(s);
  if (m) {
    return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  // 「10月9日」→ 补今天所在年份
  m = /^(\d{1,2})月(\d{1,2})日?/.exec(s);
  if (m) {
    const y = String(todayKey || '').slice(0, 4);
    if (/^\d{4}$/.test(y)) {
      return `${y}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    }
  }
  // 「2026/10/9」
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s);
  if (m) {
    return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  return todayKey;
}

/**
 * 从模型回复文本里抠出 JSON 对象（容忍 ```json 围栏、前后闲话）。
 * 取**第一个 `{` 到最后一个 `}`**：比逐层配对简单，且对本用途足够稳。
 * @returns {object|null}
 */
function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * 把模型输出的条目数组清洗成入库口径（v4.0.0 字段对齐）：
 *   - 只留支出（收入 / 认不出方向的跳过，收入计数 skippedIncome）
 *   - amount 必须是正数（容忍字符串「¥1,234.56」）
 *   - 交易时间 → dateKey（YYYY-MM-DD）；交易平台 → platform；
 *     商品分类 → category（**v4.3.0 起走三层归一**，见下）；商品名称 + note → note
 *   - 同金额 + 同日期 + 同备注去重；上限 50 条
 *
 * v4.3.0 需求 2（结合式分类策略的**服务端那一层**）：
 *   AI 返回的分类名先经 `billparse.matchCategory` 与家里的现有分类对账 ——
 *     ① 同名 → 直接用（用户自建分类优先）；
 *     ② 命中别名表（「吃饭」→「餐饮」）→ 复用现有分类；
 *     ③ 现有分类名是它的子串（「餐饮美食」含「餐饮」）→ 复用；
 *     ④ 都不中 → 按 `categoryMode`：auto 采用新名字（入库时自动建分类），
 *        strict 归「其他」（**绝不新建**，分类表永不被同义字撑爆）。
 *   提示词那一层只说「请优先复用」，模型不一定听；这一层才是硬约束。
 *
 * @param {Array<object>} rawItems
 * @param {{todayKey:string, categories?:string[], categoryMode?:'auto'|'strict'}} o
 * @returns {{items:Array<{amountCents:number,dateKey:string,note:string,category:string,platform:string}>,
 *            skippedIncome:number, catStats:object}}
 */
function normalizeItems(rawItems, o) {
  const opts = o || {};
  const today = String(opts.todayKey || '').slice(0, 10);
  const cats = (Array.isArray(opts.categories) ? opts.categories : []).map((x) => String(x || '')).filter(Boolean);
  const mode = opts.categoryMode === 'strict' ? 'strict' : 'auto';
  const list = Array.isArray(rawItems) ? rawItems.slice(0, 50) : [];
  const out = [];
  let skippedIncome = 0;
  const catStats = { exact: 0, alias: 0, contains: 0, created: 0, other: 0 };
  const seen = new Set();
  for (const it of list) {
    const row = it || {};
    const type = String(row.type != null ? row.type : row['收支类型'] != null ? row['收支类型'] : row['交易类型'] || '').trim().toLowerCase();
    const rawType = String(row.type != null ? row.type : row['收支类型'] != null ? row['收支类型'] : row['交易类型'] || '');
    if (type === 'income' || rawType.includes('收入')) { skippedIncome++; continue; }
    // 认不出方向的条目宁可跳过也不能瞎记 —— 记错账比记不上账难收拾
    if (type !== 'expense' && !rawType.includes('支出')) continue;

    let amount = row.amount != null ? row.amount : row['金额'];
    if (typeof amount === 'string') amount = Number(amount.replace(/[¥￥$,\s，]/g, ''));
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cents = Math.round(amount * 100);
    if (cents <= 0 || cents > 100000000) continue;

    const dateKey = normDate(row.transaction_date != null ? row.transaction_date
      : (row['交易时间'] != null ? row['交易时间'] : row.transactionDate), today);
    // 商品名称（name）优先，兼容 v3.0.0 的 merchant（商户名称）
    const name = String(
      row.name != null ? row.name
        : row['商品名称'] != null ? row['商品名称']
          : row.merchant != null ? row.merchant : row['商户名称'] || '',
    ).trim().slice(0, 60);
    const note = String(row.note != null ? row.note : row['备注'] || '').trim().slice(0, 120);
    /* v4.3.0 需求 2：分类三层归一 */
    const rawCat = row.category != null ? row.category
      : (row['商品分类'] != null ? row['商品分类'] : (row['分类'] != null ? row['分类'] : ''));
    const m = billparse.matchCategory(rawCat, cats, opts.rules);
    let category = m.name;
    if (m.matched) {
      /* v4.17.0 需求 5：用户规则命中（reason === 'rule'）也是「复用现有分类」，并入 alias 计数 */
      if (m.reason === 'alias' || m.reason === 'rule') catStats.alias++;
      else if (m.reason === 'contains') catStats.contains++;
      else catStats.exact++;
    } else if (mode === 'strict') {
      category = cats.indexOf('其他') >= 0 ? '其他' : (cats[0] || '其他');
      catStats.other++;
    } else {
      catStats.created++;
    }
    if (!category) { category = cats.indexOf('其他') >= 0 ? '其他' : ''; }
    // 交易平台（v4.0.0 需求 6）
    const platform = String(
      row.platform != null ? row.platform : row['交易平台'] || '',
    ).trim().slice(0, 20);
    const noteFull = [name, note].filter(Boolean).join(' · ').slice(0, 200);
    const key = `${cents}|${dateKey}|${noteFull}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ amountCents: cents, dateKey, note: noteFull, category, platform });
  }
  return { items: out, skippedIncome, catStats };
}

/* ── 提示词（只剩截图识别一条：一句话记账已改为纯本地解析） ── */

/**
 * 内置提示词**模板**（v4.3.2 需求 2：改成可回显、可还原的常量）。
 *
 * 为什么要有这个常量：设置页要把「默认提示词」预填进自定义提示词输入框，
 * 并提供「恢复默认」按钮。如果默认提示词只存在于函数里的拼接逻辑中，
 * 前端就永远拿不到它 —— 只能靠人肉抄一遍，一升级就过期。
 *
 * 两个占位符（与自定义提示词同一套规则）：
 *   {today}       今天的日期（YYYY-MM-DD）—— 截图只写「10月9日」时靠它补年份
 *   {categories}  家里的现有分类，按 ai_cat_hint 截断后顿号相连
 *
 * 单唯一来源：`vlPrompt` 与设置页回显都用它，改这里两边同时变。
 */
const DEFAULT_PROMPT = [
  '提取这张支付/账单截图里的每一笔交易，只输出 JSON，不要 markdown、不要解释：',
  '{"items":[{"transaction_date":"YYYY-MM-DD","type":"expense","platform":"","category":"","name":"","amount":0,"note":""}]}',
  'transaction_date 用 YYYY-MM-DD；截图只写「10月9日」这类时按今天 {today} 补年份。',
  'type 只能是 expense（支出）或 income（收入）；amount 为数字（元），不带 ¥ 和逗号。',
  'category 优先从现有分类里选：{categories}；都不合适才用 2~4 字的新分类名。',
  'platform 填支付平台，name 填商品/商户名；note 仅在确有补充信息时才填，**空字段一律省略**。',
  '跳过合计、余额、单号、优惠券等非交易行；一笔都没有时输出 {"items":[]}。',
].join('\n');

/** 一个分类都没有时，{categories} 的兜底内容 —— 不能替换成空串，否则那行会读出「：；」这种残句 */
const DEFAULT_CATEGORY_HINT = '餐饮、交通、日用、购物、其他';

/**
 * 截图识别的提示词。
 * v4.3.0 需求 2：把**家里的现有分类**列进提示词，要求优先复用 ——
 *   这是「约束 AI 只用现有分类」的第一层；第二层是服务端的强制归一
 *   （normalizeItems → billparse.matchCategory），模型不听话也没关系。
 * v4.3.1 需求 4：**提速 + 可自定义**
 *   · 官方口径：影响延迟的是**模型档位**与**输出长度**（不是图片像素）。
 *     所以这里把提示词写得更短、更硬 —— 明确「省略空字段、不要解释文字」，
 *     直接从**输出侧**省 token（输出 token 才是耗时大头）。
 *   · `catHint` 控制列几个现有分类（默认 12，0 = 不列）—— 不再硬塞 40 条。
 *   · `custom` 允许管理员整段替换（支持 {today} / {categories} 占位符），
 *     想更快就把模板精简到两三行。
 * v4.3.2 需求 2：默认值抽成 `DEFAULT_PROMPT` 常量（同一套占位符），
 *   自定义与内置走**完全同一条**替换代码 —— 两条分支各写一遍迟早会不一致。
 * @param {string} todayKey
 * @param {string[]} [categories] 现有支出分类名
 * @param {{catHint?:number, custom?:string}} [opts]
 */
function vlPrompt(todayKey, categories, opts) {
  const o = opts || {};
  const hint = Number.isFinite(Number(o.catHint)) ? Math.max(0, Math.min(40, Math.round(Number(o.catHint)))) : AI_DEFAULTS.catHint;
  const cats = (Array.isArray(categories) ? categories : [])
    .map((x) => String(x || '').trim()).filter(Boolean).slice(0, hint);
  const custom = String(o.custom || '').trim();
  // 自定义优先；为空则用内置模板。两者共用下面的占位符替换。
  const tpl = custom || DEFAULT_PROMPT;
  return fillPrompt(tpl, todayKey, cats);
}

/**
 * 把 {today} / {categories} 填进模板（v4.3.2）。
 * 单独抽出来是为了让「内置」与「自定义」走同一条代码路径 ——
 * 同时它也是设置页「恢复默认」按钮背后那份默认文本的来源。
 * @param {string} tpl
 * @param {string} todayKey
 * @param {string[]} cats 已截断的分类名
 */
function fillPrompt(tpl, todayKey, cats) {
  return String(tpl || '')
    .replace(/\{today\}/g, String(todayKey || ''))
    .replace(/\{categories\}/g, cats.length ? cats.join('、') : DEFAULT_CATEGORY_HINT)
    .slice(0, 4000);
}


/* ── 调用 ─────────────────────────────────────────────────── */

/**
 * 进程内记忆：某个模型不认哪些扩展参数（避免每次都白跑一次 400）。
 * 只存内存 —— 重启后重新学一次，代价就是一次多余的请求，不值得落库。
 */
const paramUnsupported = new Map();
function unsupportedOf(model) {
  const m = String(model || '');
  if (!paramUnsupported.has(m)) paramUnsupported.set(m, new Set());
  return paramUnsupported.get(m);
}

/**
 * 调一次 AI 服务的 chat/completions（单次，不重试）。
 *
 * v4.24.0 需求 1：**通用平台** —— 请求地址由 `p.baseUrl` 决定（OpenAI 兼容端点），
 *   不再写死任何一个平台。
 *   · `enable_thinking` / `thinking_budget` 是**百炼的扩展参数**，只在百炼端点发送；
 *     其它平台发了多半会 400（参数自愈机制虽然能剥离，但每次都白吃一个失败请求）。
 *   · 混合思考模型默认「开思考」（官方实测总耗时约为非思考的 3 倍）；
 *     账单抽取这种任务完全不需要思考，所以百炼端点默认显式关掉。
 *   · `max_tokens` —— 限制输出长度，避免跑飞。
 *   · 请求超时 —— 到点必断并给出可操作的提示。
 *   · 上游不认某个扩展参数时（400），把参数名记下来、从请求里剥掉并抛 `AI_PARAM`，
 *     由 chatWithRetry 立刻重试 —— 「为了提速反而不可用」不会发生。
 *
 * @param {{model:string, content:any, system?:string, apiKey:string, baseUrl?:string,
 *          temperature?:number, maxTokens?:number, thinking?:boolean, thinkingBudget?:number,
 *          timeoutMs?:number}} p
 * @param {{fetchImpl?:Function, log?:object}} [opts] `log` 传 {userId, action, images} 时记 ai_logs
 * @returns {Promise<{text:string, usage:object|null}>} 模型回复文本与 token 用量
 */
async function chatOnce(p, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || defaultFetch;
  const skip = unsupportedOf(p.model);
  const baseUrl = String(p.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const dashScope = isDashScope(baseUrl);
  const modelName = String(p.model || '');
  const reasoning = REASONING_MODEL_RE.test(modelName);
  const body = { model: p.model, messages: [] };
  /* v4.25.0：采样参数固定（温度 0 / 输出 1024），不再从设置读。
     推理型模型不认这两个参数（发了 400 → 自愈剥一轮 → 整张图白重发），所以直接不发。 */
  if (!reasoning && !skip.has('temperature')) body.temperature = SPEED.temperature;
  if (!reasoning && !skip.has('max_tokens')) body.max_tokens = SPEED.maxTokens;
  /* 思考开关（固定关）：百炼是 `enable_thinking`，其它平台的推理型模型是 `reasoning_effort`。
     上游不认就记进 skip，下次不再发 —— 不做「每次都白吃一个 400」这种事。 */
  if (dashScope && THINKING_RE.test(modelName) && !skip.has('enable_thinking')) {
    body.enable_thinking = false;
  } else if (!dashScope && MAY_THINK_RE.test(modelName) && !skip.has('reasoning_effort')) {
    body.reasoning_effort = /api\.openai\.com/i.test(baseUrl) ? 'minimal' : 'none';
  }
  if (p.system) body.messages.push({ role: 'system', content: p.system });
  body.messages.push({ role: 'user', content: p.content });

  const started = Date.now();
  const timeoutMs = Math.round(Number(p.timeoutMs) || AI_DEFAULTS.timeoutMs);
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  let res = null;
  try {
    if (ctl && timeoutMs > 0) timer = setTimeout(() => { try { ctl.abort(); } catch { /* 忽略 */ } }, timeoutMs);
    res = await fetchImpl(chatUrlOf(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
  } catch (err) {
    const aborted = !!(err && (err.name === 'AbortError' || /abort/i.test(String(err && err.message))));
    if (o.log) logAi({ ...o.log, model: p.model, ok: false, error: aborted ? 'timeout' : 'network', durationMs: Date.now() - started });
    throw aborted
      ? Object.assign(new Error(`AI 服务 ${Math.round(timeoutMs / 1000)} 秒内没有返回（可在设置里调大超时，或换一个更快的模型）`), { status: 504, code: 'AI_TIMEOUT' })
      : Object.assign(new Error('连不上 AI 服务，请检查「接口地址」是否填对、服务器能否出网'), { status: 502, code: 'AI_NETWORK' });
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!data) {
    if (o.log) logAi({ ...o.log, model: p.model, ok: false, error: 'bad-response', durationMs: Date.now() - started });
    throw Object.assign(new Error('AI 服务返回了无法解析的内容，请检查「接口地址」是否指向 OpenAI 兼容端点'), { status: 502, code: 'AI_BAD_RESPONSE' });
  }
  if (data.error || data.code) {
    const msg = (data.error && (data.error.message || data.error.code)) || data.message || data.code || data.code_no;
    const text = String(msg || '');
    if (o.log) logAi({ ...o.log, model: p.model, ok: false, error: text.slice(0, 300), durationMs: Date.now() - started });
    /* v4.3.0：上游不认某个扩展参数（enable_thinking / thinking_budget / max_tokens…）
       → 记下来、剥掉、立刻重试。这是「优化参数反而把功能弄坏」的兜底。 */
    const paramHit = /(enable_thinking|thinking_budget|reasoning_effort|max_tokens|temperature)/i.exec(text);
    if (paramHit && /unsupport|not support|unrecognized|unknown|invalid|illegal|不支持|无法识别|非法|多余/i.test(text)) {
      const name = paramHit[1].toLowerCase();
      unsupportedOf(p.model).add(name);
      throw Object.assign(new Error(`当前模型不接受参数 ${name}（已自动去掉后重试）：${text}`), {
        status: 502, code: 'AI_PARAM', param: name,
      });
    }
    /* v4.2.0 需求 2：把「模型本身不可用」类错误单独分出来（AI_MODEL）。
       它们重试多少次都一样，白白烧 token —— 交给上层直接换模型（自愈），不再重试。 */
    const modelErr = /model|模型/i.test(text)
      && /not\s*(found|exist|support)|invalid|unsupport|denied|forbidden|nonexist|不存在|无权限|未开通|不支持/i.test(text);
    throw Object.assign(new Error(`AI 调用失败：${msg || `HTTP ${res && res.status}`}`), {
      status: 502, code: modelErr ? 'AI_MODEL' : 'AI_UPSTREAM',
    });
  }
  const choice = Array.isArray(data.choices) && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  const text = Array.isArray(content) ? content.map((c) => (c && c.text) || '').join('') : String(content || '');
  if (!text.trim()) {
    if (o.log) logAi({ ...o.log, model: p.model, ok: false, error: 'empty', durationMs: Date.now() - started });
    throw Object.assign(new Error('AI 返回了空回复，请稍后重试'), { status: 502, code: 'AI_EMPTY' });
  }
  const usage = data.usage || null;
  if (o.log) {
    logAi({ ...o.log, model: p.model, usage, ok: true, durationMs: Date.now() - started });
  }
  return { text, usage };
}

/**
 * 带重试的调用。重试次数由设置决定（默认 1 次 = 最多 2 个请求）。
 *   · `AI_PARAM` → 参数已自动剥掉，**立刻重试**且不占失败次数（最多剥 3 个）；
 *   · `AI_MODEL` / `AI_TIMEOUT` / 剥完还是 `AI_PARAM` → 不重试，交给上层（换模型 / 报错）。
 * 需求 7 明确「防止无限循环导致 token 爆量」—— 重试永远是定数的。
 */
async function chatWithRetry(p, opts) {
  const o = opts || {};
  const max = Math.max(0, Math.min(3, Number(p.retry != null ? p.retry : AI_DEFAULTS.retry) || 0));
  const started = Date.now();
  const budgetMs = Math.round(Number(p.timeoutMs) || AI_DEFAULTS.timeoutMs);
  let lastErr = null;
  for (let attempt = 0; ; attempt++) {
    try {
      // 重试那次不再重复记日志（chatOnce 每次都记；失败两条 + 成功一条是真实成本，如实记）
      return await chatOnce(p, attempt === 0 ? o : { fetchImpl: o.fetchImpl });
    } catch (err) {
      lastErr = err;
      const code = err && err.code;
      if (code === 'AI_PARAM' && attempt < 3) continue;   // 剥参数后立刻再来一次
      if (code === 'AI_MODEL' || code === 'AI_TIMEOUT' || code === 'AI_PARAM') break;
      if (attempt >= max) break;
      /* v4.25.0 提速：已经耗掉一半超时预算就不要再重试。
         一次「慢失败」再排一轮，用户看到的是两倍等待；而慢通常不是抖动，重试也快不起来。 */
      if (Date.now() - started > budgetMs * 0.5) break;
    }
  }
  throw lastErr;
}

/** AI 前置检查（未配置 / 停用 / 超额度）：都抛带 code 的错，调用方据此降级 */
function ensureAiAvailable(tzOffsetMinutes) {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    throw Object.assign(new Error('还没配置 AI 服务：请管理员在「AI 参数设置」里填接口地址、API Key 和模型 ID'), { status: 400, code: 'AI_NOT_CONFIGURED' });
  }
  if (!cfg.enabled) {
    throw Object.assign(new Error('AI 功能已被管理员停用'), { status: 403, code: 'AI_DISABLED' });
  }
  const q = quota(tzOffsetMinutes);
  if (q.exhausted) {
    throw Object.assign(
      new Error(`本月 AI 额度已用完（${q.limit} 次），已自动转为手动录入；下个月 1 号自动恢复`),
      { status: 429, code: 'AI_QUOTA_EXHAUSTED' },
    );
  }
  return { cfg, q };
}

/**
 * v4.25.0 提速：同一张图 10 分钟内重复识别直接复用**模型原始输出**。
 *
 * 只缓存 `text`（模型吐出来的那段 JSON），不缓存归一化结果 ——
 * 归一化要用当时的分类清单与用户规则，几毫秒的事，重算才不会出现
 * 「刚建了个分类，再识别同一张图还是旧分类」这种怪事。
 *
 * 进程内缓存、最多 12 条（一张图几十 KB 文本，12 条可忽略），
 * 重启即失效 —— 不做持久化：识别是「点一下就要结果」的动作，缓存只为
 * 「手抖点了两次 / 企微里重发一次」，不需要跨重启。
 */
const OCR_CACHE = new Map();
const OCR_CACHE_TTL = 10 * 60 * 1000;
const OCR_CACHE_MAX = 12;

function ocrCacheKey(model, dataUrl) {
  return crypto.createHash('sha1').update(`${model}\n${dataUrl}`).digest('hex');
}
function cacheGet(key) {
  const e = OCR_CACHE.get(key);
  if (!e) return '';
  if (Date.now() - e.at > OCR_CACHE_TTL) { OCR_CACHE.delete(key); return ''; }
  OCR_CACHE.delete(key);          // 重新插到队尾（近似 LRU）
  OCR_CACHE.set(key, e);
  return e.text;
}
function cachePut(key, text) {
  if (!text) return;
  OCR_CACHE.set(key, { text, at: Date.now() });
  while (OCR_CACHE.size > OCR_CACHE_MAX) OCR_CACHE.delete(OCR_CACHE.keys().next().value);
}
/** 测试用：清空识别缓存（避免用例之间互相命中） */
function clearCache() { OCR_CACHE.clear(); }

/**
 * 识别一张账单截图（视觉模型）。
 *
 * v4.2.0 需求 2：**选定模型被上游拒绝时自动自愈** —— 失败且不是网络问题时，
 * 自动改用默认模型再试一次，成功就把可用的模型回写进设置并如实回报 `fallback`。
 * v4.3.0：自愈受设置项 `ai_fallback` 控制（自定义模型场景下有人希望「错了就报错」，不偷偷换）。
 *
 * v4.3.0 需求 1：请求参数（思考开关 / 输出上限 / 温度 / 超时 / 重试）全部来自设置，
 *   默认「极速档」—— 这是「自定义模型解析很慢」的正面修复。
 * v4.3.0 需求 2：现有分类清单进提示词 + 结果走三层归一（见 normalizeItems）。
 *
 * @param {string} dataUrl data:image/...;base64,....
 * @param {{todayKey?:string, categories?:string[], fetchImpl?:Function, tzOffsetMinutes?:number,
 *          vlModel?:string, userId?:number}} [opts]
 * @returns {Promise<{text:string, parsed:object, items:Array, skippedIncome:number, catStats:object,
 *          quota:object, model:string, fallback:({from:string,to:string}|null)}>}
 */
async function recognizeBill(dataUrl, opts) {
  const o = opts || {};
  const { cfg } = ensureAiAvailable(o.tzOffsetMinutes);
  base64Of(dataUrl); // 只做格式与大小校验；OpenAI 兼容端点都直接吃 data URL
  const fetchImpl = o.fetchImpl || defaultFetch;
  let model = MODEL_RE.test(String(o.vlModel || '')) ? String(o.vlModel) : cfg.vlModel;
  const todayKey = DATE_RE.test(String(o.todayKey || '')) ? o.todayKey : undefined;
  /* v4.3.0 需求 2：现有分类既要进提示词，也要参与结果归一。
     ★ v4.3.1：**进提示词的条数**由 ai_cat_hint 控制（默认 12，越少提示词越短）；
       而**归一判定**始终用完整清单 —— 少喂上下文不能牺牲归一的准确率。 */
  const cats = (Array.isArray(o.categories) ? o.categories : []).map((x) => String(x || '').trim()).filter(Boolean);
  /* v4.8.0 需求 1：调用方显式传的参数优先，没传才回落到 settings。
     这样「网页上传」与「企业微信发图」可以各传一份**同一个函数**产出的参数集，
     既能保证同源，也留出了单测覆盖单参数的口子。 */
  const pick = (k) => (o[k] != null ? o[k] : cfg[k]);
  const catHint = pick('catHint');
  const promptCustom = pick('promptCustom');
  const categoryMode = o.categoryMode || cfg.categoryMode;
  const prompt = vlPrompt(todayKey || '', cats, { catHint, custom: promptCustom });

  const attempt = async (useModel) => {
    const out = await chatWithRetry({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: useModel,
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: prompt },
      ],
      /* v4.25.0 需求 3：温度 / 输出上限 / 思考开关都不再从设置读，
         由 chatOnce 按模型能力决定（见 SPEED 与 REASONING_MODEL_RE）。 */
      timeoutMs: pick('timeoutMs'),
      retry: pick('retry'),
    }, { fetchImpl, log: { userId: o.userId, action: 'ocr', images: 1 } });
    /* v4.3.1 需求 3：**识别成功才计一次调用**。
       旧实现是「发请求前就 +1」，理由是「远端已经算过一次调用」—— 但那对用户不公平：
       网络抖动 / 模型填错 / 超时都会白扣一次额度，家里没人愿意为失败付费。
       现在失败的调用只在 ai_logs 里留痕（可审计），**不占月度额度**；
       一次识别最多 retry+1 个请求，仍是定数，刷不了额度。 */
    addUsage(quota(o.tzOffsetMinutes).month);
    return out;
  };

  const t0 = Date.now();
  /* ★ 缓存口径：生产路径（不注入 fetchImpl）默认走缓存；调用方注入了 fetchImpl 说明
     「我要看真实请求」，此时除非显式 `cache:true`，否则不读不写缓存 ——
     否则测试里同一张图连识别两次，第二次根本不打上游，断言会莫名其妙全红。 */
  const useCache = o.cache === true || (!o.fetchImpl && o.cache !== false);
  const cachedText = useCache ? cacheGet(ocrCacheKey(model, dataUrl)) : '';
  let text = '';
  let fallback = null;
  let cached = false;
  let modelMs = 0;
  if (cachedText) {
    text = cachedText;
    cached = true;
  } else {
    try {
      ({ text } = await attempt(model));
    } catch (err) {
      // 网络问题换模型也没用；管理员关掉自愈也不换；本就是默认模型则无从可换
      if ((err && err.code) === 'AI_NETWORK' || !cfg.fallback || model === cfg.defaultModel) throw err;
      ({ text } = await attempt(cfg.defaultModel));
      fallback = { from: model, to: cfg.defaultModel };
      model = cfg.defaultModel;
      // 回写设置：下次直接走能用的那个，不再让管理员反复踩同一个坑
      try {
        db.run(
          "INSERT INTO settings (key, value) VALUES ('ai_vl_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [model],
        );
      } catch { /* 回写失败不影响这次识别 */ }
    }
    modelMs = Date.now() - t0;
    // 缓存键用**实际成功**的模型（自愈换了模型时不能还挂在旧模型名下）
    if (useCache) cachePut(ocrCacheKey(model, dataUrl), text);
  }
  /** 本次识别的耗时拆解：模型等待多久、总共多久（前端据此显示「识别完成 · 6.3 秒」） */
  const timings = { totalMs: 0, modelMs, cached };

  const json = extractJson(text);
  /* v4.17.0 需求 5：用户自维护的「关键词 → 分类」规则随调用方传入，
     AI 归一（matchCategory）与逐行兜底（parseOcrItems / parseOcrText）共用同一份。 */
  const rules = Array.isArray(o.rules) ? o.rules : [];
  const norm = json
    ? normalizeItems(json.items, { todayKey: todayKey || '', categories: cats, categoryMode, rules })
    : { items: [], skippedIncome: 0, catStats: { exact: 0, alias: 0, contains: 0, created: 0, other: 0 } };
  if (!norm.items.length) {
    // 兜底：模型没按格式回（或截图里确实是普通文字账单）→ 用逐行解析再试一次
    const legacy = billparse.parseOcrItems(text, { todayKey: todayKey || '', extraCategories: cats, rules });
    const legacyParsed = billparse.parseOcrText(text, { todayKey: todayKey || '', extraCategories: cats, rules });
    return {
      text,
      parsed: legacyParsed,
      items: legacy.items,
      skippedIncome: norm.skippedIncome || legacy.skippedIncome || 0,
      catStats: norm.catStats,
      quota: quota(o.tzOffsetMinutes),
      model,
      fallback,
      cached,
      timings: { ...timings, totalMs: Date.now() - t0 },
    };
  }
  return {
    text,
    parsed: norm.items[0]
      ? { ok: true, amountCents: norm.items[0].amountCents, dateKey: norm.items[0].dateKey,
        note: norm.items[0].note, category: norm.items[0].category, kind: 'expense' }
      : { ok: false },
    items: norm.items,
    skippedIncome: norm.skippedIncome,
    catStats: norm.catStats,
    quota: quota(o.tzOffsetMinutes),
    model,
    fallback,
    cached,
    timings: { ...timings, totalMs: Date.now() - t0 },
  };
}

/* ── 预设模型（v4.3.0 需求 1） ────────────────────────────────
   ★ 用户明确要求「不再由系统自动获取可用模型」—— v4.3.0 **删掉了**
     `GET /models` 的拉取、模型列表缓存与「一键获取」按钮。
     模型由管理员自由填写（自定义），下面几条只是省事的快捷预设，零网络请求。 */

/** 一个候选模型条目（价格文案 + 排序档位 + 视觉可用性提示） */
function mkModel(id, known) {
  const hit = (known || []).filter((m) => m.id === id)[0];
  return {
    id,
    label: hit && hit.label ? hit.label : id,
    price: priceOf(id),
    tier: tierOf(id),
    recommended: hit ? !!hit.tier : false,
    // 只做提示：名字看着不像视觉模型时给管理员一句提醒（不拦截保存）
    vision: looksVision(id),
  };
}

/** 预设候选（静态表，不发任何请求） */
function modelPresets() {
  const vl = MODEL_PRESETS.map((m) => mkModel(m.id, MODEL_PRESETS))
    .sort((a, b) => (a.tier - b.tier) || a.id.localeCompare(b.id));
  return { vl, fetchedAt: '', total: vl.length, skipped: 0, auto: false };
}

/** 单个模型的信息（界面显示「当前使用的自定义模型」的价格与提示用） */
function modelInfo(id) {
  return mkModel(String(id || '').trim(), MODEL_PRESETS);
}

/** 管理端 / 记账页「当月用量」展示（次数 + token 总额，均按自然月） */
function usageInfo(tzOffsetMinutes) {
  const q = quota(tzOffsetMinutes);
  const cfg = loadConfig();
  const mu = monthUsage(tzOffsetMinutes);
  return {
    ...q,
    // v4.2.0 需求 3：本月已用次数与 token 消耗总额（自然月自动归零，见 monthUsage 注释）
    calls: mu.calls,
    tokens: mu.tokens,
    promptTokens: mu.promptTokens,
    completionTokens: mu.completionTokens,
    configured: isConfigured(),
    enabled: cfg.enabled,
    ready: aiReady() && !q.exhausted,
    source: cfg.source,
    legacy: !!cfg.legacy,
    baseUrl: cfg.baseUrl,
    chatUrl: cfg.chatUrl,
    vlModel: cfg.vlModel,
    defaultModel: cfg.defaultModel,
    /* v4.3.0 需求 1：把当前参数回显给管理端（界面要能编辑它们）。
       密钥永不在此 —— 这里只有「模型 + 性能与体验开关」。
       v4.25.0 需求 3：思考模式 / 思考预算 / 最大输出 / 采样温度已下线，不再回显。 */
    ai: {
      timeoutMs: cfg.timeoutMs,
      retry: cfg.retry,
      fallback: cfg.fallback,
      categoryMode: cfg.categoryMode,
      imgCompress: cfg.imgCompress,
      imgEdge: cfg.imgEdge,
      imgQuality: cfg.imgQuality,
      imgKb: cfg.imgKb,
      // v4.3.1 需求 4：提示词可配（自定义模板 + 分类条数）
      catHint: cfg.catHint,
      promptCustom: cfg.promptCustom,
      /* v4.3.2 需求 2：内置提示词**模板**（含 {today} / {categories} 占位符）回显给设置页。
         界面用它预填「自定义提示词」输入框，并在「恢复默认」时还原成它。
         注意这里给的是**模板**而不是已填好的成品 —— 填好的成品里嵌着「今天」和当时的分类，
         存回去就固化了，明天再打开就对不上了。 */
      defaultPrompt: DEFAULT_PROMPT,
    },
    // v4.3.0：预设候选（静态，不再自动获取）
    models: modelPresets(),
    // 当前模型的信息（自定义时界面据此显示价格 / 视觉可用性提示）
    currentModel: modelInfo(cfg.vlModel),
  };
}

module.exports = {
  MONTHLY_FREE, WARN_AT, MAX_IMAGE_BYTES, CHAT_URL, AI_DEFAULTS, SPEED,
  DEFAULT_BASE_URL, LEGACY_DASHSCOPE_BASE, DEFAULT_MODEL_LEGACY,
  VL_MODELS, MODEL_PRESETS, DEFAULT_VL_MODEL, MODEL_RE, THINKING_RE,
  MAY_THINK_RE, REASONING_MODEL_RE,
  chatUrlOf, isDashScope, clearCache,
  loadConfig, imagePrefs, billParams, imageFacts, inspectIncomingImage,
  isConfigured, aiReady, quota, monthlyLimit, usedIn, addUsage, usageInfo,
  currentMonth, recognizeBill, resetTokenCache, base64Of,
  chatOnce, chatWithRetry, logAi, listLogs, modelPresets, modelInfo,
  extractJson, normalizeItems, normDate, vlPrompt, unsupportedOf,
  // v4.3.2 需求 2：内置提示词模板（设置页预填 / 恢复默认的唯一来源）
  DEFAULT_PROMPT, DEFAULT_CATEGORY_HINT, fillPrompt,
  // v4.2.0：本月 token 用量（需求 3）
  monthUsage,
  // v4.3.0：价格口径 + 模型可用性提示（需求 1/2）
  priceOf, tierOf, looksVision, isVisionChatModel, PRICE_TABLE, NON_CHAT_RE, VL_RE,
};
