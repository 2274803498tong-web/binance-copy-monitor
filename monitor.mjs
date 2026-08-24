import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const USER_CAPITAL_USDT = 97.69;
const STATE_PATH = process.env.STATE_PATH || ".state/monitor.json";
const BINANCE_BASE =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade";

const LEADERS = {
  aoYing: {
    name: "熬鹰资本",
    id: "5075281354358777856",
  },
  pikachu: {
    name: "皮卡丘征服星辰大海",
    id: "4982308422483092480",
  },
};

const REQUEST_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  clienttype: "web",
  lang: "zh-CN",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
};

await runMonitor();

async function runMonitor() {
  const dryRun = process.env.DRY_RUN === "true";
  if (!dryRun && !process.env.PUSHPLUS_TOKEN) {
    throw new Error("缺少 PUSHPLUS_TOKEN GitHub Secret");
  }

  const previous = await readState();
  const next = {
    version: 2,
    checkedAt: Date.now(),
    leaders: {},
    errors: {},
  };
  const notices = [];

  await checkAoYing(previous, next, notices);
  await checkPikachu(previous, next, notices);

  for (const key of Object.keys(previous.errors || {})) {
    if (!next.errors[key]) {
      notices.push(`✅ ${key}：公开数据读取已恢复。`);
    }
  }

  if (notices.length > 0) {
    const content = notices.join("\n\n---\n\n");
    if (dryRun) {
      console.log(content);
      console.log(`试运行完成，共生成 ${notices.length} 条通知，未实际推送。`);
    } else {
      await sendPushPlus(content);
      console.log(`已推送 ${notices.length} 条变化/状态通知。`);
    }
  } else {
    console.log("两名带单员均无实质变化，不发送通知。");
  }

  await saveState(next);
}

async function checkAoYing(previous, next, notices) {
  const leader = LEADERS.aoYing;
  try {
    const [detail, fills] = await Promise.all([
      getLeaderDetail(leader.id),
      getTradeHistory(leader.id),
    ]);
    const groups = aggregateFills(fills).slice(0, 100);
    const old = previous.leaders?.aoYing;
    const oldKeys = new Set(old?.tradeKeys || []);
    const isFirstRun = !old;
    const changed = isFirstRun
      ? groups.slice(0, 2)
      : groups.filter((item) => !oldKeys.has(item.key));

    next.leaders.aoYing = {
      tradeKeys: groups.map((item) => item.key),
      marginBalance: detail.marginBalance,
      positionShow: detail.positionShow,
    };

    if (changed.length === 0) return;

    const gateMap = new Map();
    for (const item of changed.slice(0, 10)) {
      if (!gateMap.has(item.symbol)) {
        gateMap.set(item.symbol, await getGateContract(item.symbol));
      }
    }

    const lines = [
      `## ${isFirstRun ? "监控基线已建立" : "发现新交易记录"}｜${leader.name}`,
      "### 公开信号",
      `- 查询时间：${formatTime(Date.now())}`,
      `- 公开保证金余额：${fmt(detail.marginBalance, 2)} USDT`,
      `- 当前仓位展示：${detail.positionShow ? "公开" : "关闭"}`,
    ];

    for (const item of changed.slice(0, 10)) {
      const gate = gateMap.get(item.symbol);
      lines.push(
        "",
        `#### ${tradeAction(item)} ${item.symbol}`,
        `- 公开成交时间：${formatTime(item.time)}`,
        `- 方向：${positionDirection(item.positionSide)}`,
        `- 成交数量：${fmt(item.qty, 8)} ${item.baseAsset}`,
        `- 成交均价：${fmt(item.avgPrice, 8)} USDT`,
        `- 名义价值：${fmt(item.notional, 2)} USDT`,
        `- 已实现盈亏：${fmt(item.realizedProfit, 4)} USDT`,
        "",
        "### 比例计算",
        "- 该公开成交记录没有公开杠杆和成交后的剩余净仓位，公开数据不足，无法精确换算。",
        "",
        "### Gate合约换算",
      );
      if (gate.exists) {
        lines.push(
          `- ${gate.name} 合约存在；标记价 ${fmt(gate.markPrice, 8)}；合约乘数 ${gate.multiplier}；最小数量 ${gate.minSize}；最高杠杆 ${gate.maxLeverage}x。`,
          "- 因币安公开数据缺少杠杆与剩余净仓位，无法给出伪精确的Gate模拟数量。",
        );
      } else {
        lines.push("- Gate无对应USDT永续合约，无法按该信号模拟。");
      }
      lines.push(
        "",
        "### 数据缺口/风险",
        "- 最新成交记录不等于完整当前持仓，不据此猜测剩余净仓位。",
      );
    }

    lines.push("", simulationNotice());
    notices.push(lines.join("\n"));
  } catch (error) {
    recordError(leader.name, error, previous, next, notices);
  }
}

