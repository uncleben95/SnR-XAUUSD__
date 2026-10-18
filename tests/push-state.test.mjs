import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotifyEntryEvent } from '../api/push-state.js';

test('allows a new BUY event after a previous BUY event', () => {
  assert.equal(shouldNotifyEntryEvent('BUY|candle-1', 'BUY|candle-2'), true);
});

test('allows a new SELL event after a previous SELL event', () => {
  assert.equal(shouldNotifyEntryEvent('SELL|candle-1', 'SELL|candle-2'), true);
});

test('does not notify twice for the same event key', () => {
  assert.equal(shouldNotifyEntryEvent('BUY|candle-1', 'BUY|candle-1'), false);
});

test('does not notify when the current event key is missing', () => {
  assert.equal(shouldNotifyEntryEvent('BUY|candle-1', ''), false);
  assert.equal(shouldNotifyEntryEvent('BUY|candle-1', null), false);
});
