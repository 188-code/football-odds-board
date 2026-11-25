/* auto_pick.cjs — 后台自动分析：扫描当天+明天全部有盘口的场次，跑引擎，挑出「重点」清单
 *
 * 为什么要这一步：页面只在用户打开时才分析。后台每轮刷新数据后自己先算一遍，
 * 把值得看的场次（下注级 + 置信达标）落成 markdown，用户不需要盯着页面等。
 *
 * 输入：bake_data.json（烘焙产物） + jingcai.json（竞彩官方）
 * 输出：_picks/今日重点-YYYYMMDD.md
 */
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const TOP_N = 20;
const here = __dirname;

function readJSON(f, def) {
  try { return JSON.parse(fs.readFileSync(path.join(here, f), 'utf8')); }
  catch (e) { return def; }
}

/* 列式 pack（{#:[列名], r:[[值]]}）还原成对象数组 */
function uncol(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (x['#'] && x.r) return x.r.map(row => {
    const o = {};
    x['#'].forEach((k, i) => { o[k] = row[i]; });
    return o;
  });
  return [];
}

const bake = readJSON('bake_data.json', null);
if (!bake || !Array.isArray(bake.matches)) {
  console.log('auto_pick: bake_data.json 不可用，跳过');
  process.exit(0);
}
/* ★ 2026-11-25 复盘修复：零输入不再伪装成成功。
   旧行为：bake.matches=[] 时（gqj2 全局护栏冷却期烘焙未产出），每15min 照跑并打印
   "共扫描 0 场"却记 OK，日志显示正常、实际啥也没干 → 掩盖真正该报警的零输入。
   现：零输入时明确打 WARN + 写状态文件，退出码仍 0（不刷假 FAIL 淹没真错误），
   但 WARN 字样会出现在 refresh 日志的 :: 尾部，且状态文件可供监控读取。 */
if (bake.matches.length === 0) {
  const _zeroState = { at: new Date().toISOString(), matches: 0,
    range: Array.isArray(bake.range) ? bake.range : [],
    note: 'bake_data.json 零输入：烘焙未产出比赛（多为 gqj2 全局护栏冷却期），自动挑重点空转，非抓取故障',
    warn: true };
  try { fs.writeFileSync(path.join(here, 'auto_pick_zero_input.json'), JSON.stringify(_zeroState, null, 2), 'utf8'); } catch (e) {}
  console.log('⚠️AUTO_PICK_ZERO_INPUT: bake_data.json matches=0（range=' + _zeroState.range.join('~') + '）· 自动挑重点空转 · 本轮无有效输出 · 非抓取故障');
  console.log('auto_pick: 扫描 0 场 → 跳过分析（零输入 WARN，状态见 auto_pick_zero_input.json）');
  process.exit(0);
}

// 竞彩官方数据挂进引擎
const jc = readJSON('jingcai.json', null);
if (jc && Array.isArray(jc.rows)) {
  try { E.loadJingcai(jc.rows); } catch (e) {}
}

/* 竞彩场次索引：key = 真实开赛日yyyymmdd + '|' + HH:MM
   ★ 竞彩 json 里的 date 是"销售批次日"：凌晨档（<12:00）的真实开赛在次日。
     不换算就会集体串位一天 —— 周三007 AC米兰vs本菲卡 的真实开赛是 9/17 03:00，不是 9/16。
   同一时间点常常有多场比赛（凌晨档尤其多），只按时间配对会张冠李戴 →
   存成数组，配对时再用队名字符重合度挑选，宁缺毋滥。 */
const JC_KEYS = {};
for (const r of ((jc && jc.rows) || [])) {
  const day8 = String(r.date || '').replace(/-/g, '');
  const hhmm = String(r.time || '').slice(0, 5);
  const hh = parseInt(hhmm.slice(0, 2), 10);
  const key = (day8 + '|' + hhmm).length > 9
    ? ((isFinite(hh) && hh < 12 ? shiftDayNum(day8, 1) : day8) + '|' + hhmm)
    : '';
  if (key.length > 9) (JC_KEYS[key] = JC_KEYS[key] || []).push(r);
}

const packs = bake.packs || {};
const today = (() => {
  const d = new Date(Date.now() + 8 * 3600e3);       // 北京时间
  return d.toISOString().slice(0, 10).replace(/-/g, '');
})();

const hasOdds = p => {
  const o = p && p.odds;
  if (!o) return false;
  return uncol(o.asia).length > 0 || uncol(o.eu).length > 0;
};

/* 队名：源站 zh 字段混 PUA 私用区实体；优先 engine 反混淆，退化到明文短名 _sb */
const clean = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&#x?[0-9a-fA-F]+;/g, '').replace(/\s+/g, '').trim();
/* 地区称谓规范化：源站是中国外源的原始队名，落到报告里必须按规范写「中国台北/中国香港/中国澳门」 */
const region = s => String(s || '')
  .replace(/中国?(台湾|台北)/g, '中国台湾').replace(/(^|[^国])台湾/g, '$1中国台湾')
  .replace(/(^|[^国])香港(?!队)/g, '$1中国香港').replace(/(^|[^国])澳门(?!队)/g, '$1中国澳门')
  .replace(/中国中国/g, '中国');
const name = (m, side) => {
  let t = '';
  try { t = clean(E.decodeName(m[side + '_name_zh'])); } catch (e) {}
  if (t.length < 2) t = clean(m[side + '_name_sb']);
  return region(t) || '?';
};
/* ★ 开赛时间基准（2026-09-17 21:20 **推翻并重新定标，见 ui.js realKickDay 注释**）
   match_time_int 按北京时间(UTC+8)解读 = 真实开赛时刻 —— 这是唯一可信来源。
   ★ **`_day` 就是自然日**，回退时用 `_day` 原值，**禁止 -1 天**（旧写法是错的，已删）。
     铁证：20:52 时刻 state=进行中的 28 场，`_day` 全为 20260917、match_time 小时 19/20/21/22。
     旧结论「hh>=12 则 -1 天」来自凌晨 01:00 的单一时段观测，盲区在下午/晚间 —— 定标必须覆盖全天。
   搞反的后果：① **每天中午之后，当天全部午后/晚间比赛被算成昨天并从列表消失**（页面"进行中"恒为 0）；
              ② 竞彩编号按时间配对，会标到邻日的同时间场次上（真出过：苏高联被标成周四009）。 */
