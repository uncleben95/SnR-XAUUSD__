// Shared, deterministic risk math for the browser tool and Node tests.
export function calculateRisk({ balance, riskPercent, entry, stop, contractSize = 100, lotStep = 0.01, maxLot = 100 }) {
  const nums = [balance, riskPercent, entry, stop, contractSize, lotStep, maxLot].map(Number);
  if (nums.some(n => !Number.isFinite(n)) || balance <= 0 || riskPercent <= 0 || contractSize <= 0 || lotStep <= 0 || maxLot <= 0) {
    throw new Error("Input mesti nombor sah dan lebih besar daripada sifar.");
  }
  const distance = Math.abs(entry - stop);
  if (distance <= 0) throw new Error("Entry dan stop loss tidak boleh sama.");
  const riskUsd = balance * riskPercent / 100;
  const rawLot = riskUsd / (distance * contractSize);
  const lot = Math.floor((Math.min(rawLot, maxLot) + 1e-10) / lotStep) * lotStep;
  const roundedLot = Number(lot.toFixed(4));
  return {
    distance,
    riskUsd,
    rawLot,
    lot: roundedLot,
    estimatedLossUsd: distance * contractSize * roundedLot,
    estimatedRiskPercent: (distance * contractSize * roundedLot / balance) * 100,
    exceedsMaxLot: rawLot > maxLot
  };
}

export function calculateActualRisk({ balance, lot, entry, stop, contractSize = 100 }) {
  const values = [balance, lot, entry, stop, contractSize].map(Number);
  if (values.some(n => !Number.isFinite(n)) || balance <= 0 || lot < 0 || contractSize <= 0) {
    throw new Error("Input mesti nombor sah.");
  }
  const loss = Math.abs(entry - stop) * lot * contractSize;
  return { distance: Math.abs(entry - stop), lossUsd: loss, riskPercent: loss / balance * 100 };
}