async function checkPikachu(previous, next, notices) {
  const leader = LEADERS.pikachu;
  try {
    const [detail, rawPositions] = await Promise.all([
      getLeaderDetail(leader.id),
      getPositions(leader.id),
    ]);
    const positions = rawPositions
      .filter((item) => Number(item.positionAmount) !== 0)
      .map(normalizePosition)
      .sort((a, b) => a.id.localeCompare(b.id));

    const old = previous.leaders?.pikachu;
    const oldPositions = old?.positions || [];
    const changes = diffPositions(oldPositions, positions);
    const isFirstRun = !old;

    next.leaders.pikachu = {
      positions,
      marginBalance: detail.marginBalance,
      positionShow: detail.positionShow,
    };

    if (!isFirstRun && changes.length === 0) return;

    const gatePairs = await Promise.all(
      positions.map(async (position) => [
        position.id,
        await getGateContract(position.symbol),
      ]),
    );
    const gateMap = new Map(gatePairs);
    const lines = [
      `## ${isFirstRun ? "监控基线已建立" : "持仓发生变化"}｜${leader.name}`,
      "### 公开信号",
      `- 查询时间：${formatTime(Date.now())}`,
      `- 公开保证金余额：${fmt(detail.marginBalance, 2)} USDT`,
      `- 变化：${isFirstRun ? "首次记录当前公开仓位" : changes.join("；")}`,
    ];

    if (positions.length === 0) {
      lines.push("- 当前没有 positionAmount 非0的公开仓位。");
    }

    let totalUserMargin = 0;
    let allCalculable = true;
    for (const position of positions) {
      const notional = Math.abs(Number(position.notionalValue));
      const leverage = Number(position.leverage);
      const marginBalance = Number(detail.marginBalance);
      const calculable =
        Number.isFinite(notional) &&
        notional >= 0 &&
        Number.isFinite(leverage) &&
        leverage > 0 &&
        Number.isFinite(marginBalance) &&
        marginBalance > 0;
      const leaderMargin = calculable ? notional / leverage : NaN;
      const ratio = calculable ? leaderMargin / marginBalance : NaN;
      const userMargin = calculable ? USER_CAPITAL_USDT * ratio : NaN;
      const userNotional = calculable ? userMargin * leverage : NaN;
      if (calculable) totalUserMargin += userMargin;
      else allCalculable = false;
      const gate = gateMap.get(position.id);

      lines.push(
        "",
        `#### ${position.symbol} ${positionDirection(position.positionSide)}`,
        `- 保证金模式：${position.isolated ? "逐仓" : "全仓"}`,
        `- 杠杆：${fmt(leverage, 2)}x`,
        `- 仓位数量：${fmt(Math.abs(Number(position.positionAmount)), 8)}`,
        `- 开仓均价：${fmt(position.entryPrice, 8)} USDT`,
        `- 标记价格：${fmt(position.markPrice, 8)} USDT`,
        `- 名义仓位：${fmt(notional, 2)} USDT`,
        `- 估算仓位保证金：${fmt(leaderMargin, 2)} USDT（名义价值÷杠杆）`,
        `- 未实现盈亏：${fmt(position.unrealizedProfit, 4)} USDT`,
        "",
        "### 比例计算",
      );

      if (calculable) {
        lines.push(
          `- 估算保证金占比：${fmt(ratio * 100, 4)}%`,
          `- 你的模拟保证金：${fmt(userMargin, 4)} USDT`,
          `- 你的模拟名义仓位：${fmt(userNotional, 4)} USDT`,
        );
      } else {
        lines.push("- 公开数据不足，无法精确换算。");
      }

      lines.push("", "### Gate合约换算");
      if (calculable && gate.exists) {
        const perContract = gate.markPrice * gate.multiplier;
        const rawSize = perContract > 0 ? userNotional / perContract : NaN;
        const size = Number.isFinite(rawSize)
          ? Math.floor(rawSize / gate.orderStep) * gate.orderStep
          : NaN;
        if (Number.isFinite(size) && size >= gate.minSize) {
          const roundedNotional = size * perContract;
          lines.push(
            `- ${gate.name}：${fmt(size, 8)}张（每张约 ${fmt(perContract, 6)} USDT）`,
            `- 取整后名义价值：${fmt(roundedNotional, 4)} USDT`,
            `- 取整后模拟保证金：${fmt(roundedNotional / leverage, 4)} USDT`,
            `- 合约乘数：${gate.multiplier}；最小数量：${gate.minSize}；数量步长：${gate.orderStep}；最高杠杆：${gate.maxLeverage}x`,
          );
        } else {
          lines.push("- 取整后低于最小下单量，Gate无法按该信号模拟。");
        }
      } else if (!gate.exists) {
        lines.push("- Gate无对应USDT永续合约，无法按该信号模拟。");
      } else {
        lines.push("- 公开数据不足，Gate无法按该信号模拟。");
      }

      lines.push(
        "",
        "### 数据缺口/风险",
        "- 保证金为公开名义价值÷公开杠杆的估算值，不代表平台实际冻结额。",
      );
    }

    lines.push("");
    if (allCalculable) {
      lines.push(
        `模拟保证金合计：${fmt(totalUserMargin, 4)} USDT，占97.69的 ${fmt((totalUserMargin / USER_CAPITAL_USDT) * 100, 4)}%。`,
      );
      if (totalUserMargin > USER_CAPITAL_USDT) {
        lines.push("⚠️ 模拟保证金合计超过97.69 USDT，不自行缩放。");
      }
    } else {
      lines.push("公开数据不足，无法确认全部仓位的模拟保证金合计。");
    }
    lines.push(simulationNotice());
    notices.push(lines.join("\n"));
  } catch (error) {
    recordError(leader.name, error, previous, next, notices);
  }
}