function shiftDayNum(day8, delta) {
  const y = +day8.slice(0, 4), mo = +day8.slice(4, 6), d = +day8.slice(6, 8);
  const t = new Date(Date.UTC(y, mo - 1, d) + delta * 86400000);
  return String(t.getUTCFullYear()) + String(t.getUTCMonth() + 1).padStart(2, '0') + String(t.getUTCDate()).padStart(2, '0');
}
function realKick(m) {
  // 1) 优先用时间戳（秒；偶发毫秒）
  let sec = Number(m.match_time_int) || 0;
  if (sec > 1e12) sec = Math.floor(sec / 1000);
  let day = '', time = String(m.match_time || '').slice(0, 5);
  if (sec > 1e9) {
    const d = new Date(sec * 1000 + 8 * 3600e3);           // 按北京时间显示
    const p = n => String(n).padStart(2, '0');
    day = String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
    time = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }
  // 2) 退回 _day —— ★2026-09-17 21:20 重定标：**_day 就是自然日，禁止做 -1 天偏移**。
  //    铁证（必须记住的教训）：2026-09-17 20:52 实测，state=进行中的 28 场，
  //    `_day` 清一色 20260917、match_time 小时 = 19/20/21/22（此刻正在踢）。
  //    按旧的「hh>=12 则 -1 天」会把这些正在踢的比赛算成昨天 → 直接荒谬。
  //    旧结论是凌晨 01:00 只看 hh<12 的场次就外推全天，盲区恰恰在下午/晚间。
  //    定标必须覆盖全天 24 小时，不得凭单一时段观测外推。
  if (!/^\d{8}$/.test(day)) {
    day = String(m._day || '');
  }
  if (!sec) {
    const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(day);
    const tm = /^(\d{1,2}):(\d{2})/.exec(time);
    if (dm && tm) sec = Date.parse(`${dm[1]}-${dm[2]}-${dm[3]}T${tm[1].padStart(2, '0')}:${tm[2]}:00+08:00`) / 1000;
  }
  return { day: day, time: time, sec: sec };
}

const dayMsOf = day => (/^\d{8}$/.test(String(day || '')))
  ? Date.parse(String(day).slice(0, 4) + '-' + String(day).slice(4, 6) + '-' + String(day).slice(6, 8))
  : null;

/* 队名字符重合度（0~1）：用于同开赛点的多候选里挑真正那一场 */
function nameSim(a, b) {
  const A = new Set((clean(a) || '').split(''));
  const B = new Set((clean(b) || '').split(''));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  return inter / Math.max(1, Math.min(A.size, B.size));
}
function matchJc(m, home, away) {
  const k = realKick(m);                       // 换算到自然日后再配对，否则凌晨档整体串位
  const cands = JC_KEYS[k.day + '|' + k.time] || [];
  if (!cands.length) return null;
  let best = null, bs = 0;
  for (const c of cands) {
    const s = (nameSim(home, c.home) + nameSim(away, c.away)) / 2;
    if (s > bs) { bs = s; best = c; }
  }
  return bs >= 0.5 ? best : null;      // 定不了就宁可不标，绝不标错
}

/* 一对一分配：一个竞彩编号只能给最像的那一场。
   少了这一步，同一个 01:00 档的十几场比赛会共用同一个编号（曾一次标出 57 场"竞彩"）。 */
const JC_ASSIGN = {};                  // tid -> jc row
{
  const candMap = new Map();           // tid -> [{row, score}]
  for (const m of bake.matches) {
    const row = matchJc(m, name(m, 'home'), name(m, 'away'));
    if (row) {
      const arr = candMap.get(m.tournament_id) || [];
      arr.push({ row, score: (nameSim(name(m, 'home'), row.home) + nameSim(name(m, 'away'), row.away)) / 2 });
      candMap.set(m.tournament_id, arr);
    }
  }
  const bestOf = new Map();            // jc row -> {tid, score}
  for (const [tid, arr] of candMap) {
    arr.sort((x, y) => y.score - x.score);
    const top = arr[0];
    const prev = bestOf.get(top.row);
    if (!prev || top.score > prev.score) bestOf.set(top.row, { tid, score: top.score });
  }
  for (const [row, v] of bestOf) JC_ASSIGN[v.tid] = row;
}

const rows = [];
let scanned = 0, skippedNoOdds = 0, skippedStarted = 0, failed = 0;
const nowSec = Math.floor(Date.now() / 1000);

for (const m of bake.matches) {
  if (String(m.state) !== '0') continue;              // 只分析未开赛（源站 state 是数字）
  // 快照是上一次烘焙时抓的，期间已开踢的场次 state 还没同步 → 按开赛时间再滤一次（时间同样按自然日换算）
  const kick = realKick(m);
  const koSec = kick.sec;
  if (koSec && koSec < nowSec - 600) { skippedStarted++; continue; }
  const tid = m.tournament_id;
  const p = packs[tid];
  if (!hasOdds(p)) { skippedNoOdds++; continue; }
  scanned++;
  let agg, aggBs;
  try {
    agg = E.aggregate(uncol(p.odds.asia), uncol(p.odds.eu), false);
    aggBs = E.aggregateBs(uncol(p.odds.bs), false);
  } catch (e) { failed++; continue; }
  if (!agg || (!agg.c_valid && !agg.eu_valid)) { skippedNoOdds++; continue; }

  let a;
  try {
    a = E.analyze(agg, null, aggBs, null, tid, name(m, 'home'), name(m, 'away'),
                  (function () { try { return clean(E.leagueName(m)) || ''; } catch (e) { return ''; } })());
    if (!a) { failed++; continue; }
    /* 复刻 UI 的离线分析链路：先机构偏差校正，再信息面先验（交锋/排名/伤停）。
       少掉 applyInfoPrior 会把绝大多数场次判成 tier=1「下注级」，重点清单就没意义了。 */
    try { a = E.applyCorrection(a, m.league_name_zh || '', null); } catch (e) {}
    const ad = p.analysis;
    if (ad && ad.base) {
      try {
        a = E.applyInfoPrior(a, { base: ad.base, matchrank: ad.matchrank, battle: ad.battle, injury: ad.injury },
                             dayMsOf(kick.day));
      } catch (e) {}
    }
  } catch (e) { failed++; continue; }

  const conf = Number(a.conf) || 0;               // 引擎里 conf / value_score 本就是 0~100
  const jrow = JC_ASSIGN[tid] || null;
  rows.push({
    tid, day: kick.day, time: kick.time,
    league: (function () {                          // 联赛名走 engine 的 id→中文映射，避免 PUA 字体乱码串
      try { return clean(E.leagueName(m)) || ''; } catch (e) { return ''; }
    })(), home: name(m, 'home'), away: name(m, 'away'),
    dir: a.dir, conf, tier: a.tier || 0,
    mk_d: (typeof a.mk_d === 'number') ? +a.mk_d.toFixed(3) : 0,   // 市场平局概率（用于「平局关注」独立通道，注：引擎 mk_d 有已知 bug，仅平局通道用）
    mk_w: (typeof a.mk_h === 'number') ? +a.mk_h.toFixed(3) : 0,   // 市场主胜概率（落库校准用）
    mk_a: (typeof a.mk_a === 'number') ? +a.mk_a.toFixed(3) : 0,   // 市场客胜概率（落库校准用）
    strongDraw: !!(a.strongDraw),                                  // 强平局（市场头号+平赔<3.0，相对最易平）
    drawHeat: (a.draw_heat && a.draw_heat.flag) ? a.draw_heat.flag : '',  // 平局热度（过热陷阱/偏冷）
    vs: (typeof a.value_score === 'number') ? a.value_score : 0,
    hcap: (agg.c_hcap != null ? agg.c_hcap : agg.o_hcap),
    line: (aggBs && aggBs.c_line != null) ? aggBs.c_line : null,
    ou: a.ou_dir || '',
    asiaDir: a.asia_dir || '无方向',          // 十一修：让球方向（受让方 / 无方向）
    asiaCov: (typeof a.asia_cov === 'number') ? a.asia_cov : null,
    score: a.score || null,
    stages: (p && p.fused && Array.isArray(p.fused.stages)) ? p.fused.stages : null,   // ★ 初/中/临 五段盘路
    present: (p && p.fused && Array.isArray(p.fused.present)) ? p.fused.present : null,
    jc: jrow ? jrow.no : '', jcLeague: jrow ? (jrow.league || '') : ''
  });
}

