/**
 * Token USD estimation for the proposal row.
 *
 * The `daily-spend-limit` policy reads `proposals.estimated_usd`, so this
 * value has to exist at propose-time — before voting, before execution. We
 * query Zerion's public fungibles endpoint for the price of the *from* token
 * (the token the squad is spending) and multiply by the quantity.
 *
 * Failure returns null; the caller then decides whether to accept a pending
 * proposal with an unknown USD value (policy will treat it as 0 — so a null
 * cap is the only way to allow unknown-USD trades).
 */

const API = "https://api.zerion.io/v1";

function authHeader(apiKey) {
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
}

export async function fetchTokenUsd(symbol, chain, apiKey) {
  if (!apiKey) return null;
  const url = new URL(`${API}/fungibles/`);
  url.searchParams.set("filter[search_query]", symbol);
  if (chain) url.searchParams.set("filter[implementation_chain_id]", chain);
  url.searchParams.set("page[size]", "5");
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "Authorization": authHeader(apiKey),
        "Accept": "application/json",
      },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const json = await res.json();
  const candidates = json.data || [];
  const up = symbol.toUpperCase();
  // Prefer an exact symbol match; otherwise take the first.
  const match =
    candidates.find((c) => c.attributes?.symbol?.toUpperCase() === up) ||
    candidates[0];
  const price = match?.attributes?.market_data?.price;
  return typeof price === "number" ? price : null;
}

export async function estimateUsd({ symbol, amount, chain, apiKey }) {
  const qty = Number(amount);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const price = await fetchTokenUsd(symbol, chain, apiKey);
  if (price === null) return null;
  return Math.round(qty * price * 100) / 100;
}
