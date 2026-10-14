import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScalpModels, validateModelRisk } from '../api/scalp-models.js';

function makeCandles(count, start = 4000, step = 0.4) {
  return Array.from({ length: count }, (_, i) => {
    const open = start + i * step;
    const close = open + (i % 3 === 0 ? -0.15 : 0.25);
    return {
      time: new Date(Date.UTC(2026, 9, 14, 0, i * 5)).toISOString(),
      open,
      high: Math.max(open, close) + 0.35,
      low: Math.min(open, close) - 0.35,
      close,
      volume: 0
    };
  });
}

test('returns all three independent models without altering production signal fields', () => {
  const m5 = makeCandles(80);
  const m15 = makeCandles(50, 3990, 1.2);
  const result = buildScalpModels({ m5, m15, price: m5.at(-1).close, m15Structure: { bullish: true, bearish: false } });
  assert.equal(result.mode, 'EXPERIMENTAL_MANUAL_REVIEW');
  assert.equal(result.backtested, false);
  assert.deepEqual(Object.keys(result.models), ['A', 'B', 'C']);
  for (const model of Object.values(result.models)) {
    assert.ok(['WAIT', 'WATCH_ZONE', 'EARLY_SETUP', 'FVG_FOUND', 'WATCH_RETEST', 'INVALID_ZONE', 'WATCH_PULLBACK', 'TREND_CONTEXT', 'INVALID_RISK_PLAN'].includes(model.state));
    assert.equal(typeof model.setupFound, 'boolean');
  }
});

test('handles insufficient candle data safely', () => {
  const result = buildScalpModels({ m5: [], m15: [], price: 4200 });
  assert.equal(result.models.A.state, 'WAIT');
  assert.equal(result.models.B.state, 'WAIT');
  assert.equal(result.models.C.state, 'WAIT');
});


test('rejects a SELL model when its target is on the wrong side of the entry zone', () => {
  const model = validateModelRisk({
    id: 'C', direction: 'SELL', setupFound: true,
    entryZone: { low: 4143.76, high: 4158.70 },
    invalidation: 4159.83, target: 4159.98, state: 'EARLY_SETUP'
  });
  assert.equal(model.setupFound, false);
  assert.equal(model.state, 'INVALID_RISK_PLAN');
  assert.equal(model.validation.valid, false);
});

test('accepts correctly oriented risk geometry only when RR meets the minimum', () => {
  const model = validateModelRisk({
    id: 'A', direction: 'BUY', setupFound: true,
    entryZone: { low: 100, high: 101 }, invalidation: 98,
    target: 105, state: 'EARLY_SETUP'
  });
  assert.equal(model.setupFound, true);
  assert.equal(model.validation.valid, true);
  assert.ok(model.rr >= 1.2);
});

test('rejects a correctly oriented plan when reward/risk is too small', () => {
  const model = validateModelRisk({
    id: 'B', direction: 'BUY', setupFound: true,
    entryZone: { low: 100, high: 101 }, invalidation: 98,
    target: 102, state: 'EARLY_SETUP'
  });
  assert.equal(model.setupFound, false);
  assert.equal(model.state, 'INVALID_RISK_PLAN');
  assert.ok(model.rr < 1.2);
});
