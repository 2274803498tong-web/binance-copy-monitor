import test from "node:test";
import assert from "node:assert/strict";
import {
  formatOrderSignal,
  isOrderSignal,
  parseOrderSignal,
} from "./bitget-insights-monitor.mjs";

const article = {
  id: "4822563",
  publishTimeStamp: "1788352838611",
  content: `【$FF 信号】1H突破上轨 MACD多头扩张

🎯方向：做多

⚡入场/挂单：0.1066690 - 0.1069900

🛑止损：0.1059201

🚀目标1：0.1085948

🚀目标2：0.1093973`,
};

test("识别并解析挂单信号", () => {
  assert.equal(isOrderSignal(article.content), true);
  assert.deepEqual(parseOrderSignal(article), {
    id: "4822563",
    title: "【$FF 信号】1H突破上轨 MACD多头扩张",
    direction: "做多",
    entry: "0.1066690 - 0.1069900",
    stopLoss: "0.1059201",
    target1: "0.1085948",
    target2: "0.1093973",
    publishedAt: 1788352838611,
    url: "https://www.bitget.com/zh-CN/insights/posts/4822563",
  });
});

test("普通动态不会被当成挂单", () => {
  assert.equal(isOrderSignal("BTC 今日突破关键阻力，继续观察。"), false);
  assert.equal(isOrderSignal("方向：做多\n入场/挂单：100"), false);
});

test("通知包含关键风控字段和风险说明", () => {
  const text = formatOrderSignal(parseOrderSignal(article));
  assert.match(text, /方向：做多/u);
  assert.match(text, /止损：0\.1059201/u);
  assert.match(text, /不代表真实成交/u);
});