// 「重点」口径：★方向感知选场 + 站对面热度（实盘校准纠偏"偏主胜"，并基于真实盘口热度逆向提权）
//   实盘：主胜命中仅50.9%、客胜60.3%更准 → 主胜门槛抬高、客胜门槛降低。
//   站对面：主胜市场隐含概率(mk_w)过热(≥55%)→压主胜、提客胜；客胜过热(≥50%)→对称压客胜、提主胜。
//   主胜硬上限：主胜注数 ≤ 客胜注数×1.5，超出按(价值+置信)截尾，强制组合不过度偏主胜。
// 站对面热度：基于真实盘口隐含概率的"相对领先"（非绝对阈值，足球主胜隐含概率很少过0.55）
//   主胜过热 = mk_w 为三方最高 且 mk_w≥0.48 且 领先次高方≥6pt → 压主胜、提客胜/平局
//   客胜过热 = mk_a 为三方最高 且 mk_a≥0.42 且 领先≥5pt → 对称压客胜、提主胜/平局
/* 🔴 八修门诊断：把「押向市场概率」分布打出来，防止门被砍到当天一条不出（2026-10-05 踩过）。
   rows 的 dir 是引擎中文串（主胜/客胜/参考·主胜/资金面·主胜/平局…），pPick 取对应市场的 mk。 */
const pPickOf = r => {
  const d = String(r.dir || '').trim();
  if (d.indexOf('主胜') >= 0) return Number(r.mk_w || 0);
  if (d.indexOf('客胜') >= 0) return Number(r.mk_a || 0);
  if (/^D$|平/.test(d)) return Number(r.mk_d || 0);
  return 0;
};
/* ⚠ 九修同步：t1/t2 门槛直接**读引擎导出的 PICK_GATE**，不在选场脚本里写死数字。
   引擎侧按真赛果定的门是「t1：主≥0.72 / 客≥0.75；t2：主≥0.65 / 客≥0.68」
   （live_log 2677 场：主≥0.72 命中 81.8%、客≥0.75 命中 92.5%；train 81.0 / test 80.5 同向）。
   若这里还按旧对称 0.70 判，就会出现「引擎判 tier1、清单里却没它」的两边不同步。 */
const GATE = (E.PICK_GATE || { T1_H: 0.72, T1_A: 0.75, T2_H: 0.65, T2_A: 0.68 });
const dirCode0 = r => {
  const d = String(r.dir || '');
  if (/^(W|H)$|主胜|资金面·主胜|参考·主胜/.test(d)) return 'W';
  if (/^(L|A)$|客胜|资金面·客胜|参考·客胜/.test(d)) return 'L';
  if (/^D$|平/.test(d)) return 'D';
  return '?';
};
const pGate1 = r => (dirCode0(r) === 'W' ? GATE.T1_H : GATE.T1_A);
{
  const pm = rows.map(pPickOf);
  const cnt = th => pm.filter(v => v >= th).length;
  const miss = pm.filter(v => !v).length;
  console.log('[门诊断] 引擎v' + (E.ENGINE_V || '?') + '｜rows=' + rows.length +
    '｜pPick≥0.75(客t1线) ' + cnt(0.75) + '｜≥' + GATE.T1_H + '(主t1线) ' + cnt(GATE.T1_H) +
    '｜≥0.65 ' + cnt(0.65) + '｜≥0.60 ' + cnt(0.60) + '｜=0(无欧赔/无方向) ' + miss +
    '｜tier≥1 ' + rows.filter(r => (r.tier || 0) >= 1).length +
    '｜tier≥1&conf≥70 ' + rows.filter(r => (r.tier || 0) >= 1 && (r.conf || 0) >= 70).length);
}
const isHomeHot = r => (typeof r.mk_w === 'number') && r.mk_w >= 0.48 && (r.mk_w - Math.max(r.mk_a || 0, r.mk_d || 0)) >= 0.06;
const isAwayHot = r => (typeof r.mk_a === 'number') && r.mk_a >= 0.42 && (r.mk_a - Math.max(r.mk_w || 0, r.mk_d || 0)) >= 0.05;
/* ⚠ 八修同步：conf 门槛跟着引擎的 pPick 门下调到 60~62（原 66~70）。
   引擎那道门已经用真实命中率筛过一遍（pPick≥0.62 那批实测 69.5%、≥0.70 那批 74.8%），
   展示层再叠一道 conf≥68 只会把「欧赔过关但引擎只给 conf58」的场挡在清单外，
   造成 2026-10-05 当天 275 场一条都没出手的空清单。 */
