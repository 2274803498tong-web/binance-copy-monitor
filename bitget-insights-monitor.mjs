import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const BITGET_BASE = "https://www.bitget.com";
const USER_ID = "bcb54e7688b63157a794";
const USER_NAME = "丶十一";
const STATE_PATH =
  process.env.BITGET_STATE_PATH || ".state/bitget-insights.json";

const REQUEST_HEADERS = {
  accept: "application/json",
  "content-type": "application/json;charset=UTF-8",
  devicelanguage: "zh-CN",
  language: "zh-CN",
  locale: "zh-CN",
  terminaltype: "1",
  website: "content",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
};

export function isOrderSignal(content = "") {
  return /入场\s*[/／]\s*挂单\s*[:：]/u.test(content) && /止损\s*[:：]/u.test(content);
}

export function parseOrderSignal(article) {
  const content = String(article?.content || "").replace(/\r/g, "");
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  return {
    id: String(article?.id || ""),
    title: firstLine || "新挂单信号",
    direction: extractField(content, "方向"),
    entry: extractField(content, "入场\\s*[/／]\\s*挂单"),
    stopLoss: extractField(content, "止损"),
    target1: extractField(content, "目标\\s*1"),
    target2: extractField(content, "目标\\s*2"),
    publishedAt: Number(article?.publishTimeStamp || article?.updateTime || 0),
    url: `${BITGET_BASE}/zh-CN/insights/posts/${article?.id || ""}`,
  };
}

export function formatOrderSignal(signal) {
  const lines = [
    `## ⚠️ ${signal.title}`,
    "",
    `- 方向：${signal.direction || "未识别"}`,
    `- 入场/挂单：${signal.entry || "未识别"}`,
    `- 止损：${signal.stopLoss || "未识别"}`,
    `- 目标 1：${signal.target1 || "未识别"}`,
    `- 目标 2：${signal.target2 || "未识别"}`,
    `- 发布时间：${formatTime(signal.publishedAt)}`,
    `- 原文：[打开 Bitget 动态](${signal.url})`,
    "",
    "> 这是公开动态监控提醒，不代表真实成交，也不是投资建议。请核对币对、方向和价格后再操作。",
  ];
  return lines.join("\n");
}

function extractField(content, labelPattern) {
  const match = content.match(
    new RegExp(`(?:^|\\n)[^\\S\\r\\n]*(?:[^\\p{L}\\p{N}\\n]{0,4})?${labelPattern}\\s*[:：]\\s*([^\\n]+)`, "iu"),
  );
  return match?.[1]?.trim() || "";
}

