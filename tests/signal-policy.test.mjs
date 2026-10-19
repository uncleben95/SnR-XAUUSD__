import test from 'node:test';
import assert from 'node:assert/strict';
import { isH1DirectionAllowed, isMarketDataStale, isTradePlanValid } from '../api/signal-policy.js';

test('neutral H1 does not block an aligned M15+M5 direction', () => {
  assert.equal(isH1DirectionAllowed('BUY', 'WAIT'), true);
  assert.equal(isH1DirectionAllowed('SELL', 'WAIT'), true);
});

test('H1 agreement allows continuation without requiring an S/R touch', () => {
  assert.equal(isH1DirectionAllowed('BUY', 'BUY', false), true);
  assert.equal(isH1DirectionAllowed('SELL', 'SELL', false), true);
});

test('opposing H1 bias blocks an entry unless reversal context is confirmed', () => {
  assert.equal(isH1DirectionAllowed('BUY', 'SELL', false), false);
  assert.equal(isH1DirectionAllowed('SELL', 'BUY', false), false);
  assert.equal(isH1DirectionAllowed('BUY', 'SELL', true), true);
  assert.equal(isH1DirectionAllowed('SELL', 'BUY', true), true);
});

test('valid BUY plan requires correctly oriented, increasing targets and minimum R:R', () => {
  assert.equal(isTradePlanValid({ signal: 'BUY', entry: 100, stopLoss: 98, tp1: 103.2, tp2: 106, tp3: 110, minR: 1.5 }), true);
  assert.equal(isTradePlanValid({ signal: 'BUY', entry: 100, stopLoss: 98, tp1: 102, tp2: 106, tp3: 110, minR: 1.5 }), false);
  assert.equal(isTradePlanValid({ signal: 'BUY', entry: 100, stopLoss: 101, tp1: 104, tp2: 106, tp3: 110, minR: 1.5 }), false);
});

test('valid SELL plan requires correctly oriented, decreasing targets', () => {
  assert.equal(isTradePlanValid({ signal: 'SELL', entry: 100, stopLoss: 102, tp1: 96.8, tp2: 94, tp3: 90, minR: 1.5 }), true);
  assert.equal(isTradePlanValid({ signal: 'SELL', entry: 100, stopLoss: 102, tp1: 98, tp2: 94, tp3: 90, minR: 1.5 }), false);
});

test('missing, null, zero-risk, and malformed plans are rejected', () => {
  assert.equal(isTradePlanValid({ signal: 'BUY', entry: null, stopLoss: -2, tp1: 4, tp2: 6, tp3: 8 }), false);
  assert.equal(isTradePlanValid({ signal: 'BUY', entry: 100, stopLoss: 100, tp1: 104, tp2: 106, tp3: 110 }), false);
  assert.equal(isTradePlanValid({ signal: 'WAIT', entry: 100, stopLoss: 98, tp1: 104, tp2: 106, tp3: 110 }), false);
});


test('cache transport alone is not stale, but explicit data-quality reasons are', () => {
  assert.equal(isMarketDataStale([]), false);
  assert.equal(isMarketDataStale(['WEEKEND_MARKET_CLOSED']), false);
  assert.equal(isMarketDataStale(['LIVE_PRICE_STALE_OR_UNAVAILABLE']), true);
  assert.equal(isMarketDataStale(['LATEST_M5_CANDLE_STALE']), true);
  assert.equal(isMarketDataStale(['FLAT_OR_SYNTHETIC_CANDLE_FEED']), true);
});