const homeConf = r => isHomeHot(r) ? 62 : (isAwayHot(r) ? 60 : 62);
const homeVs   = r => isHomeHot(r) ? 60 : (isAwayHot(r) ? 58 : 60);
/* ⚠ 2026-10-05 八修：客胜通道同样是**下注级专用**且 conf 门槛抬到 66~70。
   依据 live_log 实盘对账：客胜整条 48.0%(n=1204)，比主胜 62.1% 低 14pp，
   再把参考级(tier2)混进客胜清单，就等于把 45.3% 那批当成推荐塞给用户。
   新门（引擎侧 pPick≥0.62/0.70 且 conf≥70）已在 source 层卡死 tier，这里只做展示层收口：
   只列 tier===1 的客胜，并沿用「站对面」的相对门槛（过热时略松、被压时略紧）。 */
const awayConf = r => isAwayHot(r) ? 58 : (isHomeHot(r) ? 60 : 62);
const awayVs   = r => isAwayHot(r) ? 56 : (isHomeHot(r) ? 58 : 60);
const dirCode = r => {
  const d = String(r.dir || '');
  if (/^(W|H)$|主胜|资金面·主胜|参考·主胜/.test(d)) return 'W';
  if (/^(L|A)$|客胜|资金面·客胜|参考·客胜/.test(d)) return 'L';
  if (/^(D)$|平/.test(d)) return 'D';
  return '?';
};
const homePicks = rows.filter(r => dirCode(r) === 'W' && r.tier === 1 && r.conf >= homeConf(r) && r.vs >= homeVs(r));
const awayPicks = rows.filter(r => dirCode(r) === 'L' && r.tier === 1 && r.conf >= awayConf(r) && r.vs >= awayVs(r));
let _homeTrim = homePicks;
if (homePicks.length > awayPicks.length * 1.2) {
  _homeTrim = homePicks.slice().sort((x, y) => (y.vs + y.conf) - (x.vs + x.conf)).slice(0, Math.round(awayPicks.length * 1.2));
}
let picks = [..._homeTrim, ...awayPicks];
let strongN = 0;
/* ⚠ 2026-10-05 八修：市场强档直接进清单。
   引擎现在按「押向欧赔概率 pPick」发档（≥0.70→tier1，实测命中 74.8%；≥0.62→tier2，69.5%），
   这层已经用真赛果筛过一遍，再让展示层的 conf/价值分去卡它，只会平白少出手（08-05 当天就卡到只剩 2 条）。
   故 pPick≥0.70 且价值分≥55 的场无条件入清单，只留一层最薄的 vs 兜底。 */
{
  // ⚠ 2026-10-07 收紧：去掉 vs>=55 的松散兜底（比下注级主通道 vs>=60 还松，混进弱场）。
  //   强档只收「tier===1（不含 t2 温吞）且过引擎 t1 门 pPick>=0.80」的真高质场；去重交给 seen。
  const strong = rows.filter(r => (r.tier || 0) === 1 && pPickOf(r) >= pGate1(r));
  const seen = new Set(picks.map(r => r.tid));
  for (const r of strong) if (!seen.has(r.tid)) { picks.push(r); seen.add(r.tid); }
  if (strong.length) console.log('[强档] 过引擎非对称门(主≥' + GATE.T1_H + '/客≥' + GATE.T1_A + ')直接入清单 ' + strong.length + ' 场');
  picks = [...seen].length ? picks : picks;   // 去重已完成
  strongN = strong.length;
}
console.log('[站对面] 主胜过热触发 ' + rows.filter(isHomeHot).length + ' 场 / 客胜过热触发 ' + rows.filter(isAwayHot).length + ' 场（共扫描 ' + rows.length + ' 场）');
console.log('[选场] 主胜下注级 ' + homePicks.length + ' (截尾后 ' + _homeTrim.length + ') / 客胜下注级 ' + awayPicks.length + ' / 市场强档 ' + strongN + ' / 合计 ' + picks.length);

// ★ 平局关注（独立通道，解决"平局一场没推荐"）：
//   引擎综合方向只要有任何胜负信号就锁 W/L，平局仅 tier=2/conf≈36-40，被上面的 tier===1&&conf>=60 全滤掉；
//   且足球平局被市场定价极准、模型几乎从不主动判平（诚实结论）。但庄家视角必须能"看到"平局高危场，
//   故此处不依赖引擎是否判平，而是用「市场平局概率 mk_d」直接扫全池：≥28% 即列入平局关注（参考级，标注"防平"）。
// 平局关注门槛随热度走：主胜过热(站对面)时，平局关注门槛从0.28降到0.25，防平更积极
/* ⚠ 2026-10-05 八修：平局观察门槛 0.25/0.28 → **0.27/0.30**（主胜过热时降到 0.27）。
   依据 live_log 1185 场 draw 已结算（_audit_blocks.cjs）：全样本实际走平率 20.7%，
   draw 通道整体只走平 20.3%(n=1185) —— 与瞎猜同档，**没有 alpha，反而是负贡献**；
   分桶后只有 mk_d≥0.27 才略高于基线（0.25~0.28→23.0%n=318 / 0.28~0.30→24.0%n=200 /
   0.30~0.33→23.5%n=136 / ≥0.33→28.0%n=25），0~0.25 那 505 场只有 15.8%（明显亏）。
   故把低档砍掉，只留 ≥0.27 的场做「防平观察」，且口径明确：**不走命中分母、不下注**。 */
const drawWatchK = r => isHomeHot(r) ? 0.27 : 0.30;
/* ⚠ 十修：去掉 `|| /平局/.test(dir)` —— 引擎判平的场已由 drawPicks 收走，
   这里再收一遍会让「平局关注」把「平局推荐」整段重复列出（旧版 45 场里有 6 场就是这么重复的）。
   现在关注段＝市场平局概率够高、但引擎没判平的场（纯防平用途）。 */
const drawWatch = rows
  .filter(r => (r.mk_d >= drawWatchK(r)) && !/平局/.test(String(r.dir)))
  .sort((x, y) => (y.mk_d - x.mk_d) || (y.conf - x.conf));

