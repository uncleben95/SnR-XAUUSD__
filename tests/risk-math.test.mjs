import test from "node:test";
import assert from "node:assert/strict";
import { calculateRisk, calculateActualRisk } from "../risk-math.js";

test("$50k account, 0.5% risk, $15 stop -> approximately 0.16 lot", () => {
  const r = calculateRisk({ balance: 50000, riskPercent: 0.5, entry: 4300, stop: 4285, contractSize: 100, lotStep: 0.01 });
  assert.equal(r.lot, 0.16);
  assert.equal(r.estimatedLossUsd, 240);
  assert.equal(r.estimatedRiskPercent, 0.48);
});

test("0.5 lot and $15 stop -> $750 estimated loss on standard contract", () => {
  const r = calculateActualRisk({ balance: 50000, lot: 0.5, entry: 4300, stop: 4285, contractSize: 100 });
  assert.equal(r.lossUsd, 750);
  assert.equal(r.riskPercent, 1.5);
});

test("rejects identical entry and stop", () => {
  assert.throws(() => calculateRisk({ balance: 50000, riskPercent: 0.5, entry: 4300, stop: 4300 }), /tidak boleh sama/);
});
