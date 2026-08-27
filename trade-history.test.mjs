import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateFills,
  completeTradeFills,
  storedTradeIds,
} from "./trade-history.mjs";

function fill(time, qty, price = 100) {
  return {
    time,
    symbol: "ETHUSDT",
    side: "BUY",
    positionSide: "LONG",
    baseAsset: "ETH",
    qty,
    quantity: qty * price,
    realizedProfit: 0,
  };
}

test("drops a truncated page boundary and keeps completed recent trades", () => {
  const page = [fill(3000, 2), fill(3000, 3), fill(2000, 4)];
  const complete = completeTradeFills(page, false);

  assert.deepEqual(complete, page.slice(0, 2));
  assert.deepEqual(aggregateFills(complete), [
    expectTrade("3000|ETHUSDT|BUY|LONG", 5),
  ]);
});

test("combines one trade split across consecutive Binance pages", () => {
  const page1 = [fill(3000, 1), fill(2000, 2)];
  const page2 = [fill(2000, 3), fill(1000, 4)];
  const complete = completeTradeFills([...page1, ...page2], false);
  const groups = aggregateFills(complete);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], expectTrade("3000|ETHUSDT|BUY|LONG", 1));
  assert.deepEqual(groups[1], expectTrade("2000|ETHUSDT|BUY|LONG", 5));
});

test("migrates version 4 quantity-based keys to stable trade ids", () => {
  const ids = storedTradeIds({
    tradeKeys: ["3000|ETHUSDT|BUY|LONG|5|100"],
  });

  assert.deepEqual([...ids], ["3000|ETHUSDT|BUY|LONG"]);
});

function expectTrade(id, qty) {
  return {
    id,
    time: Number(id.split("|")[0]),
    symbol: "ETHUSDT",
    side: "BUY",
    positionSide: "LONG",
    baseAsset: "ETH",
    qty,
    notional: qty * 100,
    realizedProfit: 0,
    avgPrice: 100,
  };
}