// ★★ 平局推荐（一等分节，庄家视角核心需求）：
//   引擎"实际判平"的场次（综合方向/强平局通道给出的 平局·强倾向 / 平局候选·慎防 / 过热慎防）——
//   这些是模型自己的平局结论，必须作为"推荐"单独成节列出，与胜负主推并列，不再被 tier===1 过滤掉。
//   诚实标注：平局整体负EV（实测打出率~30~34%），故标为"参考级推荐"，不虚高评级；强平局(市场头号+平赔<3.0)优先。
//
// 🔴 2026-10-05 十修：必须叠市场平局概率门槛 drawWatchK。
//   依据 3862 场真赛果审计：平局通道整体打出率 20.3% ≈ 全样本基线 20.7%（无 alpha）；
//   且 mk_d<0.25 那 505 场只走平 15.8%（亏钱带），mk_d≥0.25 各档 23~28% 才略高于基线。
//   旧版只按 /平局/.test(dir) 全收，于是 mk_d 仅 9~22% 的场被标成「⭐强平局·并列主推」——
//   用户跟着推就是亏。现改为：引擎判平 **且** mk_d≥门槛 才进「平局推荐」；
//   「平局关注」只收 mk_d≥门槛 但引擎没判平的场（纯防平），不再与推荐段重复。
const drawPicks = rows
  .filter(r => /平局/.test(String(r.dir)) && r.mk_d >= drawWatchK(r))
  .sort((x, y) => (Number(y.strongDraw) - Number(x.strongDraw)) || (y.conf - x.conf) || (y.mk_d - x.mk_d));

// 排序：tier（下注级优先）→ 价值分 → 置信
const byValue = (x, y) => (y.tier - x.tier) || (y.vs - x.vs) || (y.conf - x.conf);
const jcRows = rows.filter(r => r.jc).sort(byValue);           // 竞彩在场次：用户的正业，单独成节全列
// ⚠ 2026-10-07 收紧：第三节只列 tier≥1（有方向质量保障）的场；tier0 温吞场不再混入重点，挪到「观望池」反向参考。
const restRows = rows.filter(r => !r.jc && (r.tier || 0) >= 1).sort(byValue).slice(0, TOP_N);
const picksSet = new Set(picks.map(r => r.tid));

const DIR_CN = { W: '主胜', D: '平局', L: '客胜', H: '主胜', A: '客胜' };
const dirCn = d => DIR_CN[d] || (d || '—');

function fmtScore(s) {
  if (!s) return '—';
  try {
    const top = (s.top || s.list || []).slice(0, 3);
    if (!top.length) return '—';
    return top.map(x => {
      const p = Number(x.p != null ? x.p : x.prob);
      if (!isFinite(p)) return `${x.s || x.score}`;
      return `${x.s || x.score} ${(p <= 1 ? p * 100 : p).toFixed(1)}%`;   // 引擎有的分支给小数、有的给百分数
    }).join('，');
  } catch (e) { return '—'; }
}

/* ★ 三段盘路：把 fused.stages（early/mid/late2h/late1h/late0h）压成「初→中→临」亚盘轨迹
   亚盘 c_hcap：>0 主让 / <0 客让 / 0 平手；临场段再附 1X2 主赔。无该段则显示 —（诚实不全）。 */
function fmtStages(stages, present) {
  if (!stages || !stages.length) {
    if (present && present.length) return '— 暂无盘路(' + present.join('/') + ')';
    return '— 暂无盘口';
  }
  const by = {};
  for (const s of stages) by[s.label] = s;
  const early = by['early'] || null;
  const mid = by['mid'] || null;
  // 兼容两种标签方案：3-stage(early/mid/late) 与 5-stage(early/mid/late2h/late1h/late0h)
  const late = by['late'] || by['late0h'] || by['late1h'] || by['late2h'] || null;
  const hcapStr = s => {
    if (!s || !s.agg || s.agg.c_hcap == null) return '—';
    const h = s.agg.c_hcap;
    if (h > 0) return '主让' + h;
    if (h < 0) return '客让' + (-h);
    return '平手';
  };
  const line1 = '初' + hcapStr(early) + ' → 中' + hcapStr(mid) + ' → 临' + hcapStr(late);
  let line2 = '';
  if (late && late.agg && late.agg.c_h != null && late.agg.c_d != null && late.agg.c_a != null) {
    const a = late.agg;
    line2 = '临1X2 ' + (+a.c_h).toFixed(2) + '/' + (+a.c_d).toFixed(2) + '/' + (+a.c_a).toFixed(2);
  }
  return line2 ? (line1 + '<br>' + line2) : line1;
}

const nowStr = new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(5, 16);
const md = [];
md.push('# 自动分析 · 当日重点场次');
md.push('');
md.push('- 数据更新时间：**' + nowStr + '**（北京时间）');
md.push('- 扫描范围：' + ((Array.isArray(bake.range) && bake.range.length)
  ? (bake.range[0] + ' ~ ' + bake.range[bake.range.length - 1]) : today) + ' 的全部未开赛场次');
md.push('- 有效分析：**' + rows.length + ' 场**（无盘口跳过 ' + skippedNoOdds + ' 场，已开赛跳过 ' + skippedStarted + ' 场）');
md.push('- 其中**竞彩在场** ' + jcRows.length + ' 场；下注级重点（tier1 且达门槛 / 过引擎 t1 门）' + picks.length + ' 场；**平局推荐** ' + drawPicks.length + ' 场（引擎实际判平 **且** 市场平局概率≥' + 30 + '%（主胜过热场降至27%），庄家视角并列主推，标注参考级·不参与命中分母）；**平局关注** ' + drawWatch.length + ' 场（市场平局概率≥' + 30 + '%（主胜过热场降至27%）但引擎未判平，纯防平参考）；**观望池** ' + rows.filter(r => !r.jc && (r.tier || 0) < 1).length + ' 场（tier0 温吞场，不推荐）');
/* 🔴 十修诚实提示：平局通道 1185 场真赛果审计 → 打出率 20.3% ≈ 全样本基线 20.7%，无 alpha；
   mk_d<0.25 那 505 场仅 15.8%（亏钱带）。故「平局推荐」= 引擎判平且市场也支持（双重印证），
   而不是只要引擎说平就推。推荐段为 0 场说明今天没有任何平局场够格——属正常，不是数据缺失。 */
if (!drawPicks.length) md.push('- ⚠ **今日平局推荐为 0 场**：平局通道实测无 alpha（打出率≈全样本基线），只有「引擎判平 **且** 市场平局概率≥' + 30 + '%」双重印证的场才列为推荐；今天没有这种场，故不推荐平局，只看下方防平关注。');
/* 🔴 十修第二轮板块审计（3862 场真赛果）补两块口径，避免看板数字虚高、误把展示当预测：
   ① 大小球一律按**含走水**真实口径统计（走水=本金退还但计未命中）。整数线（2/3/4）走水率 22~25%、
      含走水命中仅 32~43%（line=2 小球 32.5%(n=126) / line=3 43.0%(n=316) / line=4 33.3%(n=54)），
      而非整数线 2.25→51.6% / 2.5→53.9% / 2.75 大球 60.2% / 3.25→52.0%。引擎十修起禁判整数线。
   ② 亚洲盘（让球）：清单只展示盘口、**不给方向建议**。市场去走水赢盘基准 48.8%（n=3623），
      我们 tier≥1 那批 49.0% —— 等同市场，该板块无 alpha，别当独立预测跟。 */
