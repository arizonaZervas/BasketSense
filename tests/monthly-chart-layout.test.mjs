import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { monthlyChartScrollTarget } from "../app/monthly-chart-layout.ts";

test("monthly chart starts with latest months on narrow surfaces and fits wide surfaces", () => {
  assert.equal(monthlyChartScrollTarget(300, 450), 150);
  assert.equal(monthlyChartScrollTarget(720, 720), 0);
  assert.equal(monthlyChartScrollTarget(300, 200), 0);
  assert.equal(monthlyChartScrollTarget(0, 0), 0);
});

test("selected month is centered where possible and clamped at either end", () => {
  assert.equal(monthlyChartScrollTarget(300, 600, {left: 0, width: 44}), 0);
  assert.equal(monthlyChartScrollTarget(300, 600, {left: 300, width: 44}), 172);
  assert.equal(monthlyChartScrollTarget(300, 600, {left: 556, width: 44}), 300);
});

test("chart retains month selection and reduced-motion-aware, keyboard-accessible navigation", () => {
  const source=readFileSync(new URL("../app/basket-sense-dashboard.tsx", import.meta.url), "utf8");
  const chart=source.slice(source.indexOf("function MonthlyBarChart"),source.indexOf("function polarPoint"));
  assert.match(chart,/onClick=\{\(\) => onSelectMonth\(month.key\)\}/);
  assert.match(chart,/Show earlier months/);
  assert.match(chart,/Show later months/);
  assert.match(chart,/event.detail === 0 \|\| window.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(chart,/observer.disconnect\(\)/);
  assert.match(chart,/month.householdFundedCents === 0 \? 0 : 2/);
  assert.doesNotMatch(chart,/scrollIntoView/);
});
