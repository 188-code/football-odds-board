#!/usr/bin/env node
/**
 * 篮球精选/优选/强推 分档引擎（2026-11-24）
 * 根因修复：
 *   1) 方向口径：参考软件「跟强队」(隐含概率高方)；旧主引擎「站对面」被25场实证否掉(跟强队72% vs 站对面28%)。
 *   2) 数据源：改用 D盘快照流水真实临盘帧，不再用方向账本首登冻结价(2.48/1.29、1.7/1.7)。
 *   3) 赛前护栏：observed_at < kickTs 硬过滤；只取赛前最后一帧。
 * 分档(对齐参考软件语义，基于信号强度+共振源数)：
 *   强推  强队隐含>=70% 或 (>=65% 且 >=2源共振)
 *   精选  强队隐含>=60% 且 >=2源共振；或单源>=65%
 *   优选  强队隐含>=55% 且 >=2源；或单源 55-65%
 *   观察  其余
 * 风控：本引擎产出为「观察分档」，n=25<40、ROI z≈0，未达项目进引擎铁律，
 *       不写方向账本、不进 ROI 统计、不构成投注建议；仅还原参考软件的信号分级能力。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname + path.sep;
const DDIR = 'D:/北单竞彩数据/篮球/快照流水' + path.sep;
const HEAT = ROOT + 'basket_overheat.json';
const LEDGER = ROOT + 'basket_dir_ledger.json';
const RESULT = ROOT + 'basket_result.json';
const OUT = ROOT + 'basket_tiers.json';
const VERSION = 'basket_tier_follow_strong_20261124';

function readJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } }
const num = v => { const n = +v; return Number.isFinite(n) ? n : null; };
const prob = (h, a) => (num(h) > 0 && num(a) > 0) ? (1 / h) / (1 / h + 1 / a) : null;

// 收集 D 盘真实临盘帧：frames[id] = { jc_mnl, eu_mnl, bd_sfgg, jc_hdc, eu_hdc, jc_hilo, eu_hilo } 取赛前最后一帧
function collectFrames(kickOf) {
  const files = fs.existsSync(DDIR)
    ? fs.readdirSync(DDIR).filter(f => /^20\d{6}\.jsonl$/.test(f)).sort().slice(-14)
    : [];
  const frames = {};
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(DDIR + f, 'utf8'); } catch (e) { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      if (o.kind !== 'poll') continue;
      const id = String(o.id || '');
      if (!id) continue;
      const src = o.source, mkt = o.market;
      const key = src + '_' + mkt;
      if (!['jc_mnl', 'eu_mnl', 'bd_sfgg', 'jc_hdc', 'eu_hdc', 'jc_hilo', 'eu_hilo'].includes(key)) continue;
      const kick = kickOf[id];
      const obs = Date.parse(o.observed_at || '') / 1000;
      // 赛前硬护栏：有 kickTs 时必须赛前；无 kickTs 保守只收最近4天文件
      if (Number.isFinite(kick) && !(obs < kick)) continue;
      if (!frames[id]) frames[id] = {};
      const prev = frames[id][key];
      if (!prev || (o.observed_at || '') > (prev.observed_at || '')) {
        frames[id][key] = { quote: o.quote || {}, line: o.line, observed_at: o.observed_at, source: src, market: mkt };
      }
    }
  }
  return frames;
}

function pickStrong(fr) {
  // 强队=隐含概率高方。源优先级：365独赢 > 竞彩独赢 > 北单sfgg > 365让分隐含
  const sources = [];
  if (fr.eu_mnl) { const p = prob(fr.eu_mnl.quote.home, fr.eu_mnl.quote.away); if (p !== null) sources.push({ src: '365独赢', p, q: fr.eu_mnl.quote, w: 3 }); }
  if (fr.jc_mnl) { const p = prob(fr.jc_mnl.quote.home, fr.jc_mnl.quote.away); if (p !== null) sources.push({ src: '竞彩独赢', p, q: fr.jc_mnl.quote, w: 2 }); }
  if (fr.bd_sfgg) { const p = prob(fr.bd_sfgg.quote.home, fr.bd_sfgg.quote.away); if (p !== null) sources.push({ src: '北单sfgg', p, q: fr.bd_sfgg.quote, w: 1 }); }
  if (!sources.length) return null;
  // 主判定源：按权重取第一个（365最高）
  const main = sources.slice().sort((a, b) => b.w - a.w)[0];
  const hot = main.p >= 0.5 ? 'home' : 'away';
  const strongP = Math.max(main.p, 1 - main.p);
  // 共振：其他源隐含高方是否与主判定一致
  let agree = 0, disagree = 0;
  for (const s of sources) {
    const h = s.p >= 0.5 ? 'home' : 'away';
    if (h === hot) agree++; else disagree++;
  }
  const strongOdds = hot === 'home' ? main.q.home : main.q.away;
  // 综合强队概率：主源权重最高，其余源按权重加权（只为分档强度，不改方向）
  let ps = 0, ws = 0;
  for (const s of sources) {
    const sp = s.p >= 0.5 ? s.p : 1 - s.p; // 该源强队侧概率
    ps += sp * s.w; ws += s.w;
  }
  const blendP = ws ? ps / ws : strongP;
  return { hot, strongP: +(strongP * 100).toFixed(1), blendP: +(blendP * 100).toFixed(1),
           agree, disagree, nSrc: sources.length, mainSrc: main.src, strongOdds,
           sources: sources.map(s => ({ src: s.src, homeP: +(s.p * 100).toFixed(1), hot: s.p >= 0.5 ? 'home' : 'away' })) };
}

function tierOf(info) {
  if (!info) return '观察';
  const p = info.blendP, a = info.agree, n = info.nSrc;
  if (p >= 70 || (p >= 65 && a >= 2)) return '强推';
  if ((p >= 60 && a >= 2) || (p >= 65 && n === 1)) return '精选';
  if ((p >= 55 && a >= 2) || (n === 1 && p >= 55)) return '优选';
  return '观察';
}

function main() {
  const heat = readJSON(HEAT, { items: [] });
  const ledger = readJSON(LEDGER, { items: {} });
  const result = readJSON(RESULT, {});
  const kickOf = {};
  for (const k of Object.keys(ledger.items || {})) {
    const e = ledger.items[k];
    const id = String(e.id || (k.split(':')[0]));
    if (e.kickTs) kickOf[id] = +e.kickTs;
  }
  const frames = collectFrames(kickOf);
  const items = [];
  for (const x of (heat.items || [])) {
    const id = String(x.id);
    const fr = frames[id] || {};
    const info = pickStrong(fr);
    if (!info) continue;
    const tier = tierOf(info);
    if (tier === '观察') continue;
    const hotName = info.hot === 'home' ? x.home : x.away;
    // 让分线（竞彩优先）
    const hdc = fr.jc_hdc || fr.eu_hdc || null;
    const line = hdc ? num(hdc.line) : null;
    // 已完赛：按真实让分线核对跟强队方向（让分盘赢盘方）
    let settled = null, settleNote = null;
    const rHdc = result[id + ':hdc'];
    if (rHdc && rHdc.verified === true && rHdc.result && line !== null) {
      // rHdc.result=winning side by line (home/away)
      settled = rHdc.result === info.hot ? 'hitByLine' : 'missByLine';
      settleNote = '让分线' + line + ' · ' + (rHdc.score || '') + ' · ' + (rHdc.src || '');
    }
    // 独赢赛果（跟强队方向）
    const rMnl = result[id + ':mnl'];
    let mnlWin = null;
    if (rMnl && rMnl.verified === true && rMnl.result) mnlWin = rMnl.result === info.hot ? 'hit' : 'miss';
    items.push({
      id, day: x.day, league: x.league, home: x.home, away: x.away,
      kickTs: kickOf[id] || null,
      tier, hot: info.hot, hotName,
      strongP: info.strongP, blendP: info.blendP, nSrc: info.nSrc,
      agree: info.agree, disagree: info.disagree, mainSrc: info.mainSrc,
      odds: { strong: info.strongOdds, jcMnl: fr.jc_mnl ? fr.jc_mnl.quote : null,
              euMnl: fr.eu_mnl ? fr.eu_mnl.quote : null, bd: fr.bd_sfgg ? fr.bd_sfgg.quote : null },
      line, lineSrc: hdc ? (hdc.source + '/' + hdc.market) : null,
      capturedAt: (fr[info.mainSrc === '365独赢' ? 'eu_mnl' : info.mainSrc === '竞彩独赢' ? 'jc_mnl' : 'bd_sfgg'] || {}).observed_at || null,
      settledByLine: settled, settleNote, mnlWin,
      sources: info.sources,
      direction: '跟强队(' + (info.hot === 'home' ? '主' : '客') + ' ' + hotName + ')',
    });
  }
  // 分档排序：强推>精选>优选，同档按强度降序，日期降序
  const rank = { 强推: 0, 精选: 1, 优选: 2 };
  items.sort((a, b) => (rank[a.tier] - rank[b.tier]) || (b.blendP - a.blendP) || String(b.day).localeCompare(a.day));
  // 分档区分度验证：档位应跟独赢命中率正相关；让分线是另一口径(强队赢球≠赢盘)，仅参考
  const tierStat = {};
  for (const tier of ['强推', '精选', '优选']) {
    const g = items.filter(x => x.tier === tier);
    const mDone = g.filter(x => x.mnlWin === 'hit' || x.mnlWin === 'miss');
    const mHit = mDone.filter(x => x.mnlWin === 'hit').length;
    const lDone = g.filter(x => x.settledByLine);
    const lHit = lDone.filter(x => x.settledByLine === 'hitByLine').length;
    tierStat[tier] = {
      n: g.length,
      mnl: { n: mDone.length, hit: mHit, rate: mDone.length ? +(100 * mHit / mDone.length).toFixed(1) : null },
      byLine: { n: lDone.length, hit: lHit, rate: lDone.length ? +(100 * lHit / lDone.length).toFixed(1) : null },
    };
  }
  const summary = {
    total: items.length,
    byTier: items.reduce((o, x) => (o[x.tier] = (o[x.tier] || 0) + 1, o), {}),
    byDay: items.reduce((o, x) => (o[x.day] = (o[x.day] || 0) + 1, o), {}),
    withLine: items.filter(x => x.line !== null).length,
    settledByLine: items.filter(x => x.settledByLine).length,
    tierStat,
    sourceNote: 'D盘快照流水真实临盘帧；赛前<kickTs硬过滤；跟强队=独赢方向；档位=信号强度分级',
    settleNote: '结算主口径=独赢(跟强队是否赢球)；让分线仅参考展示(强队赢球≠赢盘，深盘打不住)',
    risk: '观察分档 n=25<40、ROI z≈0，未达进引擎铁律，不进方向账本/ROI/投注建议',
  };
  const out = { version: VERSION, updated: new Date().toISOString(), summary, items };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('WROTE', OUT);
  console.log('SUMMARY', JSON.stringify(summary));
  const focus = ['2042900', '2042983', '2042989', '2042985'];
  console.log('\n=== 用户挑选4场 ===');
  for (const id of focus) {
    const x = items.find(y => y.id === id);
    if (!x) { console.log(id, '未产出档位(观察)'); continue; }
    console.log(id, x.tier, x.direction, '强度' + x.blendP + '%', x.nSrc + '源共振' + x.agree + '/' + (x.agree + x.disagree),
      '主源' + x.mainSrc, '线' + x.line, x.settledByLine || (x.mnlWin ? '独赢' + x.mnlWin : '未结算'));
    console.log('   源:', x.sources.map(s => s.src + ' ' + s.homeP + '%→' + s.hot).join(' | '));
  }
}
main();