md.push('- ⚠ **口径说明（10-05 第二轮审计 · 3862 场真赛果）**：大小球命中按**含走水**真实口径统计（走水=本金退还但计未命中），整数线（2/3/4）走水率 22~25%、真实命中仅 32~43%，引擎十修起**禁判整数线**，只在中线位非整数线出手；让球（亚洲盘）**整体**确实无 alpha（去走水赢盘基准 48.8%、我们 tier≥1 那批 49.0%），但按盘口拆开后 **|盘口|=0.25 / 1.25 买受让侧是真 alpha**（去走水覆盖 61.9% / n=1072 / train 62.2 / test 60.7 / z=7.79），其余盘口买受让只有 42~47% —— 故让球方向**只在这两格出手**，详见下方第五节。');
md.push('');

function table(list) {
  if (!list.length) { md.push('_本轮无场次。_'); return; }
  md.push('| 竞彩 | 时间 | 联赛 | 对阵 | 倾向 | 置信 | 价值分 | 亚盘 | 三段盘路(初→中→临) | 大小球 | 比分分布(前三) |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of list) {
    const flag = (r.tier === 1 && picksSet.has(r.tid)) ? ' ⭐' : '';
    const ouTxt = (r.line == null) ? '—' : (r.line + (r.ou ? ' ' + r.ou : ''));
    md.push('| ' + (r.jc || '')
      + ' | ' + String(r.day).slice(4) + ' ' + r.time
      + ' | ' + r.league
      + ' | ' + r.home + ' vs ' + r.away
      + ' | **' + dirCn(r.dir) + '**' + flag
      + ' | ' + r.conf.toFixed(0) + '%'
      + ' | ' + r.vs.toFixed(0)
      + ' | ' + (r.hcap == null ? '—' : r.hcap)
      + ' | ' + fmtStages(r.stages, r.present)
      + ' | ' + ouTxt
      + ' | ' + fmtScore(r.score) + ' |');
  }
  md.push('');
}

// 平局推荐专属表：突出 强平局/平局候选 + 市场平局概率 + 热度陷阱
function drawTable(list) {
  if (!list.length) { md.push('_本轮引擎未判出平局方向场次。_'); return; }
  md.push('| 竞彩 | 时间 | 联赛 | 对阵 | 平局结论 | 强平局 | 市场平局概率 | 置信 | 亚盘 | 三段盘路(初→中→临) | 大小球 |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of list) {
    const sd = r.strongDraw ? '⭐强平局' : '';
    const heat = (r.drawHeat === 'OVERHEAT-PPI' || r.drawHeat === 'OVERHEAT-LINE') ? '过热慎防' : (r.drawHeat === 'COLD' ? '偏冷' : '');
    const ouTxt = (r.line == null) ? '—' : (r.line + (r.ou ? ' ' + r.ou : ''));
    md.push('| ' + (r.jc || '')
      + ' | ' + String(r.day).slice(4) + ' ' + r.time
      + ' | ' + r.league
      + ' | ' + r.home + ' vs ' + r.away
      + ' | **' + dirCn(r.dir) + '**'
      + ' | ' + sd
      + ' | **' + (r.mk_d * 100).toFixed(1) + '%**'
      + ' | ' + r.conf.toFixed(0) + '%'
      + ' | ' + (r.hcap == null ? '—' : r.hcap)
      + ' | ' + fmtStages(r.stages, r.present)
      + ' | ' + ouTxt + (heat ? ' ｜' + heat : '') + ' |');
  }
  md.push('');
}

md.push('## 一、平局推荐（引擎实际判平 · 庄家视角并列主推）');
md.push('');
if (!drawPicks.length) {
  md.push('_本轮引擎未判出平局方向场次（即综合方向未给任何平局结论）。_');
} else {
  md.push('> 下列为引擎综合方向 / 强平局通道**实际给出平局结论**的场次，与胜负主推并列作为「平局推荐」。');
  md.push('> 诚实提示：足球平局被市场定价极准，整体为负 EV（实测打出率约 30~34%），故标为「参考级」而非「可下注级」；');
  md.push('> 带「过热慎防」者（平赔急降 / 真实资金过热）属诱平陷阱，慎跟；「⭐强平局」（市场头号 + 平赔<3.0）为相对最易平指示，可重点看。');
  drawTable(drawPicks);
}
md.push('');

md.push('## 二、竞彩在场场次（' + jcRows.length + '）');
md.push('');
if (jcRows.length === 0) {
  // 今日无竞彩在售：诚实说明 + 列出已抓取到的未来竞彩，避免用户误以为数据坏了
  let futureLines = [];
  try {
    const _jc = JSON.parse(require('fs').readFileSync(__dirname + '/jingcai.json', 'utf8'));
    const _rows = _jc.rows || [];
    const _byDay = {};
    for (const x of _rows) { const d = String(x.date || '').replace(/-/g, ''); (_byDay[d] = _byDay[d] || []).push(x); }
    const _days = Object.keys(_byDay).sort();
    const _td = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    for (const d of _days) {
      if (d !== _td) futureLines.push('  - **' + d + '**：' + _byDay[d].map(x => (x.no || '') + ' ' + (x.league || '') + ' ' + (x.home || '') + ' vs ' + (x.away || '')).join('｜'));
    }
  } catch (e) {}
  md.push('> **今日（' + new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 10) + '）无竞彩在售比赛 —— 这是真实赛况，不是数据损坏。**');
  md.push('>');
  md.push('> 你此前看到的「竞彩1场」（女足）是更早时点的竞彩，已随竞彩销售日滚动移出「今日在场」窗口，故本节变 0。');
  md.push('> 底层数据完整 **647 场**、三段盘路 **324 场**，一切正常。已抓取到的未来竞彩如下，到对应日期会自动出现：');
  md.push(futureLines.length ? futureLines.join('\n') : '> （暂无未来竞彩数据）');
} else {
  table(jcRows);
}

