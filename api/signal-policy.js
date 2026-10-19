/**
 * Pure policy helpers for production signal safety.
 * These rules validate signal context and plan geometry; they do not claim
 * that a strategy is profitable or guarantee a fill at the displayed price.
 */
export function isH1DirectionAllowed(signal, h1Direction, reversalAtOppositeZone = false) {
  const direction = String(signal || "").toUpperCase();
  const h1 = String(h1Direction || "WAIT").toUpperCase();
  if (direction === "BUY") return h1 !== "SELL" || reversalAtOppositeZone === true;
  if (direction === "SELL") return h1 !== "BUY" || reversalAtOppositeZone === true;
  return false;
}

export function isTradePlanValid({ signal, entry, stopLoss, tp1, tp2, tp3, minR = 1.5 } = {}) {
  const direction = String(signal || "").toUpperCase();
  const rawValues = [entry, stopLoss, tp1, tp2, tp3];
  if (!["BUY", "SELL"].includes(direction)) return false;
  if (rawValues.some(value => value === null || value === undefined || value === "")) return false;
  if (!Number.isFinite(Number(minR)) || Number(minR) <= 0) return false;

  const values = rawValues.map(Number);
  if (!values.every(Number.isFinite)) return false;
  const [e, sl, first, second, third] = values;
  const risk = Math.abs(e - sl);
  if (!(risk > 0)) return false;

  if (direction === "BUY") {
    if (!(sl < e && first > e && second > first && third > second)) return false;
  } else if (!(sl > e && first < e && second < first && third < second)) {
    return false;
  }

  const rewardRisk = Math.abs(first - e) / risk;
  return rewardRisk + 1e-9 >= Number(minR);
}

export function isMarketDataStale(reasons = []) {
  const staleReasons = new Set([
    "FLAT_OR_SYNTHETIC_CANDLE_FEED",
    "LATEST_M5_CANDLE_STALE",
    "LATEST_M15_CANDLE_STALE",
    "LATEST_H1_CANDLE_STALE",
    "LIVE_PRICE_STALE_OR_UNAVAILABLE"
  ]);
  return Array.isArray(reasons) && reasons.some(reason => staleReasons.has(reason));
}
