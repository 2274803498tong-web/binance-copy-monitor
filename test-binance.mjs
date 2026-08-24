const BINANCE_BASE =
  "https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade";

const leaders = [
  { name: "熬鹰资本", id: "5075281354358777856" },
  { name: "皮卡丘征服星辰大海", id: "4982308422483092480" },
];

const headers = {
  accept: "application/json",
  "content-type": "application/json",
  clienttype: "web",
  lang: "zh-CN",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
};

async function probe(label, url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  console.log(`\n[${label}] HTTP ${response.status}`);
  console.log(`content-type: ${response.headers.get("content-type") || "无"}`);
  if (!payload) {
    console.log(`非JSON响应，前120字符：${text.slice(0, 120)}`);
    return false;
  }

  console.log(
    `success=${String(payload.success)} code=${String(payload.code ?? "无")} message=${String(payload.message ?? "无")}`,
  );
  if (Array.isArray(payload.data)) {
    console.log(`公开记录数量：${payload.data.length}`);
  } else if (payload.data && typeof payload.data === "object") {
    console.log(`已返回公开对象，字段数：${Object.keys(payload.data).length}`);
  }
  return response.ok && payload.success === true;
}

const results = [];
for (const leader of leaders) {
  results.push(
    await probe(
      `${leader.name}｜组合详情`,
      `${BINANCE_BASE}/lead-portfolio/detail?portfolioId=${leader.id}`,
    ),
  );
  results.push(
    await probe(
      `${leader.name}｜公开仓位`,
      `${BINANCE_BASE}/lead-data/positions?portfolioId=${leader.id}`,
    ),
  );
}

results.push(
  await probe(
    "熬鹰资本｜最新交易记录",
    `${BINANCE_BASE}/lead-portfolio/trade-history`,
    {
      method: "POST",
      body: JSON.stringify({
        portfolioId: leaders[0].id,
        pageNumber: 1,
        pageSize: 10,
      }),
    },
  ),
);

const passed = results.filter(Boolean).length;
console.log(`\n测试完成：${passed}/${results.length} 个公开接口可用。`);
if (passed !== results.length) process.exitCode = 1;