md.push('## 三、全池下注级 Top ' + restRows.length + '（仅 tier≥1 · tier0 温吞场见下方「观望池」）');
md.push('');
table(restRows);
md.push('');
// ★ 观望池：tier0 温吞场，引擎未给明确下注级方向、质量无保障。仅作"哪些场不值得跟"的反向参考，不计入重点、不推荐。
{
  const watchRows = rows.filter(r => !r.jc && (r.tier || 0) < 1).sort(byValue).slice(0, 15);
  md.push('### 三·附、观望池（tier0 温吞场 · 无方向质量保障 · 仅供参考，不计入重点 / 不推荐）');
  md.push('');
  if (!watchRows.length) {
    md.push('_本轮无 tier0 温吞场。_');
  } else {
    md.push('> 下列场次引擎未给明确下注级方向（tier0），模型质量无保障；列为「观望」反向参考，**请勿当作推荐跟**。');
    md.push('');
    md.push('| 时间 | 联赛 | 对阵 | 倾向 | 置信 | 价值分 |');
    md.push('|---|---|---|---|---|---|');
    for (const r of watchRows) {
      md.push('| ' + String(r.day).slice(4) + ' ' + r.time
        + ' | ' + r.league
        + ' | ' + r.home + ' vs ' + r.away
        + ' | ' + dirCn(r.dir)
        + ' | ' + r.conf.toFixed(0) + '%'
        + ' | ' + r.vs.toFixed(0) + ' |');
    }
    md.push('');
  }
}

// ★ 平局关注：庄家视角必看。凡市场平局概率≥28% 或引擎已判平局的场次，单列防平，
// 与方向主推并列，不再"平局零推荐"。标注为参考级（平局真实打出率约 28~34%，非下注级）。
md.push('## 四、平局关注（市场平局概率≥30%（主胜过热场降至27%）但引擎未判平，庄家视角防平）');
md.push('');
if (!drawWatch.length) {
  md.push('_本轮无高平局概率场次（市场平局概率普遍 < 28%）。_');
} else {
  const DRAW_SHOW = 30;
  const shown = drawWatch.slice(0, DRAW_SHOW);
  md.push('> 共 ' + drawWatch.length + ' 场市场平局概率≥30%（主胜过热场降至27%）但引擎未判平，以下列出概率最高的 ' + shown.length + ' 场（按平局概率降序）。');
  md.push('');
  md.push('| 竞彩 | 时间 | 联赛 | 对阵 | 市场平局概率 | 引擎倾向 | 置信 | 亚盘 | 三段盘路(初→中→临) | 大小球 |');
  md.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of shown) {
    const ouTxt = (r.line == null) ? '—' : (r.line + (r.ou ? ' ' + r.ou : ''));
    md.push('| ' + (r.jc || '')
      + ' | ' + String(r.day).slice(4) + ' ' + r.time
      + ' | ' + r.league
      + ' | ' + r.home + ' vs ' + r.away
      + ' | **' + (r.mk_d * 100).toFixed(1) + '%**'
      + ' | ' + dirCn(r.dir)
      + ' | ' + r.conf.toFixed(0) + '%'
      + ' | ' + (r.hcap == null ? '—' : r.hcap)
      + ' | ' + fmtStages(r.stages, r.present)
      + ' | ' + ouTxt + ' |');
  }
  md.push('');
  md.push('> 平局概率来自市场赔率隐含（1/平赔 ÷ 返还率）。高平局概率≠必平，仅提示"防平"价值；'
    + '其中平赔急降/真实资金过热者（PPI 平局占比偏高）属诱平陷阱，谨慎跟。');
}

/* ★ 五、让球方向（受让方）—— 十一修新板块。
   背景：上一版审计说「让球板块整体无 alpha（去走水赢盘 48.8% ≈ 市场）」，
        那是整体均值；按盘口拆开后发现 |hcap|=0.25 与 1.25 两格是**真 alpha**（均为"买受让侧"）：
         受让方去走水覆盖 61.9%（n=1072，train 62.2 / test 60.7，二项 z=7.79，按月 61.7/63.1），
         ROI@水位0.90 ≈ +17.6%；其余盘口（0.5/0.75/1/1.75/2）买受让只有 42~47%，属系统性亏钱。
       机制：0.25/1.25 是半档盘，市场把让球方定价偏强，受让侧被低估（favorite-longshot 偏差）。
       口径：走水（本金退还）单独计、不计入覆盖分母；水位按 0.90 保守估 ROI，真水位高低会浮动。 */
{
  const ASIA_PICKED = rows.filter(r => r.asiaDir === '受让方');
  md.push('## 五、让球方向（仅 |盘口|=0.25 / 1.25 买受让侧）');
  md.push('');
  if (!ASIA_PICKED.length) {
    md.push('_本轮没有 |盘口|=0.25 或 1.25 的场次。让球方向只在盘口绝对值为 **0.25 / 1.25** 时出手，'
      + '其余盘口（0.5/0.75/1/1.75/2…）实测买受让只有 42~47%、走水还占 25~31%，一律不给方向，宁缺毋滥。_');
  } else {
    md.push('> 实测（3862 场真赛果逐场判盘）：**盘口绝对值 0.25 / 1.25 时买受让侧**，去走水覆盖 **61.9%**（n=1072，'
      + 'train 62.2 / test 60.7，二项 z=7.79），水位 0.90 下 ROI 约 **+17.6%**；'
      + '对照其余盘口买受让只有 42~47%，故只在这两格出手。走水（本金退还）单独计、不计入覆盖分母。');
    md.push('');
    md.push('| 竞彩 | 时间 | 联赛 | 对阵 | 亚盘盘口 | 让/受 | 受让侧 | 引擎倾向 | 置信 | 大小球 |');
    md.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of ASIA_PICKED.slice(0, 30)) {
      const give = Number(r.hcap) > 0 ? '主队让' : '客队让';
      const recv = Number(r.hcap) > 0 ? r.away : r.home;      // 受让方是谁
      md.push('| ' + (r.jc || '—')
        + ' | ' + String(r.day).slice(4) + ' ' + r.time
        + ' | ' + r.league
        + ' | ' + r.home + ' vs ' + r.away
        + ' | ' + (r.hcap == null ? '—' : r.hcap)
        + ' | ' + give + '（' + Math.abs(Number(r.hcap)).toFixed(2) + '）'
        + ' | **' + recv + '**'
        + ' | ' + dirCn(r.dir)
        + ' | ' + r.conf.toFixed(0) + '%'
        + ' | ' + (r.line == null ? '—' : r.line + (r.ou ? ' ' + r.ou : '')) + ' |');
    }
    md.push('');
    md.push('> ⚠ 受让侧≠稳赢：覆盖 61.9% 是指「赢盘（含不输盘）」的比例，仍会有约 38% 输盘；'
      + '水位多数在 0.85~1.00，ROI 会随实际水位浮动，真水位 0.90 时才是上面的 +17.6%。');
  }
  md.push('');
}

