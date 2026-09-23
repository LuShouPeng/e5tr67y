import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  elapsedSeconds,
  previousWindowStart,
  remainingSeconds,
  windowEndFor,
  windowStartFor,
} from '../src/domain/window.ts';
import { WINDOW_SECONDS } from '../src/domain/types.ts';

/** 2026-09-23T07:05:00Z */
const AT_07_05 = Date.UTC(2026, 8, 23, 7, 5, 0, 0);

describe('windowStartFor：窗口向下对齐到 300 秒边界', () => {
  it('整点边界对齐到自身', () => {
    assert.equal(windowStartFor(AT_07_05), AT_07_05 / 1000);
    assert.equal(windowStartFor(Date.UTC(2026, 8, 23, 7, 10, 0)), Date.UTC(2026, 8, 23, 7, 10, 0) / 1000);
  });

  it('窗口内任意毫秒都回落到窗口起点', () => {
    const expected = AT_07_05 / 1000;
    assert.equal(windowStartFor(AT_07_05 + 1), expected);
    assert.equal(windowStartFor(AT_07_05 + 60_000), expected);
    assert.equal(windowStartFor(AT_07_05 + 299_999), expected);
  });

  it('毫秒级边界：300000ms 归下一窗口，299999ms 仍归当前', () => {
    const base = AT_07_05;
    assert.equal(windowStartFor(base + 299_999), base / 1000);
    assert.equal(windowStartFor(base + 300_000), base / 1000 + WINDOW_SECONDS);
  });

  it('支持自定义窗口长度（便于测试与复用）', () => {
    const t = Date.UTC(2026, 8, 23, 7, 7, 30);
    assert.equal(windowStartFor(t, 60), Date.UTC(2026, 8, 23, 7, 7, 0) / 1000);
    assert.equal(windowStartFor(t, 3600), Date.UTC(2026, 8, 23, 7, 0, 0) / 1000);
  });
});

describe('remainingSeconds：剩余秒数区间 (0, 300]', () => {
  it('恰在边界时返回整个窗口（刚开盘）', () => {
    assert.equal(remainingSeconds(AT_07_05), WINDOW_SECONDS);
  });

  it('窗口内递减，最后一秒为 1', () => {
    assert.equal(remainingSeconds(AT_07_05 + 1_000), WINDOW_SECONDS - 1);
    assert.equal(remainingSeconds(AT_07_05 + 299_000), 1);
    assert.equal(remainingSeconds(AT_07_05 + 299_999), 1);
  });

  it('永不返回 0：跨过边界即进入下一窗口的满额', () => {
    assert.equal(remainingSeconds(AT_07_05 + 300_000), WINDOW_SECONDS);
  });

  it('elapsed + remaining 恒等于窗口长度', () => {
    for (const offset of [0, 1, 999, 60_000, 299_999]) {
      const t = AT_07_05 + offset;
      assert.equal(elapsedSeconds(t) + remainingSeconds(t), WINDOW_SECONDS);
    }
  });
});

describe('窗口端点与相邻窗口', () => {
  it('windowEndFor = 起点 + 300', () => {
    assert.equal(windowEndFor(AT_07_05 / 1000), AT_07_05 / 1000 + WINDOW_SECONDS);
  });

  it('previousWindowStart 恰为上一窗口（封盘判定的阈值）', () => {
    assert.equal(previousWindowStart(AT_07_05), AT_07_05 / 1000 - WINDOW_SECONDS);
    assert.equal(previousWindowStart(AT_07_05 + 120_000), AT_07_05 / 1000 - WINDOW_SECONDS);
    assert.equal(previousWindowStart(AT_07_05 + 300_000), AT_07_05 / 1000);
  });
});
