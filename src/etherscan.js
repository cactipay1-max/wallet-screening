// src/etherscan.js
const BASE_URL = process.env.ETHERSCAN_BASE_URL || "https://api.etherscan.io/v2/api";
const API_KEY = process.env.ETHERSCAN_API_KEY;

async function etherscan(params) {
  if (!API_KEY) throw new Error("ETHERSCAN_API_KEY is not set in .env");

  const url = new URL(BASE_URL);
  // V2 API requires chainid; default 1 = Ethereum mainnet.
  const chainid = params.chainid || 1;
  for (const [k, v] of Object.entries({ chainid, ...params, apikey: API_KEY })) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Etherscan HTTP ${res.status}`);
  const data = await res.json();
  return data;
}

async function getNormalTxs(address, limit = 100) {
  const data = await etherscan({
    module: "account",
    action: "txlist",
    address,
    startblock: 0,
    endblock: 99999999,
    sort: "desc",
    page: 1,
    offset: limit,
  });

  // "No transactions found" = это нормально, просто пустой список
  if (data.status === "0" && (data.message || "").toLowerCase().includes("no transactions")) return [];
  if (data.status === "0") throw new Error(`Etherscan txlist error: ${data.message || "unknown"}`);
  return Array.isArray(data.result) ? data.result : [];
}

async function getTokenTxs(address, limit = 100) {
  const data = await etherscan({
    module: "account",
    action: "tokentx",
    address,
    startblock: 0,
    endblock: 99999999,
    sort: "desc",
    page: 1,
    offset: limit,
  });

  if (data.status === "0" && (data.message || "").toLowerCase().includes("no transactions")) return [];
  if (data.status === "0") throw new Error(`Etherscan tokentx error: ${data.message || "unknown"}`);
  return Array.isArray(data.result) ? data.result : [];
}

module.exports = { getNormalTxs, getTokenTxs };