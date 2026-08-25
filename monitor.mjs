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
  if (process.env.PREVIEW_UI === "true") {
    const preview = buildPreviewNotification();
    if (dryRun) console.log(preview);
    else {
      await sendPushPlus(
        "🎨【样式预览｜无需操作】监控通知",
        preview,
        process.env.PREVIEW_TOPIC || undefined,
      );
    }
    console.log("通知样式预览已生成，不读取或修改监控状态。");
    return;
  }

  const previous = await readState();
  const checkedAt = Date.now();
  const next = {
    version: 4,
    checkedAt,
    lastStatusAt: previous.lastStatusAt || previous.lastHealthAt || null,
    checksSinceStatus: Number(previous.checksSinceStatus || 0) + 1,
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

  const operationDetected = notices.some(
    (notice) =>
      notice.includes("【需要你处理】") ||
      notice.includes("【需要人工核对】"),
  );

  if (notices.length > 0) {
    const content = notices.join("\n\n---\n\n");
    if (dryRun) {
      console.log(content);
      console.log(`试运行完成，共生成 ${notices.length} 条通知，未实际推送。`);
    } else {
      await sendPushPlus(buildPushTitle(content), content);
      console.log(`已推送 ${notices.length} 条变化/状态通知。`);
    }
  } else {
    console.log("两名带单员均无实质变化，不发送通知。");
  }

  if (operationDetected) {
    next.lastStatusAt = checkedAt;
    next.checksSinceStatus = 0;
  }

  const statusDue =
    !operationDetected &&
    (!next.lastStatusAt ||
      checkedAt - Number(next.lastStatusAt) >= 60 * 60 * 1000);
  if (statusDue) {
    const status = buildHourlyStatusNotification(next);
    if (dryRun) {
      console.log(status.content);
      console.log("每小时状态通知试运行完成，未实际推送。");
    } else {
      await sendPushPlus(status.title, status.content);
      console.log(
        `已推送每小时状态通知：${status.ok ? "无操作" : "监控异常"}。`,
      );
    }
    next.lastStatusAt = checkedAt;
    next.checksSinceStatus = 0;
  } else {
    console.log(
      operationDetected
        ? "已推送操作变化，本次不再发送无操作通知。"
        : "距离上次状态通知不足60分钟，本次保持静默。",
    );
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
      isFirstRun
        ? `# 📌【状态基线｜无需操作】${leader.name}`
        : `# ⚠️【需要人工核对】${leader.name}有新成交`,
    ];
    if (!isFirstRun) {
      lines.push(
        "> **仓位展示已关闭：以下是新成交记录，不是完整当前仓位。**",
        "> **请先核对实际净仓，不能直接照搬成交数量。**",
      );
      for (const item of changed.slice(0, 10)) {
        lines.push(
          `> ${actionIcon(tradeAction(item))} **【${tradeAction(item)}】${item.symbol}｜${fmt(item.qty, 8)} ${item.baseAsset}**`,
        );
      }
    }
    lines.push(
      "",
      "### 公开信号",
      `- 查询时间：${formatTime(Date.now())}`,
      `- 公开保证金余额：${fmt(detail.marginBalance, 2)} USDT`,
      `- 当前仓位展示：${detail.positionShow ? "公开" : "关闭"}`,
    );

    for (const item of changed.slice(0, 10)) {
      const gate = gateMap.get(item.symbol);
      lines.push(
        "",
        `## ${actionIcon(tradeAction(item))}【${tradeAction(item)}】${item.symbol}`,
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

    const closedPositions = oldPositions.filter(
      (oldPosition) => !positions.some((position) => position.id === oldPosition.id),
    );
    const gateSymbols = new Set([
      ...positions.map((position) => position.symbol),
      ...closedPositions.map((position) => position.symbol),
    ]);
    const gatePairs = await Promise.all(
      [...gateSymbols].map(async (symbol) => [symbol, await getGateContract(symbol)]),
    );
    const gateMap = new Map(gatePairs);
    const lines = [
      isFirstRun
        ? `# 📌【状态基线｜无需操作】${leader.name}`
        : `# 🚨【需要你处理】${leader.name}仓位变化`,
    ];
    if (!isFirstRun) {
      lines.push("", "## 🚨 纸面模拟待办");
      for (const change of changes) {
        lines.push(
          `> ${formatChangeHighlight(change)}`,
          `> ${paperTaskForChange(change)}`,
          "> ",
        );
      }
      lines.push(
        "**先看上方待办，再看下方换算；加仓时不要把目标总仓当成本次新增仓位。**",
        "",
        ...buildPikachuOperationSummary(
          changes,
          positions,
          oldPositions,
          next.checkedAt,
        ),
      );
    }
    lines.push(
      "",
      "### 公开信号",
      `- 查询时间：${formatTime(Date.now())}`,
      `- 公开保证金余额：${fmt(detail.marginBalance, 2)} USDT`,
      `- 变化：${isFirstRun ? "首次记录当前公开仓位" : changes.join("；")}`,
    );

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
      const gate = gateMap.get(position.symbol);
      const positionChanges = changes.filter((change) =>
        change.startsWith(`${position.symbol} `),
      );
      const oldPosition = oldPositions.find((item) => item.id === position.id);
      const delta = calculatePositionDelta(
        position,
        oldPosition,
        detail.marginBalance,
        old?.marginBalance,
        positionChanges,
      );

      lines.push(
        "",
        positionChanges.length > 0
          ? `## ${actionIcon(positionChanges.join(" "))}【${changeTypeLabel(positionChanges)}】${position.symbol} ${positionDirection(position.positionSide)}`
          : `## 📍 ${position.symbol} ${positionDirection(position.positionSide)}`,
        ...(positionChanges.length > 0
          ? [
              `- 变化检测时间：${formatTime(next.checkedAt)}`,
              "- 精确成交时间：币安公开仓位接口未提供",
            ]
          : []),
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
        if (delta) {
          lines.push(
            `- ⭐ **${delta.label}模拟保证金变化量：${fmt(delta.userMargin, 4)} USDT**`,
            `- ⭐ **${delta.label}模拟名义变化量：${fmt(delta.userNotional, 4)} USDT**`,
          );
        }
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
          if (delta) {
            const deltaSize =
              Math.floor(
                delta.userNotional / perContract / gate.orderStep,
              ) * gate.orderStep;
            lines.push(
              deltaSize >= gate.minSize
                ? `- ⭐ **${delta.label}对应Gate变化量：${fmt(deltaSize, 8)}张**`
                : `- ⭐ ${delta.label}变化量低于Gate最小下单量。`,
            );
          }
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

    for (const position of closedPositions) {
      const closeChange = changes.find(
        (change) =>
          change.startsWith(`${position.symbol} `) && change.includes("平"),
      );
      if (!closeChange) continue;
      const previousSimulation = calculateSimulation(
        position,
        old?.marginBalance,
      );
      const gate = gateMap.get(position.symbol);
      lines.push(
        "",
        `# ✅【平仓】${position.symbol} ${positionDirection(position.positionSide)}`,
        "> **币安公开 positionAmount 已由非0变为0。**",
        "> **纸面模拟待办：核对并平掉对应方向的全部模拟仓位。**",
        `- 变化检测时间：${formatTime(next.checkedAt)}`,
        "- 精确平仓时间与成交价：币安公开仓位接口未提供",
        `- 平仓前公开数量：${fmt(Math.abs(Number(position.positionAmount)), 8)}`,
        `- 平仓前杠杆：${fmt(position.leverage, 2)}x`,
        `- 上次公开开仓均价：${fmt(position.entryPrice, 8)} USDT`,
        `- 上次公开标记价格：${fmt(position.markPrice, 8)} USDT`,
      );
      if (previousSimulation) {
        lines.push(
          `- 上次估算模拟保证金：${fmt(previousSimulation.userMargin, 4)} USDT`,
          `- 上次估算模拟名义仓位：${fmt(previousSimulation.userNotional, 4)} USDT`,
        );
        if (gate?.exists) {
          const perContract = gate.markPrice * gate.multiplier;
          const size =
            Math.floor(
              previousSimulation.userNotional / perContract / gate.orderStep,
            ) * gate.orderStep;
          lines.push(
            size >= gate.minSize
              ? `- ⭐ **Gate纸面平仓参考：${gate.name} ${fmt(size, 8)}张**`
              : "- 上次模拟仓位低于Gate最小下单量。",
          );
        }
      } else {
        lines.push("- 上次公开数据不足，无法精确还原纸面模拟数量。");
      }
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

async function sendPushPlus(title, content, topicOverride) {
  const configuredTopics =
    topicOverride ||
    process.env.PUSHPLUS_TOPICS ||
    process.env.PUSHPLUS_TOPIC ||
    "";
  const topics = configuredTopics
    .split(",")
    .map((topic) => topic.trim())
    .filter(Boolean);
  const targets = topics.length > 0 ? topics : [null];

  for (const topic of targets) {
    const response = await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: process.env.PUSHPLUS_TOKEN,
        ...(topic ? { topic } : {}),
        title,
        content,
        template: "markdown",
        channel: "wechat",
      }),
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 200) {
      throw new Error(
        `PushPlus发送失败（群组 ${topic || "默认一对一"}，HTTP ${response.status}，${payload?.code || "无代码"}：${payload?.msg || "无说明"}）`,
      );
    }
    console.log(`PushPlus发送成功：${topic || "默认一对一"}`);
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

function buildPushTitle(content) {
  if (content.includes("【需要你处理】")) {
    const types = ["反手", "新开仓", "加仓", "减仓", "平仓", "杠杆变化", "保证金模式变化"]
      .filter((type) => content.includes(type))
      .slice(0, 3);
    return `🚨【需处理】皮卡丘${types.length ? `：${types.join("、")}` : "仓位变化"}`;
  }
  if (content.includes("【需要人工核对】")) {
    return "⚠️【需核对】熬鹰资本有新成交";
  }
  if (content.includes("无法确认公开数据")) {
    return "⚠️【监控异常】公开数据无法确认";
  }
  if (content.includes("公开数据读取已恢复")) {
    return "✅【监控恢复】公开数据读取正常";
  }
  return "📌【状态基线】币安双带单监控";
}

function buildPreviewNotification() {
  return [
    "# 🎨【样式预览｜无需操作】",
    "> 这是一条界面测试消息，不是真实仓位变化。",
    "",
    "## 🚨 纸面模拟待办",
    "> 🔵 **【加仓】示例合约 空仓**",
    "> **待办：只增加下方标注的“变化量”，不要重复开目标总仓。**",
    "",
    "## ⭐ 本次操作变化量",
    "- **模拟保证金变化量：示例数值**",
    "- **模拟名义变化量：示例数值**",
    "- **Gate变化张数：示例张数**",
    "",
    "### 变更后的目标总仓",
    "- 目标总仓只用于核对，不应当成新增仓位重复操作。",
    "",
    "开仓、加仓、减仓、平仓、反手将分别用 🟢、🔵、🟠、✅、🔴 标出。",
    simulationNotice(),
  ].join("\n");
}

function buildHourlyStatusNotification(state) {
  const errors = Object.entries(state.errors || {});
  if (errors.length > 0) {
    return {
      ok: false,
      title: "⚠️【无法确认】双带单每小时状态",
      content: [
        "# ⚠️【无法确认是否有操作｜需要检查】",
        "> 本次每小时状态检查发现部分公开数据读取失败，因此不能判断为“无操作”。",
        "",
        `- 检查时间：${formatTime(state.checkedAt)}`,
        "- 检查频率：计划每5分钟（GitHub可能延迟）",
        ...errors.map(([name, message]) => `- ${name}：${message}`),
        "",
        "本消息只报告监控状态，不代表仓位发生变化。",
        simulationNotice(),
      ].join("\n"),
    };
  }
  return {
    ok: true,
    title: "🟢【无操作】双带单每小时状态",
    content: [
      "# 🟢【最近约一小时无操作｜无需处理】",
      "> 公开数据读取正常，本周期未检测到开仓、加仓、减仓、平仓、反手等操作变化。",
      "",
      `- 最后检查时间：${formatTime(state.checkedAt)}`,
      "- 监控对象：熬鹰资本、皮卡丘征服星辰大海",
      "- 检查频率：计划每5分钟（GitHub可能延迟）",
      `- 本周期完成检查：${state.checksSinceStatus}次`,
      "- 有操作时：立即推送币种、方向、检测/成交时间、价格、仓位与Gate纸面换算",
      "- 无操作时：约每60分钟推送一次本消息",
      "",
      "本消息表示未检测到公开操作变化，无需进行交易操作。",
      simulationNotice(),
    ].join("\n"),
  };
}

function buildPikachuOperationSummary(changes, positions, oldPositions, checkedAt) {
  const grouped = new Map();
  for (const change of changes) {
    const symbol = change.split(" ")[0];
    if (!grouped.has(symbol)) grouped.set(symbol, []);
    grouped.get(symbol).push(change);
  }
  const lines = ["## ⭐ 本次操作变化"];
  for (const [symbol, symbolChanges] of grouped) {
    const current = positions.find((item) => item.symbol === symbol);
    const previous = oldPositions.find((item) => item.symbol === symbol);
    const reference = current || previous;
    const types = [...new Set(symbolChanges.map(getChangeType))].join("＋");
    lines.push(
      "",
      `### ${actionIcon(symbolChanges.join(" "))} ${symbol}｜${types}`,
      `- **方向：${reference ? positionDirection(reference.positionSide) : "无法确认"}**`,
      `- **操作时间：币安公开仓位接口未提供精确成交时间；本系统检测于 ${formatTime(checkedAt)}**`,
    );
    if (current) {
      lines.push(
        `- **公开开仓均价：${fmt(current.entryPrice, 8)} USDT**`,
        `- 检测时标记价格：${fmt(current.markPrice, 8)} USDT`,
      );
    } else if (previous) {
      lines.push(
        "- **平仓成交价格：币安公开仓位接口未提供**",
        `- 上次公开开仓均价：${fmt(previous.entryPrice, 8)} USDT`,
        `- 上次公开标记价格：${fmt(previous.markPrice, 8)} USDT`,
      );
    }
  }
  return lines;
}

function actionIcon(value) {
  if (value.includes("反手")) return "🔴";
  if (value.includes("新开") || value.includes("开多") || value.includes("开空")) return "🟢";
  if (value.includes("加仓")) return "🔵";
  if (value.includes("减仓")) return "🟠";
  if (value.includes("平")) return "✅";
  if (value.includes("杠杆") || value.includes("逐仓") || value.includes("全仓")) return "⚙️";
  return "📍";
}

function getChangeType(change) {
  if (change.includes("反手")) return "反手";
  if (change.includes("新开")) return "新开仓";
  if (change.includes("加仓")) return "加仓";
  if (change.includes("减仓")) return "减仓";
  if (change.includes("平")) return "平仓";
  if (change.includes("杠杆")) return "杠杆变化";
  if (change.includes("逐仓") || change.includes("全仓")) return "保证金模式变化";
  return "状态变化";
}

function changeTypeLabel(changes) {
  return [...new Set(changes.map(getChangeType))].join("＋");
}

function formatChangeHighlight(change) {
  return `${actionIcon(change)} **【${getChangeType(change)}】${change}**`;
}

function paperTaskForChange(change) {
  if (change.includes("反手")) {
    return "**待办：先核对并平掉原方向，再按下方新方向目标重新建立纸面模拟。**";
  }
  if (change.includes("新开")) {
    return "**待办：核对后按下方 Gate 换算建立新的纸面模拟仓位。**";
  }
  if (change.includes("加仓")) {
    return "**待办：只增加下方标注的“变化量”，不要重复开目标总仓。**";
  }
  if (change.includes("减仓")) {
    return "**待办：只减少下方标注的“变化量”，不要把剩余目标仓全部平掉。**";
  }
  if (change.includes("平")) {
    return "**待办：核对并平掉对应方向的全部纸面模拟仓位。**";
  }
  if (change.includes("杠杆")) {
    return "**待办：核对并同步纸面模拟杠杆设置。**";
  }
  if (change.includes("逐仓") || change.includes("全仓")) {
    return "**待办：核对并同步逐仓/全仓模式。**";
  }
  return "**待办：人工核对本次公开状态变化。**";
}

function calculateSimulation(position, marginBalanceValue) {
  const notional = Math.abs(Number(position?.notionalValue));
  const leverage = Number(position?.leverage);
  const marginBalance = Number(marginBalanceValue);
  if (
    !Number.isFinite(notional) ||
    !Number.isFinite(leverage) ||
    leverage <= 0 ||
    !Number.isFinite(marginBalance) ||
    marginBalance <= 0
  ) {
    return null;
  }
  const leaderMargin = notional / leverage;
  const ratio = leaderMargin / marginBalance;
  const userMargin = USER_CAPITAL_USDT * ratio;
  return {
    userMargin,
    userNotional: userMargin * leverage,
  };
}

function calculatePositionDelta(
  position,
  oldPosition,
  currentMarginBalance,
  oldMarginBalance,
  changes,
) {
  if (changes.length === 0) return null;
  const currentSimulation = calculateSimulation(position, currentMarginBalance);
  if (!currentSimulation) return null;

  if (changes.some((change) => change.includes("反手"))) {
    return { ...currentSimulation, label: "反手后新开" };
  }
  if (changes.some((change) => change.includes("新开"))) {
    return { ...currentSimulation, label: "本次开仓" };
  }

  const oldAmount = Math.abs(Number(oldPosition?.positionAmount));
  const newAmount = Math.abs(Number(position.positionAmount));
  if (
    changes.some((change) => change.includes("加仓")) &&
    Number.isFinite(oldAmount) &&
    Number.isFinite(newAmount) &&
    newAmount > oldAmount &&
    newAmount > 0
  ) {
    const fraction = (newAmount - oldAmount) / newAmount;
    return {
      label: "本次加仓",
      userMargin: currentSimulation.userMargin * fraction,
      userNotional: currentSimulation.userNotional * fraction,
    };
  }

  if (
    changes.some((change) => change.includes("减仓")) &&
    Number.isFinite(oldAmount) &&
    Number.isFinite(newAmount) &&
    oldAmount > newAmount &&
    oldAmount > 0
  ) {
    const oldSimulation = calculateSimulation(oldPosition, oldMarginBalance);
    if (!oldSimulation) return null;
    const fraction = (oldAmount - newAmount) / oldAmount;
    return {
      label: "本次减仓",
      userMargin: oldSimulation.userMargin * fraction,
      userNotional: oldSimulation.userNotional * fraction,
    };
  }
  return null;
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
