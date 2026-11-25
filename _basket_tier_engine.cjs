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
const HEAT_RAW = ROOT + 'basket_heat.json';   // ★ 2026-11-25：补 kickTs（新场在过热板/账本尚无条目）
const RESULT = ROOT + 'basket_result.json';
const OUT = ROOT + 'basket_tiers.json';
/* ★2026-11-25 v2 方向口径修正（用户截图两场 ★★ 精选复盘）：
   1) 深盘(|line|>8)跟大热门独赢实测为负边：全样本 n=19 跟强队 ROI -33.8% vs 站对面 +68.8%；
      训练段(11-18~23,n=11) -18.8% vs +16.6%，留出段(11-23~25,n=8) -54.4% vs +140.6%，两段同向。
      按项目铁律「一盘竞彩 mnl 隐含概率高方=大热门→站对面」，深盘翻到受让/冷门独赢一侧。
      中浅盘(<=8)实测跟强队更优(+8.1%/+2.1%)，保持不变——不是全面推翻，是分层修正。
   2) agree 只看方向不看强度：掘金场 72.6/75.8/54.0 spread=21.8pp 被误判 agree=3 给强推。
      新增 lineSpread>=15pp 降一档（假分歧门控）。
   3) 深盘 n=19<40，按铁律仍标观察档，不进 ROI 引擎/投注建议。 */
const VERSION = 'basket_tier_deepfade_20261125';

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
  // ★ 2026-11-25 锁死护栏修复：新场尚未进方向账本时，kickTs 从 basket_heat.rows 补。
  //   没有 kickTs 就挡不住开赛后帧（结论会一路变），故必须优先补齐；只认 captureTimeVerified 的真时刻。
  const heatRaw = readJSON(HEAT_RAW, { rows: [] });
  for (const r of (heatRaw.rows || [])) {
    const id = String(r.id || '');
    if (!id || kickOf[id]) continue;
    if (r.kickTs && r.captureTimeVerified === true) kickOf[id] = +r.kickTs;
  }
  const frames = collectFrames(kickOf);
  const items = [];
  for (const x of (heat.items || [])) {
    const id = String(x.id);
    const fr = frames[id] || {};
    const info = pickStrong(fr);
    if (!info) continue;
    // 让分线（竞彩优先）——方向判据要用到盘口深度，必须在 tier 之前取
    const hdc = fr.jc_hdc || fr.eu_hdc || null;
    const line = hdc ? num(hdc.line) : null;
    // ★方向：深盘站对面(受让/冷门)，中浅盘跟强队；pickSide=本次真正推荐的独赢方
    const deep = line !== null && Math.abs(line) > 8;
    const pickSide = deep ? (info.hot === 'home' ? 'away' : 'home') : info.hot;
    const pickName = pickSide === 'home' ? x.home : x.away;
    // ★假共振门控：三源强度分歧>=15pp 时降一档（方向一致但强度已分裂，不能当铁共振）
    const homePs = info.sources.map(s => s.homeP);
    const spread = homePs.length ? Math.max(...homePs) - Math.min(...homePs) : 0;
    let tier = tierOf(info);
    if (spread >= 15 && tier !== '观察') tier = tier === '强推' ? '精选' : tier === '精选' ? '优选' : '观察';
    if (tier === '观察') continue;
    const hotName = info.hot === 'home' ? x.home : x.away;  // 强队名（统计口径，不随 pickSide 变）
    void pickName; // direction 用 pickName 展示推荐方，hotName 保持强队语义
    // 已完赛：按真实让分线核对跟强队方向（让分盘赢盘方）
    let settled = null, settleNote = null;
    const rHdc = result[id + ':hdc'];
    if (rHdc && rHdc.verified === true && rHdc.result && line !== null) {
      // rHdc.result=winning side by line (home/away)；按本次推荐方(pickSide)判，不再固定 hot
      settled = rHdc.result === pickSide ? 'hitByLine' : 'missByLine';
      settleNote = '让分线' + line + ' · ' + (rHdc.score || '') + ' · ' + (rHdc.src || '');
    }
    // 独赢赛果（按本次推荐方 pickSide：深盘=站对面，中浅盘=跟强队）
    const rMnl = result[id + ':mnl'];
    let mnlWin = null;
    if (rMnl && rMnl.verified === true && rMnl.result) mnlWin = rMnl.result === pickSide ? 'hit' : 'miss';
    items.push({
      id, day: x.day, league: x.league, home: x.home, away: x.away,
      kickTs: kickOf[id] || null,
      tier, hot: info.hot, hotName,
      pickSide, directionRule: deep ? '深盘站对面(|line|>8)' : '跟强队',
      deep, lineSpread: +spread.toFixed(1),
      strongP: info.strongP, blendP: info.blendP, nSrc: info.nSrc,
      agree: info.agree, disagree: info.disagree, mainSrc: info.mainSrc,
      odds: { strong: info.strongOdds, jcMnl: fr.jc_mnl ? fr.jc_mnl.quote : null,
              euMnl: fr.eu_mnl ? fr.eu_mnl.quote : null, bd: fr.bd_sfgg ? fr.bd_sfgg.quote : null },
      line, lineSrc: hdc ? (hdc.source + '/' + hdc.market) : null,
      capturedAt: (fr[info.mainSrc === '365独赢' ? 'eu_mnl' : info.mainSrc === '竞彩独赢' ? 'jc_mnl' : 'bd_sfgg'] || {}).observed_at || null,
      // ★ 2026-11-25 锁死状态：有真开赛时刻→赛前帧被硬挡，开赛后结论不再变；无 kickTs→帧会继续进来，标未锁死
      locked: !!kickOf[id],
      settledByLine: settled, settleNote, mnlWin,
      // ★ 已核验的让分赢盘方（不是预测方向）：供对照外部软件「主让N·推荐X队方向」的让分口径。
      lineWinSide: (rHdc && rHdc.verified === true && ['home', 'away'].includes(rHdc.result)) ? rHdc.result : null,
      sources: info.sources,
      direction: (deep ? '深盘站对面(' : '跟强队(') + (pickSide === 'home' ? '主' : '客') + ' ' + pickName + ')',
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
    sourceNote: 'D盘快照流水真实临盘帧；赛前<kickTs硬过滤；深盘(|line|>8)=站对面受让/冷门独赢、中浅盘=跟强队；档位=信号强度分级；lineSpread>=15pp 假共振降一档',
    settleNote: '结算主口径=按本表推荐方(pickSide)的独赢胜负；深盘推荐受让/冷门，中浅盘推荐强队；lineWinSide=已核验让分赢盘方，供对照外部软件「主让N·推荐X队方向」的受让口径',
    risk: '观察分档未达进引擎铁律(n<40 / ROI z / 训练留出同向)，不进方向账本/ROI/投注建议；深盘站对面分层训练+留出同向但 n=19，继续累积',
    directionEvidence: '深盘|line|>8 n=19 跟强队独赢 11/19=57.9% ROI-33.8% vs 站对面 8/19=42.1% ROI+68.8%；训练(11场)-18.8%/+16.6%、留出(8场)-54.4%/+140.6% 两段同向；去最高赔1场仍+78.2%；中盘5-8跟强队+8.1%、浅盘<=5+2.1% 故不翻',
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
