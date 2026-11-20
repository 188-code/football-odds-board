#!/usr/bin/env node
/* ============================================================================
 * 篮球三盘资金过热核对账本（观察档，非投注信号）
 * ----------------------------------------------------------------------------
 * 依据洋哥5份文件、但严格区分「原文口径」与「篮球迁移估计」：
 *  - 三盘=顺序链(主文L184-201)：一盘竞彩资金趋势→二盘365异常操盘→三盘北单资金分布。
 *    切勿从三盘倒推；五步法(L203-215)第4步临场盘水印印篮球做不到(无连续序列)。
 *  - 大热判定(L174/L178 原始口径)：北单赔率池(100%返还)换算到参照盘返还率后，
 *    只看【上盘=北单资金占比高方】一个方向的偏差 > 缺口(=1−参照盘返还率) → 大热 → 站该方对面。
 *    ★勘误(11-19)：旧版误用"devHome/devAway数值更大者"定大热方，两盘分歧时会把被低估的下盘
 *    当大热(真实2042852资金高方客52.5%但偏差大方是主队)。已改回资金高方口径。
 *  - 篮球迁移(明确标注,非洋哥原法)：365篮球被封(gqj2 HTTP567)，用【竞彩篮球】
 *    当参照盘。竞彩篮球返还率≈85% → 缺口≈15%（洋哥案例365返还94%→缺口6%）。
 *    北单篮球270是【胜负两项】让分盘(非胜平负三项)，只有sp1/sp2。
 *  - 北单池份额 = (1/SP)/Σ(1/SP)；因北单100%返还Σ(1/SP)≈1，1/SP≈资金份额代理。
 *  - 跨源护栏：仅在【让分线一致】(竞彩hdc.line==北单rawHandicap)时才做偏差对比；
 *    异线一律标"不可比·不计入判定"。方向以home/away同侧为准，不推断让分符号。
 *  - 结算：只认 basket_result.json 中 verified=true 的 result(win/lose按让分盘方向)，
 *    不信 pick 字段(实测存在 result=away 但 pick=让分主胜 的不一致)。
 *  - 展示集=统计集=版本集；带±SE；n<40观察档，绝不进下注引擎/方向票/仓位。
 * 输入：basket_heat.json(历史+当前合并)、basket_result.json
 * 输出：basket_overheat.json
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = arg('--root', __dirname);
const READ = [
  path.join(ROOT, 'basket_heat.json'),
  path.join(ROOT, 'basket_result.json'),
];
const OUT = path.join(ROOT, 'basket_overheat.json');
// ★ 2026-11-19：北单270是「当期在售」快照，完赛即下架、heat滚动窗口只留最近8场，
//   导致 11-19 完赛场次的三盘报价在滚动中被冲掉，账本一场都生成不了。
//   实际每场赛前的竞彩hdc帧+北单sfgg帧都永久落在「快照流水/YYYYMMDD.jsonl」里。
//   这里从归档补回，第三环才不丢。data_dir 与 basket_collect.py 默认值保持一致。
const SNAP_DIR = arg('--snap-dir', process.env.BASKET_SNAP_DIR || (process.platform === 'win32'
  ? 'D:/北单竞彩数据/篮球/快照流水'
  : '/opt/football/pool_cloud/basketball/快照流水'));
// ★ 2026-11-20 二盘补位：球探(titan007)滚动采集的 365/皇冠帧 + 独立完场赛果
//   （t7_bb.py 每5分钟落 POOL_BASE/basketball/b365/；365被封后二盘首次有真实数据源）
const B365_DIR = arg('--b365-dir', process.env.B365_DIR || path.join(path.dirname(SNAP_DIR), 'b365'));
const RULE_V = 'basket_overheat_seqchain_mnl_20261119';
const MIN_N = 40;

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function num(v) { return (v !== null && v !== undefined && isFinite(+v)) ? +v : null; }

// 从快照流水归档补回赛前 poll 帧：每场(jc hdc / bd sfgg)取最后一条有效帧(最临盘)。
// 帧格式: {kind:'poll',source:'jc'|'bd',id,market,quote:{home,away,line},observed_at}
// 元数据(day/league/home/away)从 basket_dir_ledger.json 补；缺失则跳过，绝不编造。
function readSnapshotFrames(meta) {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(SNAP_DIR).filter(f => /^\d{8}\.jsonl$/.test(f)).sort(); } catch (e) { return out; }
  for (const fn of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(SNAP_DIR, fn), 'utf8').trim().split('\n'); } catch (e) { continue; }
    for (const ln of lines) {
      let o;
      try { o = JSON.parse(ln); } catch (e) { continue; }
      if (o.kind !== 'poll' || !o.id || !o.quote) continue;
      const src = o.source, q = o.quote;
      if (src !== 'jc' && src !== 'bd') continue;
      if (!(num(q.home) > 1.01 && num(q.away) > 1.01)) continue;
      const id = String(o.id);
      // 只认有元数据的场次(方向账本曾采到)，否则无法标注对阵/联赛
      if (!meta[id]) continue;
      if (!out[id]) out[id] = {};
      // ★重构:分离独赢(mnl=一盘主口径)与让分(hdc)。旧版只存 jc(hdc)导致用错盘口。
      const key = src === 'jc' ? (o.market === 'mnl' ? 'mnl' : 'hdc') : 'bd';
      // 后写覆盖先写(fn按日期排序，取最临盘最后一条)
      out[id][key] = {
        home: +q.home, away: +q.away,
        line: q.line !== undefined && q.line !== null && q.line !== '' ? q.line : (o.line !== undefined ? o.line : null),
        observed_at: o.observed_at || null,
      };
    }
  }
  return out;
}

// ★★ 2026-11-20 二盘补位读取：t7_bb.py 落的 365/皇冠帧（per 竞彩id 取最临盘一帧）
//    帧格式 {kind:'poll',source:'t7bb',id:<竞彩id>,sid,quote:{b365:{mnl,hdc,total},crown:{hdc,total},g1,g2},observed_at,kick_ts}
//    采集端已有 now<kick_ts 硬护栏；这里再防御一次（observed_at < kick_ts 才认）。
//    b365.mnl 符号：{home,away}（已按 736161/740063 双场验证主客列序）。
function readB365Frames() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(B365_DIR).filter(f => /^\d{8}\.jsonl$/.test(f)).sort(); } catch (e) { return out; }
  for (const fn of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(B365_DIR, fn), 'utf8').trim().split('\n'); } catch (e) { continue; }
    for (const ln of lines) {
      let o;
      try { o = JSON.parse(ln); } catch (e) { continue; }
      if (o.kind !== 'poll' || o.source !== 't7bb' || !o.id || !o.quote) continue;
      const q = o.quote;
      if (!q.b365 || !q.b365.mnl) continue;                 // 判定用365独赢；只有让分/皇冠的帧不入
      const b = q.b365.mnl;
      if (!(num(b.home) > 1.01 && num(b.away) > 1.01)) continue;
      const obs = o.observed_at ? Date.parse(o.observed_at) / 1000 : 0;
      if (o.kick_ts && obs >= o.kick_ts) continue;           // 双保险：开赛后帧不认
      const cur = out[o.id];
      if (cur && Date.parse(cur.observed_at) >= obs) continue; // 取最临盘
      out[o.id] = {
        sid: o.sid || null,
        mnl: { home: +b.home, away: +b.away },
        hdc: q.b365.hdc || null, total: q.b365.total || null,
        crown: q.crown || null,
        observed_at: o.observed_at || null,
      };
    }
  }
  return out;
}

// t7_bb.py 的完场比分赛果源（含欧篮联，修 ESPN 无赛果缺口）；返回 {sid:{...}}
function readT7Results() {
  try {
    return JSON.parse(fs.readFileSync(path.join(B365_DIR, 'results_t7.json'), 'utf8'));
  } catch (e) { return {}; }
}

// 方向账本作为元数据+兜底报价来源(items里 market=hdc 的 oddsA/oddsB/line)
function readDirLedgerMeta() {
  const d = readJSON(path.join(ROOT, 'basket_dir_ledger.json'));
  const meta = {};
  if (!d || typeof d.items !== 'object') return meta;
  for (const x of Object.values(d.items)) {
    if (!x || !x.id) continue;
    if (!meta[x.id]) meta[x.id] = { day: x.day, league: x.league, home: x.home, away: x.away };
    if (x.market === 'hdc' && !meta[x.id].jcFallback && num(x.oddsA) > 1.01 && num(x.oddsB) > 1.01) {
      meta[x.id].jcFallback = { home: +x.oddsA, away: +x.oddsB, line: x.line, observed_at: x.observed_at };
    }
    if (x.market === 'mnl' && !meta[x.id].mnlFallback && num(x.oddsA) > 1.01 && num(x.oddsB) > 1.01) {
      meta[x.id].mnlFallback = { home: +x.oddsA, away: +x.oddsB, observed_at: x.observed_at };
    }
  }
  return meta;
}

// ★★ 2026-11-19 框架重构：洋哥三盘是【顺序链】，一盘竞彩独赢资金趋势就能给方向。
//    旧版错在: (ERR1)用让分盘hdc+sfgg 而非独赢盘; (ERR2)要求让分线一致才可比;
//    (ERR3)第三环北单缺失就跳过整场, 丢掉一盘方向。
//    新版: 以【竞彩独赢mnl】为必备主口径(一盘), 让分hdc/北单sfgg为可选增强(三盘确认)。
//          北单缺失不吞方向, 只降档标注"仅一盘·观察"。
// 收集所有有「竞彩独赢 mnl」的场次（一盘必备；北单/让分可选）
// 同源只增不覆：先载入已有账本，再追加；已存在 id 不覆盖历史快照。
function collectMatches() {
  const map = {};
  const prev = readJSON(OUT);
  // ★只增不覆但有优先级：真实独赢帧 > 旧账本让分兜底。
  //   put()保留先到历史；enrichMNL()允许用更优质的独赢帧填补/替换口径退化(null.mnl)。
  const put = (o) => { if (!map[o.id]) map[o.id] = o; };
  const enrichMNL = (id, mnl, src) => {
    if (!mnl || !(num(mnl.home) > 1.01 && num(mnl.away) > 1.01)) return;
    if (!map[id]) return;
    const cur = map[id];
    // 当前无独赢，或当前独赢是让分兜底(jc同源)且新帧来自真实mnl采集 → 用新帧
    if (!cur.mnl || (cur._mnlFromJc && src === 'mnl')) {
      cur.mnl = { home: +mnl.home, away: +mnl.away };
      if (src === 'mnl') cur._mnlFromJc = false;
    }
  };
  if (prev && Array.isArray(prev.items)) {
    for (const x of prev.items) {
      if (!x.mnl && !x.jc) continue;
      put({
        id: x.id, day: x.day, league: x.league, home: x.home, away: x.away,
        mnl: x.mnl || null, jc: x.jc || null, bd: x.bd || null,
        observed_at: x.capturedAt,
        _mnlFromJc: !x.mnl && !!x.jc, // 旧账本无独赢→标记兜底，允许被真实mnl帧替换
      });
    }
  }
  for (const f of READ) {
    const d = readJSON(f);
    if (!d || !Array.isArray(d.rows)) continue;
    for (const r of d.rows) {
      const m = r.markets || {};
      const mnl = m.mnl, hdc = m.hdc;
      const bd = r.bd && r.bd.markets && r.bd.markets.sfgg;
      if (!(num(mnl && mnl.home) > 1.01 && num(mnl && mnl.away) > 1.01)) continue; // 一盘必备
      enrichMNL(r.id, mnl, 'mnl');
      put({
        id: r.id, day: r.day, league: r.league, home: r.home, away: r.away,
        mnl: { home: +mnl.home, away: +mnl.away },
        jc: (num(hdc && hdc.home) > 1.01) ? { home: +hdc.home, away: +hdc.away, line: hdc.line } : null,
        bd: (num(bd && bd.home) > 1.01) ? { home: +bd.home, away: +bd.away, line: r.bd.rawHandicap } : null,
        observed_at: r.observed_at,
      });
    }
  }
  // 从快照流水归档补回被 heat 滚动冲掉的场次（11-19 完赛场次）
  const meta = readDirLedgerMeta();
  const frames = readSnapshotFrames(meta);
  for (const id of Object.keys(frames).sort()) {
    const fr = frames[id];
    const mnl = fr.mnl || meta[id].mnlFallback; // 优先快照独赢帧，兜底方向账本
    if (!mnl) continue;
    if (!(num(mnl.home) > 1.01 && num(mnl.away) > 1.01)) continue;
    enrichMNL(id, mnl, fr.mnl ? 'mnl' : 'fallback'); // 旧账本兜底场也用真mnl帧刷新
    if (map[id]) continue;
    put({
      id, day: meta[id].day, league: meta[id].league, home: meta[id].home, away: meta[id].away,
      mnl: { home: +mnl.home, away: +mnl.away },
      jc: (num(fr.hdc && fr.hdc.home) > 1.01) ? { home: +fr.hdc.home, away: +fr.hdc.away, line: fr.hdc.line } : (meta[id].jcFallback || null),
      bd: (num(fr.bd && fr.bd.home) > 1.01) ? { home: +fr.bd.home, away: +fr.bd.away, line: fr.bd.line } : null,
      observed_at: mnl.observed_at || null,
    });
  }
  // ★2026-11-20 二盘补位：把球探 365/皇冠 最临盘帧挂到账本场（历史场无帧=保持缺位，不编造）
  const b365ById = readB365Frames();
  for (const id of Object.keys(b365ById)) {
    if (map[id]) map[id].b365 = b365ById[id];
  }
  return map;
}

// ★★ 洋哥三盘顺序链判定（2026-11-19框架重构）
//   一盘(竞彩独赢mnl)：资金趋势 → 大热门方(隐含概率高方) → 站其对面 = 方向
//   二盘(365操盘)：篮球被封，缺位标注（洋哥原文此环判断异常操盘，篮球做不到）
//   三盘(北单sfgg)：资金分布确认。有→看是否与一盘共振；无→降档"仅一盘"，不吞方向
//   洋哥原文P.S.：篮球如何具体用北单热度有单独文章，不在5文件内 → 三盘仅为近似确认
function evaluate(m, result, t7Results) {
  // 旧账本历史场次只有让分盘jc、无独赢mnl → 用jc兜底(标注口径退化)，绝不让脚本崩
  if (!m.mnl && m.jc) m = Object.assign({}, m, { mnl: { home: m.jc.home, away: m.jc.away }, _mnlFallback: true });
  if (!m.mnl) return null;
  const H = m.mnl.home, A = m.mnl.away;
  const Rjc = 1 / (1 / H + 1 / A);          // 竞彩独赢返还率
  const gap = 1 - Rjc;                      // 返还率缺口（动态）
  const pH = (1 / H) / (1 / H + 1 / A);     // 竞彩独赢去水隐含 主
  const pA = 1 - pH;

  // 一盘：大热门方=隐含概率高方；方向=站对面
  const hot1 = pH >= pA ? 'home' : 'away';
  const hotPct = Math.max(pH, pA) * 100;
  const fadeSide = hot1 === 'home' ? 'away' : 'home';

  // 三盘：北单资金分布（有则算，无则 null）—— 独赢口径近似：北单sfgg让分胜负两项的池份额
  let shareHome = null, shareAway = null, hotBd = null, resonance = '无北单·仅一盘';
  let devHome = null, devAway = null, upDev = null, sumBd = null, lineJc = null, lineBd = null, sameLine = null;
  if (m.bd) {
    sumBd = 1 / m.bd.home + 1 / m.bd.away;
    shareHome = (1 / m.bd.home) / sumBd;
    shareAway = (1 / m.bd.away) / sumBd;
    hotBd = shareHome >= shareAway ? 'home' : 'away';
    // 北单换算到竞彩返还率后偏差（洋哥公式，独赢近似；保留供参考，不再作护栏）
    const convH = m.bd.home * Rjc, convA = m.bd.away * Rjc;
    devHome = (1 / convH - 1 / H) * 100;
    devAway = (1 / convA - 1 / A) * 100;
    upDev = hotBd === 'home' ? devHome : devAway;
    lineJc = m.jc ? num(m.jc.line) : null;
    lineBd = num(m.bd.line);
    sameLine = lineJc !== null && lineBd !== null && Math.abs(lineJc - lineBd) < 0.01;
    // 共振：北单资金高方与一盘大热门方同侧 → 三盘确认；异侧 → 分歧降档
    resonance = hotBd === hot1 ? '三盘共振·确认' : '三盘分歧·降档';
  }

  // 二盘（2026-11-20 补位）：球探转引 365 独赢 → 去水隐含 → 热方投票
  //   365是滚动变更帧：缺帧=近期未动盘，如实标"缺"，不编造。
  let p365H = null, p365A = null, hot365 = null, b365Agree = null, b365Obs = null;
  if (m.b365 && m.b365.mnl && m.b365.mnl.home) {
    const iH = 1 / m.b365.mnl.home, iA = 1 / m.b365.mnl.away, s = iH + iA;
    p365H = iH / s; p365A = iA / s;
    hot365 = p365H >= p365A ? 'home' : 'away';
    b365Agree = hot365 === hot1;
    b365Obs = m.b365.observed_at || null;
  }
  const bdAgree = m.bd && hotBd ? (hotBd === hot1) : null;
  // ★热端合流分（同足球 heatScore 口径）：一盘(竞彩独赢)=1起算 + 北单同侧 + 365同侧
  const heatScore = 1 + (bdAgree === true ? 1 : 0) + (b365Agree === true ? 1 : 0);

  // 判定：一盘给方向（洋哥顺序链起点）；北单有则标注共振/分歧
  // coldSide = 站对面方向（fadeSide）。是否"大热"用一盘隐含概率是否显著超出均衡(>50%+最低热阈)
  // 篮球无权威"大热"绝对阈值(洋哥缺口是两盘对比用)，故 hotFlag 表示"有一盘方向信号"，
  //   但 severity 分档：共振>仅一盘>分歧，全部观察档 n<40不进引擎。
  // 洋哥盘级换算原文：独赢胜赔≤约1.9(隐含>~53%)已入半球中水区、≤1.75约半球低水。
  // 篮球独赢无平局，隐含>55%即明确倾向一方(如人家复现场凯尔特人1.52=55.8%)。
  const HOT_MIN = 0.55; // 一盘大热门最低隐含概率(观察档经验阈,非洋哥原文硬阈)
  const strong = hotPct / 100 >= HOT_MIN;
  let verdict;
  if (!strong) verdict = '一盘趋势弱(' + hotPct.toFixed(1) + '%)·方向参考';
  else if (heatScore === 3) verdict = '三端合流(竞彩+365+北单)·站对面(' + (fadeSide === 'home' ? '主' : '客') + ')【强置信·观察】';
  else if (b365Agree === false || bdAgree === false) {
    const dis = [];
    if (bdAgree === false) dis.push('北单分歧');
    if (b365Agree === false) dis.push('365分歧');
    verdict = '一盘大热' + (hot1 === 'home' ? '主' : '客') + '·' + dis.join('+') + '→降档';
  }
  else if (b365Agree === true && bdAgree === null) verdict = '两端合流(竞彩+365)·站对面(' + (fadeSide === 'home' ? '主' : '客') + ')';
  else if (bdAgree === true && b365Agree === null) verdict = '一盘大热' + (hot1 === 'home' ? '主' : '客') + '·北单共振→站对面(' + (fadeSide === 'home' ? '主' : '客') + ')';
  else verdict = '一盘大热' + (hot1 === 'home' ? '主' : '客') + '·仅一盘→站对面(' + (fadeSide === 'home' ? '主' : '客') + ')';

  // hotFlag：有一盘明确方向信号（供统计/结算）；趋势弱场次不计入严格命中统计
  const hotFlag = strong;

  // 结算：站对面(fadeSide)是否命中 —— 用 verified 独赢赛果 result(home/away赢)
  // ★2026-11-20 赛果兜底：basket_result.json 无该场时，用球探完场比分(t7_bb.py，含欧篮联)按比分推独赢胜方
  let settle = null, resSrc = null, resWinner = null, resScore = null;
  const res = result && result.verified === true ? result.result : null;
  if (res && (res === 'home' || res === 'away')) {
    resWinner = res; resScore = result.score || null; resSrc = 'verified';
  } else if (t7Results && m.b365 && m.b365.sid) {
    const t7 = t7Results[m.b365.sid];
    if (t7 && (t7.winner === 'home' || t7.winner === 'away')) {
      resWinner = t7.winner; resScore = t7.score || null; resSrc = '球探完场比分';
    }
  }
  if (hotFlag && resWinner) settle = (resWinner === fadeSide) ? 'hit' : 'miss';

  return {
    id: m.id, day: m.day, league: m.league, home: m.home, away: m.away,
    capturedAt: m.observed_at,
    mnl: m.mnl, jc: m.jc, bd: m.bd,
    b365: m.b365 ? { mnl: m.b365.mnl, hdc: m.b365.hdc, total: m.b365.total,
                     crown: m.b365.crown, observed_at: b365Obs } : null,
    metrics: {
      mnlFallback: m._mnlFallback === true, // 旧账本用让分盘兜底独赢(口径退化标注)
      Rjc: +(Rjc * 100).toFixed(2),
      gap: +(gap * 100).toFixed(2),
      pH: +(pH * 100).toFixed(1), pA: +(pA * 100).toFixed(1),
      hot1, hotPct: +hotPct.toFixed(1),
      fadeSide,
      resonance,
      // ★2026-11-20 二盘补位与热端合流
      p365H: p365H === null ? null : +(p365H * 100).toFixed(1),
      p365A: p365A === null ? null : +(p365A * 100).toFixed(1),
      hot365, b365Agree, bdAgree, heatScore,
      sumBd: sumBd === null ? null : +sumBd.toFixed(4),
      shareHome: shareHome === null ? null : +(shareHome * 100).toFixed(1),
      shareAway: shareAway === null ? null : +(shareAway * 100).toFixed(1),
      hotBd,
      devHome: devHome === null ? null : +devHome.toFixed(2),
      devAway: devAway === null ? null : +devAway.toFixed(2),
      upDev: upDev === null ? null : +upDev.toFixed(2),
      sameLine, lineJc, lineBd,
    },
    verdict, hotFlag, fadeSide,
    strongTier: hotFlag && heatScore === 3,
    settle,
    result: resWinner,
    resultScore: resScore,
    resSrc,
  };
}

// 统计(展示集=统计集): 只对 sameLine 且已判大热的场次算命中/ROI
function summarize(items) {
  const judged = items.filter(x => x.hotFlag); // ★一盘方向为判定起点，不再要求让分线一致
  const settled = judged.filter(x => x.settle);
  const n = settled.length, hit = settled.filter(x => x.settle === 'hit').length;
  const hitRate = n ? +(100 * hit / n).toFixed(1) : null;
  const se = n ? +(Math.sqrt(hitRate * (100 - hitRate) / n)).toFixed(1) : null;
  const reson = items.filter(x => x.metrics.resonance === '三盘共振·确认').length;
  // ★2026-11-20 二盘补位统计：三端合流(强置信) 与 三端已结算
  const b365N = items.filter(x => x.b365 && x.b365.mnl).length;
  const strongN = items.filter(x => x.strongTier).length;
  const strongSettled = items.filter(x => x.strongTier && x.settle);
  const sN = strongSettled.length, sHit = strongSettled.filter(x => x.settle === 'hit').length;
  const sRate = sN ? +(100 * sHit / sN).toFixed(1) : null;
  const sSe = sN ? +(Math.sqrt(sRate * (100 - sRate) / sN)).toFixed(1) : null;
  const t7Settled = items.filter(x => x.resSrc === '球探完场比分').length;
  return {
    totalMatches: items.length,
    withNorth: items.filter(x => x.bd).length,       // 有第三环北单
    noNorth: items.filter(x => !x.bd).length,        // 仅一盘(北单缺失)
    resonanceN: reson,                               // 一盘+三盘共振
    withB365: b365N,                                 // ★二盘365有帧
    strongN,                                         // ★三端合流(强置信观察)
    strongSettled: sN, strongHit: sHit, strongHitRate: sRate, strongSe: sSe,
    t7SettledN: t7Settled,                           // ★球探完场比分结算场数(含欧篮联)
    hotFlagged: judged.length,
    settledN: n, hit, hitRate, se,
    significant: n >= MIN_N,
    crossZero: hitRate !== null && se !== null && Math.abs(hitRate) <= se,
    caveat: 'n<40观察档;一盘=竞彩独赢资金趋势(洋哥顺序链起点);二盘365自2026-11-20起用球探滚动帧补位(此前缺位,历史场无365=真实缺,不回补);三盘北单让分近似确认;强置信=三端合流(JC+365+北单同侧),前瞻口径无历史回测,不进引擎;第4步临场序列篮球做不到',
  };
}

function main() {
  const matches = collectMatches();
  const results = readJSON(READ[1]) || {};
  // 赛果同源只增不覆：从已有账本补回已核验赛果（防止 basket_result.json 缺历史场时命中丢失）
  const prevLedger = readJSON(OUT);
  if (prevLedger && Array.isArray(prevLedger.items)) {
    for (const x of prevLedger.items) {
      if (!x.result) continue;
      const k = x.id + ':mnl';
      // ★2026-11-20 修正：只写 :mnl 键。旧版同时写 :mnl/:hdc 两个键，把独赢胜方灌进
      //   让分键空间，若未来读 :hdc 会拿到错误的"让分赛果"。
      if (!results[k] || results[k].verified !== true) {
        results[k] = { verified: true, result: x.result, score: x.resultScore || null, src: 'overheat旧产物同源回填' };
      }
    }
  }
  // ★2026-11-20 账本同源回填：basket_dir_ledger.json 已核验结算（result+finalScore+settleSrc）
  //   但 basket_result.json 缺条目时，从账本按最终比分补回独赢赛果（只增不覆）。
  //   根因：_gen_basket_result.cjs 旧版全量覆盖曾清掉手工核验条目（欧篮联 11-18 六场），
  //   账本已结算、本板块却显示待结算。账本 finalScore="主-客"，独赢胜方按比分推导。
  const dirLedger = readJSON(path.join(ROOT, 'basket_dir_ledger.json'));
  let nLedgerBackfill = 0;
  if (dirLedger && dirLedger.items) {
    for (const e of Object.values(dirLedger.items)) {
      if (e.market !== 'mnl') continue;
      if (e.result === null || e.result === undefined) continue;
      const k = e.id + ':mnl';
      if (results[k] && results[k].verified === true) continue;
      const sc = typeof e.finalScore === 'string' ? e.finalScore.trim() : '';
      const mm = sc.match(/^(\d+)\s*[-:]\s*(\d+)$/);
      if (!mm) continue;
      const winner = +mm[1] > +mm[2] ? 'home' : 'away';
      results[k] = { verified: true, result: winner, score: sc, src: '账本同源回填 · ' + String(e.settleSrc || '').slice(0, 90) };
      nLedgerBackfill++;
    }
  }
  const items = [];
  const t7Results = readT7Results();
  for (const id of Object.keys(matches).sort()) {
    const m = matches[id];
    // ★2026-11-20 拆雷：不再拿让分盘 :hdc 赛果当独赢结算。让分胜负方向≠独赢胜负方向
    //   （如主队独赢小胜但让分-10.5为让分客胜），混用会算反。只认 :mnl verified。
    const mnlRes = results[id + ':mnl'];
    const ev = evaluate(m, mnlRes, t7Results);
    if (ev) items.push(ev);
  }
  const out = {
    version: RULE_V,
    updated: new Date().toISOString(),
    note: '★★2026-11-19框架重构:洋哥三盘=顺序链。一盘=竞彩独赢mnl资金趋势→大热门方(隐含概率高方)→站对面给方向(篮球完全可得);三盘北单sfgg让分近似确认(共振/分歧,缺失则降档仅一盘,不吞方向)。★★2026-11-20二盘补位:365篮球此前被567封死长期缺位,自今日起用球探(titan007)滚动帧补位——ch_nbaGoal8.xml(365让分/总分/半场/独赢)+sbOddsDataBsk第3组(皇冠,双场实测与ch_nbaGoal3全字段一致),t7_bb.py每5分钟只为白名单场落帧,kick前硬护栏;365是滚动变更表,历史场无365=真实缺,不回补不编造。★强置信口径=三端合流:heatScore=1(竞彩)+北单同侧+365同侧,3/3才标【强置信·观察】,前瞻口径无历史回测(365篮球无历史源),n<40绝不进引擎。★符号约定(球探篮球让分线正=主让,与竞彩相反;独赢列[13]=主[14]=客,736161/740063双场验证)。★赛果兜底:球探完场比分(t7_bb results_t7.json,含欧篮联——修ESPN无赛果缺口)按比分推独赢胜方,resSrc标注。结算=站对面方向vs独赢赛果。展示集=统计集=版本集。',
    summary: summarize(items),
    items,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('OUTPUT', OUT);
  console.log('SUMMARY', JSON.stringify(out.summary));
  for (const x of items) {
    console.log(x.day, x.away.slice(0, 6) + '@' + x.home.slice(0, 6),
      '| 竞彩独赢' + x.mnl.home + '/' + x.mnl.away + ' 隐含' + x.metrics.pH + '/' + x.metrics.pA + '%',
      '| 365' + (x.b365 && x.b365.mnl ? ' ' + x.b365.mnl.home + '/' + x.b365.mnl.away + ' 隐含' + x.metrics.p365H + '/' + x.metrics.p365A + '%' : ' 缺'),
      '| 北单' + (x.bd ? x.bd.home + '/' + x.bd.away : '缺'),
      '| 合流' + x.metrics.heatScore + '/3',
      '| 方向站' + (x.fadeSide === 'home' ? '主' : '客'),
      '|', x.metrics.resonance,
      '|', x.verdict, '|赛果', x.result, x.settle || '', x.resSrc ? '[' + x.resSrc + ']' : '');
  }
}
main();