function recordError(name, error, previous, next, notices) {
  const message = error instanceof Error ? error.message : String(error);
  next.errors[name] = message;
  if (previous.errors?.[name] !== message) {
    notices.push(`⚠️ ${name}：无法确认公开数据。${message}`);
  }
}

async function getLeaderDetail(portfolioId) {
  return fetchBinance(
    `${BINANCE_BASE}/lead-portfolio/detail?portfolioId=${portfolioId}`,
  );
}

async function getPositions(portfolioId) {
  return fetchBinance(
    `${BINANCE_BASE}/lead-data/positions?portfolioId=${portfolioId}`,
  );
}

async function getTradeHistory(portfolioId) {
  const data = await fetchBinance(
    `${BINANCE_BASE}/lead-portfolio/trade-history`,
    {
      method: "POST",
      body: JSON.stringify({ portfolioId, pageNumber: 1, pageSize: 100 }),
    },
  );
  return Array.isArray(data) ? data : data?.list || [];
}

async function fetchBinance(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...REQUEST_HEADERS, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `币安返回非JSON数据（HTTP ${response.status}），无法确认公开数据`,
    );
  }
  if (!response.ok || !payload.success) {
    throw new Error(
      `币安接口失败（HTTP ${response.status}，${payload.code || "无代码"}：${payload.message || "无说明"}）`,
    );
  }
  return payload.data;
}

