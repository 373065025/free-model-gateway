'use strict';

/**
 * 生成 29 天演示数据，用于预览 Dashboard 的图表与排行榜观感。
 *
 * ⚠️ 这是「假数据」，写入后 Dashboard 顶部会显示「演示数据」角标。
 *    想恢复真实统计：node scripts/reset-data.js
 */

const { Stats } = require('../src/stats');
const { loadConfig } = require('../src/config');
const { dayKey, lastNDays } = require('../src/util');

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function main() {
  const cfg = loadConfig();
  const stats = new Stats({
    file: cfg.paths.usageFile,
    tzOffsetMinutes: cfg.settings.tzOffsetMinutes,
  });

  const days = lastNDays(29, cfg.settings.tzOffsetMinutes);
  const daily = {};
  const byModel = {};
  const byProvider = {};
  const byHour = {};

  const modelMix = [
    { name: 'auto', w: 0.42, ib: 1400, ob: 900, provider: 'groq' },
    { name: 'deepseek-r1', w: 0.21, ib: 1800, ob: 1500, provider: 'openrouter' },
    { name: 'gemini-flash', w: 0.16, ib: 2600, ob: 1100, provider: 'google' },
    { name: 'glm-flash', w: 0.12, ib: 900, ob: 700, provider: 'zhipu' },
    { name: 'llama-3.3-70b', w: 0.06, ib: 1100, ob: 800, provider: 'cerebras' },
    { name: 'qwen3-8b', w: 0.03, ib: 700, ob: 500, provider: 'siliconflow' },
  ];

  const totals = {
    calls: 0, success: 0, failed: 0, streamCalls: 0, retries: 0,
    inputTokens: 0, outputTokens: 0, latencySum: 0, latencyCount: 0,
  };

  days.forEach((day, di) => {
    const growth = 0.55 + di / (days.length - 1) * 0.75;
    const calls = Math.round(rand(52, 130) * growth);
    let input = 0;
    let output = 0;
    for (const m of modelMix) {
      const c = Math.max(0, Math.round(calls * m.w * rand(0.75, 1.25)));
      if (!c) continue;
      const mi = Math.round(c * m.ib * rand(0.7, 1.35));
      const mo = Math.round(c * m.ob * rand(0.7, 1.35));
      input += mi;
      output += mo;
      if (!byModel[m.name]) byModel[m.name] = { calls: 0, input: 0, output: 0, failed: 0 };
      byModel[m.name].calls += c;
      byModel[m.name].input += mi;
      byModel[m.name].output += mo;
      byModel[m.name].failed += Math.round(c * 0.012);
      if (!byProvider[m.provider]) {
        byProvider[m.provider] = { calls: 0, ok: 0, failed: 0, input: 0, output: 0, latencySum: 0, latencyCount: 0 };
      }
      const bp = byProvider[m.provider];
      bp.calls += c;
      bp.ok += c - Math.round(c * 0.012);
      bp.failed += Math.round(c * 0.012);
      bp.input += mi;
      bp.output += mo;
      bp.latencySum += Math.round(c * rand(700, 2600));
      bp.latencyCount += c;
    }
    daily[day] = { calls, input, output };
    totals.calls += calls;
    totals.success += calls - Math.round(calls * 0.015);
    totals.failed += Math.round(calls * 0.015);
    totals.streamCalls += Math.round(calls * 0.7);
    totals.retries += Math.round(calls * 0.06);
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.latencySum += calls * rand(800, 2400);
    totals.latencyCount += calls;

    const today = dayKey(new Date(), cfg.settings.tzOffsetMinutes);
    if (day === today) {
      for (let h = 9; h <= 22; h += 1) {
        const hk = `${day}T${String(h).padStart(2, '0')}:00`;
        const c = Math.round(calls / 14 * rand(0.4, 1.8));
        byHour[hk] = { calls: c, input: Math.round(input / 14 * rand(0.4, 1.8)), output: Math.round(output / 14 * rand(0.4, 1.8)) };
      }
    }
  });

  stats.seed({
    meta: {
      startedAt: new Date(Date.now() - 29 * 86400000).toISOString(),
      firstDay: days[0],
      demo: true,
    },
    totals,
    daily,
    byModel,
    byProvider,
    byHour,
  });

  const grand = totals.inputTokens + totals.outputTokens;
  console.log('\n已写入 29 天演示数据：');
  console.log(`  数据文件   : ${cfg.paths.usageFile}`);
  console.log(`  累计调用   : ${totals.calls.toLocaleString('en-US')} 次`);
  console.log(`  输入 tokens: ${totals.inputTokens.toLocaleString('en-US')}`);
  console.log(`  输出 tokens: ${totals.outputTokens.toLocaleString('en-US')}`);
  console.log(`  合计 tokens: ${grand.toLocaleString('en-US')}`);
  console.log('\n打开 Dashboard 即可看到完整的趋势曲线与排行榜。');
  console.log('想恢复真实统计：node scripts/reset-data.js\n');
}

main();