async function runMonitor() {
  const dryRun = process.env.DRY_RUN === "true";
  if (!dryRun && !process.env.PUSHPLUS_TOKEN) {
    throw new Error("缺少 PUSHPLUS_TOKEN GitHub Secret");
  }

  const previous = await readState();
  const checkedAt = Date.now();

  try {
    const articles = await fetchLatestArticles(checkedAt);
    const articleIds = articles.map((article) => String(article.id));
    const next = {
      version: 1,
      checkedAt,
      knownArticleIds: [...new Set([...articleIds, ...(previous.knownArticleIds || [])])].slice(0, 100),
      lastError: null,
    };

    if (!previous.initializedAt) {
      next.initializedAt = checkedAt;
      const latestSignal = articles.find((article) => isOrderSignal(article.content));
      const lines = [
        `# 📌 ${USER_NAME}挂单动态监控已启动`,
        "",
        "- 状态：已建立当前动态基线",
        "- 检查频率：约每 5 分钟",
        "- 推送规则：仅通知含“入场/挂单”和“止损”的新动态",
        "- 普通动态：保持静默",
      ];
      if (latestSignal) {
        const signal = parseOrderSignal(latestSignal);
        lines.push(
          "",
          `- 当前最新信号：${signal.title}`,
          `- 发布时间：${formatTime(signal.publishedAt)}`,
          "",
          "> 当前最新信号仅用于建立基线，不当作刚发布的新信号提醒。",
        );
      }
      await deliver(
        `📌 ${USER_NAME}挂单监控已启动`,
        lines.join("\n"),
        dryRun,
      );
      await saveState(next);
      console.log(`已建立基线，共记录 ${articles.length} 条公开动态。`);
      return;
    }

    next.initializedAt = previous.initializedAt;
    const knownIds = new Set(previous.knownArticleIds || []);
    const newArticles = articles.filter(
      (article) => !knownIds.has(String(article.id)),
    );
    const newSignals = newArticles
      .filter((article) => isOrderSignal(article.content))
      .sort(
        (left, right) =>
          Number(left.publishTimeStamp || left.updateTime || 0) -
          Number(right.publishTimeStamp || right.updateTime || 0),
      );

    if (previous.lastError) {
      await deliver(
        `✅ ${USER_NAME}动态监控已恢复`,
        `# ✅ Bitget 动态读取已恢复\n\n- 博主：${USER_NAME}\n- 恢复时间：${formatTime(checkedAt)}\n\n后续继续仅推送新的挂单信号。`,
        dryRun,
      );
    }

    if (newSignals.length > 0) {
      const content = newSignals
        .map((article) => formatOrderSignal(parseOrderSignal(article)))
        .join("\n\n---\n\n");
      await deliver(
        `⚠️ ${USER_NAME}发布 ${newSignals.length} 条新挂单信号`,
        content,
        dryRun,
      );
      console.log(`已推送 ${newSignals.length} 条新挂单信号。`);
    } else {
      console.log(
        newArticles.length > 0
          ? `发现 ${newArticles.length} 条普通动态，按规则不推送。`
          : "没有新动态，保持静默。",
      );
    }

    await saveState(next);
  } catch (error) {
    const message = normalizeError(error);
    const next = {
      ...previous,
      version: 1,
      checkedAt,
      lastError: message,
    };
    if (previous.lastError !== message) {
      await deliver(
        `❌ ${USER_NAME}动态监控异常`,
        `# ❌ 暂时无法读取 Bitget 动态\n\n- 博主：${USER_NAME}\n- 时间：${formatTime(checkedAt)}\n- 原因：${message}\n\n本次不会把“读取失败”误报为没有新挂单；恢复后会自动通知。`,
        dryRun,
      );
    }
    await saveState(next);
    throw error;
  }
}

async function fetchLatestArticles(lastArticleTime) {
  const response = await fetchWithRetry(
    `${BITGET_BASE}/v1/social/public/articlesByTypeV3`,
    {
      method: "POST",
      headers: REQUEST_HEADERS,
      body: JSON.stringify({
        userId: USER_ID,
        size: 20,
        criteria: 0,
        page: 1,
        lastArticleTime,
      }),
    },
  );
  const payload = await parseJsonResponse(response);
  if (!response.ok || String(payload?.code) !== "200") {
    throw new Error(
      `Bitget 接口失败（HTTP ${response.status}，代码 ${payload?.code || "未知"}：${payload?.msg || "无说明"}）`,
    );
  }
  const items = payload?.data?.items;
  if (!Array.isArray(items)) {
    throw new Error("Bitget 接口未返回动态列表");
  }
  return items;
}

async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status < 500 && response.status !== 429) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Bitget 返回了无法解析的响应（HTTP ${response.status}）`);
  }
}

async function deliver(title, content, dryRun) {
  if (dryRun) {
    console.log(`${title}\n${content}`);
    return;
  }
  await sendPushPlus(title, content);
}

async function sendPushPlus(title, content) {
  const topics = String(process.env.BITGET_PUSHPLUS_TOPICS || "")
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);
  const destinations = topics.length > 0 ? topics : [undefined];

  for (const topic of destinations) {
    const response = await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: process.env.PUSHPLUS_TOKEN,
        title,
        content,
        template: "markdown",
        channel: "wechat",
        ...(topic ? { topic } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok || Number(payload?.code) !== 200) {
      throw new Error(
        `PushPlus 发送失败（${topic || "默认一对一"}，HTTP ${response.status}，${payload?.code || "无代码"}：${payload?.msg || "无说明"}）`,
      );
    }
    console.log(`PushPlus 发送成功：${topic || "默认一对一"}`);
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeError(error) {
  const causeCode = error?.cause?.code;
  const message = String(error?.message || error || "未知错误");
  return `${message}${causeCode ? `（${causeCode}）` : ""}`.slice(0, 500);
}

function formatTime(timestamp) {
  if (!timestamp) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(Number(timestamp)));
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  await runMonitor();
}