md.push('> ⭐ = 同时满足「下注级 + 置信≥60 + 价值分≥60」。置信与价值分均为引擎原始分（0~100）。');
md.push('> 比分列按约定只给概率分布，不下单点结论。');
md.push('> 三段盘路(初→中→临)：取自赔率历史序列真实还原（初盘=早场放出 / 中盘=中点 / 临盘=序列最晚一条，临场参考），显示亚盘让球轨迹 + 临场1X2；某段缺失显示 —（市场未开盘/数据源未提供，不伪造三段）。');

const outDir = path.join(here, '_picks');
try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
const outFile = path.join(outDir, '今日重点-' + today + '.md');
try { fs.writeFileSync(outFile, md.join('\n'), 'utf-8'); } catch (e) { console.log('写文件失败:', e.message); }

// ===== 实盘落库：结构化 JSON（供样本外对账，区别于 markdown 给人看） =====
// 只落「会下注的」(下注级重点) 与「引擎确判平局」(庄家视角参考) 两类；
// 首次预测即锁存，后续刷新不覆盖方向与置信（避免前视泄漏），仅回写 predDay 与未结算字段。
function scoreTop3(s) {
  if (!s) return [];
  try {
    const top = (s.top || s.list || []).slice(0, 3);
    return top.map(x => {
      const p = Number(x.p != null ? x.p : x.prob);
      return { s: x.s || x.score, p: (isFinite(p) ? (p <= 1 ? +(p * 100).toFixed(1) : +p.toFixed(1)) : null) };
    });
  } catch (e) { return []; }
}
/* 结论口径指纹：任何影响「模型说了什么」的字段变了，指纹就变；
   hs/as/result/hit 是客观真值，不参与指纹。 */
function sigOf(r) {
  return [r.dir, r.conf, r.vs, r.tier, r.hcap, r.line, r.ou]
    .map(x => (x == null ? '' : x)).join('~');
}
function emitLiveLog() {
  const logPath = path.join(here, 'live_log.json');
  let log = { updated: '', picks: {} };
  try { const ex = JSON.parse(fs.readFileSync(logPath, 'utf8')); if (ex && ex.picks) log = ex; } catch (e) {}
  const predDay = today;
  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  const recOf = (r, kind) => ({
    tid: r.tid, matchDay: r.day, predDay,
    time: r.time, league: r.league, home: r.home, away: r.away,
    dir: r.dir, conf: +r.conf.toFixed(1), vs: +r.vs.toFixed(1), tier: r.tier,
    mk_d: r.mk_d, hcap: r.hcap, line: r.line, ou: r.ou,
    jc: r.jc, jcLeague: r.jcLeague, scoreTop3: scoreTop3(r.score),
    p_mkt: (String(r.dir).trim() === 'W' ? r.mk_w : (String(r.dir).trim() === 'L' ? r.mk_a : r.mk_d)),
    // 🔴 结论口径指纹：引擎改了 dir/conf/tier/hcap/line/ou 任一字段，sig 就变。
    //    emitLiveLog 据此把旧记录「重写为当前口径」，避免审计数据跨版本污染
    //    （旧做法「已存在则 continue」曾让 822/2292 = 36% 的 ou 结论停留在旧门时代）。
    sig: sigOf(r),
    // 🔴 引擎版本戳（2026-10-05 加）：sig 只反映「结论长什么样」，两个不同引擎版本可能产出同样的 sig
    //    （例如都推 W/conf75），所以 sig 过滤不彻底。审计「真实命中率」时必须只统计 ev === 当前
    //    ENGINE_V 的样本 —— 否则拿到的是跨版本混合口径的假数（今天实测：tier1 全量 59.0% 里混着
    //    旧版门（0.70/0.65）与新版门（0.80+市场认同门）两类结论，而干净重跑是 97%）。
    //    ⚠ 历史记录不会被回填（emitLiveLog 只遍历当轮池子，已结算的旧场永不进池 → 永不重写），
    //      故旧记录一律标 'legacy'，任何"命中率"结论都必须显式排除它们。
    ev: (typeof E !== 'undefined' && E.ENGINE_V) ? E.ENGINE_V : null,
    kind, settled: false, hs: null, as: null, result: null, hit: null
  });
  const src = [].concat(
    picks.map(r => ({ r, kind: 'bet' })),
    drawPicks.map(r => ({ r, kind: 'draw' }))
  );
  let added = 0, rebaked = 0;
  for (const { r, kind } of src) {
    const key = r.tid + '|' + r.day;
    const old = log.picks[key];
    if (old) {
      if (!old.settled) { old.predDay = predDay; old.sig = sigOf(r); continue; }
      // 已结算：引擎口径没变 → 原样保留（保留首次预测）
      if (old.sig === sigOf(r)) continue;
      // 引擎口径变了 → 重写结论为当前口径；真值 hs/as/result/hit 由 settle_log 维护，不覆盖
      log.picks[key] = Object.assign(recOf(r, kind),
        { hs: old.hs, as: old.as, result: old.result, hit: old.hit, settled: old.settled });
      rebaked++;
      continue;
    }
    log.picks[key] = recOf(r, kind);
    added++;
  }
  log.updated = stamp;
  try {
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
    console.log('live_log: 落库 ' + Object.keys(log.picks).length + ' 条（本轮回写 ' + src.length + '，新增 ' + added + '，口径重写 ' + rebaked + '）');
  } catch (e) { console.log('live_log 写失败:', e.message); }
}
emitLiveLog();

console.log('auto_pick: 扫描 ' + scanned + ' 场 → 有效分析 ' + rows.length
  + '，其中竞彩在场 ' + jcRows.length + '、重点 ' + picks.length + '、平局推荐 ' + drawPicks.length + '、平局关注 ' + drawWatch.length + '；已写入 ' + path.basename(outFile));
if (jcRows.length) {
  console.log('竞彩: ' + jcRows.slice(0, 8).map(r => r.jc + ' ' + r.home + 'vs' + r.away + ' ' + dirCn(r.dir) + ' conf' + r.conf.toFixed(0)).join(' | '));
}
if (picks.length) {
  console.log('重点: ' + picks.slice(0, 6).map(r => r.home + 'vs' + r.away + ' ' + dirCn(r.dir) + ' vs' + r.vs.toFixed(0)).join(' | '));
}