async function getGateContract(binanceSymbol) {
  const contract = binanceSymbol.endsWith("USDT")
    ? `${binanceSymbol.slice(0, -4)}_USDT`
    : binanceSymbol;
  const response = await fetch(
    `https://api.gateio.ws/api/v4/futures/usdt/contracts/${encodeURIComponent(contract)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (response.status === 404) return { exists: false, name: contract };
  if (!response.ok) {
    throw new Error(`Gate合约查询失败（${contract}，HTTP ${response.status}）`);
  }
  const data = await response.json();
  return {
    exists: true,
    name: data.name,
    multiplier: Number(data.quanto_multiplier),
    minSize: Number(data.order_size_min),
    orderStep: Number(data.order_size_min) || 1,
    maxLeverage: Number(data.leverage_max),
    markPrice: Number(data.mark_price),
  };
}

async function sendPushPlus(content) {
  const response = await fetch("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: process.env.PUSHPLUS_TOKEN,
      ...(process.env.PUSHPLUS_TOPIC
        ? { topic: process.env.PUSHPLUS_TOPIC }
        : {}),
      title: "币安双带单监控提醒",
      content,
      template: "markdown",
      channel: "wechat",
    }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 200) {
    throw new Error(
      `PushPlus发送失败（HTTP ${response.status}，${payload?.code || "无代码"}：${payload?.msg || "无说明"}）`,
    );
  }
}

function aggregateFills(fills) {
  const groups = new Map();
  for (const fill of fills || []) {
    const groupKey = [
      fill.time,
      fill.symbol,
      fill.side,
      fill.positionSide,
    ].join("|");
    const current = groups.get(groupKey) || {
      time: Number(fill.time),
      symbol: fill.symbol,
      side: fill.side,
      positionSide: fill.positionSide,
      baseAsset: fill.baseAsset,
      qty: 0,
      notional: 0,
      realizedProfit: 0,
    };
    current.qty += Number(fill.qty || 0);
    current.notional += Number(fill.quantity || 0);
    current.realizedProfit += Number(fill.realizedProfit || 0);
    groups.set(groupKey, current);
  }
  return [...groups.values()]
    .map((item) => {
      const avgPrice = item.qty > 0 ? item.notional / item.qty : 0;
      return {
        ...item,
        avgPrice,
        key: [
          item.time,
          item.symbol,
          item.side,
          item.positionSide,
          item.qty,
          avgPrice,
        ].join("|"),
      };
    })
    .sort((a, b) => b.time - a.time);
}

function normalizePosition(item) {
  return {
    id: `${item.symbol}|${item.positionSide}`,
    symbol: item.symbol,
    positionAmount: String(item.positionAmount),
    entryPrice: String(item.entryPrice),
    markPrice: String(item.markPrice),
    leverage: String(item.leverage),
    isolated: Boolean(item.isolated),
    positionSide: item.positionSide,
    notionalValue: String(item.notionalValue),
    unrealizedProfit: String(item.unrealizedProfit),
  };
}

function diffPositions(before, after) {
  const oldMap = new Map(before.map((item) => [item.id, item]));
  const newMap = new Map(after.map((item) => [item.id, item]));
  const changes = [];
  const handled = new Set();

  const symbols = new Set([
    ...before.map((item) => item.symbol),
    ...after.map((item) => item.symbol),
  ]);
  for (const symbol of symbols) {
    const oldForSymbol = before.filter((item) => item.symbol === symbol);
    const newForSymbol = after.filter((item) => item.symbol === symbol);
    if (
      oldForSymbol.length === 1 &&
      newForSymbol.length === 1 &&
      oldForSymbol[0].positionSide !== newForSymbol[0].positionSide
    ) {
      changes.push(`${symbol} 反手`);
      handled.add(oldForSymbol[0].id);
      handled.add(newForSymbol[0].id);
    }
  }

  for (const id of new Set([...oldMap.keys(), ...newMap.keys()])) {
    if (handled.has(id)) continue;
    const oldItem = oldMap.get(id);
    const newItem = newMap.get(id);
    if (!oldItem && newItem) {
      changes.push(`${newItem.symbol} 新开${positionDirection(newItem.positionSide)}`);
      continue;
    }
    if (oldItem && !newItem) {
      changes.push(`${oldItem.symbol} 平${positionDirection(oldItem.positionSide)}`);
      continue;
    }
    const oldAmount = Math.abs(Number(oldItem.positionAmount));
    const newAmount = Math.abs(Number(newItem.positionAmount));
    if (newAmount > oldAmount) {
      changes.push(`${newItem.symbol} 加仓`);
    } else if (newAmount < oldAmount) {
      changes.push(`${newItem.symbol} 减仓`);
    }
    if (oldItem.leverage !== newItem.leverage) {
      changes.push(
        `${newItem.symbol} 杠杆 ${oldItem.leverage}x→${newItem.leverage}x`,
      );
    }
    if (oldItem.isolated !== newItem.isolated) {
      changes.push(
        `${newItem.symbol} ${oldItem.isolated ? "逐仓" : "全仓"}→${newItem.isolated ? "逐仓" : "全仓"}`,
      );
    }
  }
  return changes;
}

function tradeAction(item) {
  if (item.positionSide === "LONG") return item.side === "BUY" ? "开多" : "平多";
  if (item.positionSide === "SHORT") return item.side === "SELL" ? "开空" : "平空";
  return item.side === "BUY" ? "买入" : "卖出";
}

function positionDirection(side) {
  if (side === "LONG") return "多仓";
  if (side === "SHORT") return "空仓";
  return side || "未知";
}

function simulationNotice() {
  return "按静态基准97.69 USDT计算，实际余额变化未计入。纸面模拟，不是交易指令，不代表真实成交。";
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(Number(value)));
}

function fmt(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "无法确认";
  return number.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`状态文件读取失败，将重新建立基线：${error.message}`);
    }
    return {};
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}
