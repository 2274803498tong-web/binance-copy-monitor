export function tradeFillId(fill) {
  return [fill.time, fill.symbol, fill.side, fill.positionSide].join("|");
}

export function storedTradeIds(state) {
  if (Array.isArray(state?.tradeIds)) {
    return new Set(state.tradeIds);
  }

  // Version 4 stored quantity and average price at the end of each key. Strip
  // those volatile fields so an existing installation can migrate quietly.
  return new Set(
    (state?.tradeKeys || []).map((key) =>
      String(key).split("|").slice(0, 4).join("|"),
    ),
  );
}

export function completeTradeFills(fills, exhausted) {
  if (exhausted || fills.length === 0) return fills;

  // A full Binance page can stop halfway through one market order. Every fill
  // at the oldest timestamp is therefore treated as an incomplete boundary
  // until the following page has been read.
  const oldestTime = Math.min(...fills.map((fill) => Number(fill.time)));
  return fills.filter((fill) => Number(fill.time) > oldestTime);
}

export function tradeHistoryCursor(data) {
  const cursor = String(data?.indexValue || "");
  if (!cursor) {
    throw new Error("币安交易历史分页游标缺失，无法确认最新完整成交");
  }
  // indexValue is the oldest timestamp on the page, not a unique page token.
  // It legitimately repeats while one timestamp contains more than 200 fills;
  // pageNumber is what advances through those fills.
  return cursor;
}

export function aggregateFills(fills) {
  const groups = new Map();
  for (const fill of fills || []) {
    const id = tradeFillId(fill);
    const current = groups.get(id) || {
      id,
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
    groups.set(id, current);
  }
  return [...groups.values()]
    .map((item) => ({
      ...item,
      avgPrice: item.qty > 0 ? item.notional / item.qty : 0,
    }))
    .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
}
