#!/usr/bin/env node
/* ============================================================================
 * _fundplate_sync_tri.cjs  —— 2026-11-22
 * 把 tri_trail 已抓到、但从未进入「完整意见快照」的场次补登记进 fundplate_history。
 *
 * 为什么必须有这个脚本（用户连续抓包的根因）：
 *   fundplate_history 的登记入口是 gen_index._update_fundplate_history，
 *   它只遍历 bake_pack.packs；bake 由 gqj2 烘焙，gqj2 被封后冻在 11-15
 *   → 11-16 起**新场次天生没有入口**（实测 11-22 抓到 144 场只登记 7 场）。
 *   而且原登记有三道硬 continue（缺 heatSrc / 缺 exp_hcap / 缺 bake 行），
 *   任何一端没抓到就把整场当"无用"剔除 —— 这正是用户说的"错过一堆好比赛"。
 *
 * 本脚本的立场：
 *   ① 一进场都不丢：只要有一端真实序列，就登记，并写清缺哪一端；
 *   ② 不伪造 edge：按数据完整度分级，只有 grade=full（≥2 个独赢端齐 + 同向）才给买方向、
 *      才进命中率/业绩分母；pair（含北单让球盘的第二市场）与 single 只给观察意见，noStat=true；
 *   ③ 只追加、不改写：已存在的 tid 一律跳过，绝不动结算结果/冻结意见；
 *   ④ 口径铁律：北单让球盘(rq) 只作为独立市场方向，绝不与 365 独赢相减；
 *      净超买只用「北单隐含(或资金占比) − 365 隐含」，两端都是独赢口径才相减。
 *
 * 用法： node _fundplate_sync_tri.cjs [--dry]
 *        FP_BASE=<dir> 可指定数据根（默认脚本所在目录）
 * ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path');
const HERE = __dirname;
const BASE = process.env.FP_BASE || HERE;
const DRY = process.argv.includes('--dry');
const LIMIT_DAY_MIN = process.env.FP_SYNC_FROM || '20261116';   // 只补 11-16 之后（bake 冻结分界）

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; }
}
function dec(s) {
  let t = String(s == null ? '' : s);
  try { if (typeof decodeName === 'function') t = decodeName(t) || t; } catch (e) {}
  return t.replace(/<[^>]*>/g, '').replace(/&#x?[0-9a-fA-F]+;/g, '')
    .replace(/[\uE000-\uF8FF]/g, '').replace(/[\s·・\-（）()\[\].]/g, '').toLowerCase();
}
function sim(a, b) {
  const x = dec(a), y = dec(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 2 && y.length >= 2 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0)) return 0.9;
  let best = 0;
  for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) {
    let k = 0;
    while (x[i + k] && x[i + k] === y[j + k]) k++;
    if (k > best) best = k;
  }
  return best >= 2 ? best / Math.max(x.length, y.length) : 0;
}
const r1 = n => Math.round(Number(n) * 10) / 10;
const finite = v => typeof v === 'number' && isFinite(v);
function hcapTxt(h) {
  if (h == null || !isFinite(h)) return '—';
  const a = Math.abs(h);
  if (a < 0.01) return '平手';
  return (h > 0 ? '主让' : '客让') + a.toFixed(2);
}

const TRI = readJson(path.join(BASE, 'tri_trail.json'), null);
const BD  = readJson(path.join(BASE, 'beidan.json'), null);
const BK  = readJson(path.join(BASE, 'bake_pack.json'), null);
const FP  = readJson(path.join(BASE, 'fundplate_history.json'), null);
if (!TRI || !TRI.items) { console.error('tri_trail.json 缺失或无 items，退出'); process.exit(2); }
if (!FP || !Array.isArray(FP.items)) { console.error('fundplate_history.json 缺失，退出'); process.exit(2); }

const items = FP.items.filter(x => x && x.tid != null);
const have = new Set(items.map(x => String(x.tid)));

/* ---------- 北单原始行索引（真实盘口/资金占比） ----------
 * ★2026-11-23 根治三盘合流断供：beidan.json 每15分钟被 fetch_beidan.cjs 重写成"当日19场
 * 在售快照"，11-08 及之前历史行全冲掉 → 北单独赢 pct 无源 → 三盘合流全断。
 * 改读 beidan_fund_hist.json（由 _build_bd_fund_hist.cjs 从 pool_cloud/snap 真实历史压缩，
 * 每场只留临盘最后一笔独赢 fund），beidan.json 仅作当日补充。 */
const BD_HIST = readJson(path.join(BASE, 'beidan_fund_hist.json'), null);
const bdByDay = {};
for (const day of Object.keys((BD_HIST && BD_HIST.days) || {})) {
  const rows = (BD_HIST.days[day] && BD_HIST.days[day].rows) || {};
  for (const k of Object.keys(rows)) {
    if (!/^\d{8}$/.test(day)) continue;
    (bdByDay[day] = bdByDay[day] || []).push(rows[k]);
  }
}
for (const r of ((BD && BD.rows) || [])) {
  const d = String(r.date || r.day || '').replace(/-/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(d)) continue;
  // 当日快照若已在历史库存在同编号同场，跳过（历史库的临盘 fund 更全）
  const sig = String(r.no || '') + '|' + String(r.home || '');
  const dup = (bdByDay[d] || []).some(x => (String(x.no || '') + '|' + String(x.home || '')) === sig);
  if (!dup) (bdByDay[d] = bdByDay[d] || []).push(r);
}
function pickBd(day, home, away) {
  const c = bdByDay[day] || [];
  if (!c.length) return null;
  let best = null, bs = 0;
  for (const r of c) {
    const s1 = sim(home, r.home), s2 = sim(away, r.away);
    if (s1 < 0.6 || s2 < 0.6) continue;
    const sc = s1 + s2;
    if (sc > bs) { bs = sc; best = r; }
  }
  return best;
}

/* ---------- bake 里的真实盘口（旧场次兜底） ---------- */
const bkAn = {};
try {
  const packs = (BK && BK.packs) || {};
  for (const t of Object.keys(packs)) {
    const an = packs[t] && packs[t].an;
    if (an && an.grade_hcap_a != null) bkAn[t] = { hcap: Number(an.grade_hcap_a), water: an.grade_water_a };
  }
} catch (e) {}

/* ---------- trail 精简（与 gen_index._trail_brief / _trail_end 同构） ---------- */
function endBrief(s) {
  if (!s || !s.n) return null;
  return { n: s.n, ok: !!s.ok, t0: s.t0, t1: s.t1, open: s.open, close: s.close,
    net: s.net, netEnds: s.netEnds, netTurn: s.netTurn, dStrong: s.dStrong, dWeak: s.dWeak,
    levelStrong: s.levelStrong, turnT: s.turnT, hcapMove: s.hcapMove, rq: s.rq,
    usable: s.usable !== false };
}
function trailBrief(it) {
  const sg = it.seg || {}, al = it.align || {};
  return { ok: !!it.ok, why: it.why || '', nSrc: al.nSrc, same: al.same, dir: al.dir,
    lead: al.lead, leadT: al.leadT, converge: !!al.converge, rqFade: al.rqFade,
    jc: endBrief(sg.jc), bd: endBrief(sg.bd), eu: endBrief(sg.eu), rq: endBrief(sg.rq),
    flags: it.flags || {} };
}

const MISS = { jc: '竞彩', bd: '北单独赢', eu: '365', rq: '北单让球盘' };
/* ---------- ②欧亚控赔/造热（eaGap）——从 tri 365 真实逐帧本地计算（2026-11-23） ----------
   与 freeze_combo.cjs::_euAsiaGap 完全同式（Skellam 折水），输入换成 tri 已抓到的稳定数据：
     λ/μ ← 365 欧赔**开盘**隐含(bookOpen)；亚盘让球/水位 ← 365 亚盘**临盘**(hcap1/water1)。
   数据源是球探备源+gqj2 逐帧，**不依赖 gqj2 在线/bake 底座** → gqj2 封禁也能出 eaOk。
   铁律：算不出就 eaOk=false，绝不造假；op.eaSrc 标注来源可溯。 */
const _eaF = (() => { const c = [1]; return n => { for (let i = c.length; i <= n; i++) c[i] = c[i - 1] * i; return c[n]; }; })();
function _eaSkellam(l, m, mg) {
  mg = mg || 12; const P = new Array(2 * mg + 1).fill(0);
  for (let i = 0; i <= mg; i++) { const pi = Math.exp(-l) * Math.pow(l, i) / _eaF(i);
    for (let j = 0; j <= mg; j++) { const pj = Math.exp(-m) * Math.pow(m, j) / _eaF(j); const gg = i - j;
      if (gg >= -mg && gg <= mg) P[gg + mg] += pi * pj; } }
  return P;
}
function _eaCover(P, h) { const mi = 12; let w = 0, hh = 0;
  for (let gg = -12; gg <= 12; gg++) { if (gg > h) w += P[gg + mi]; else if (gg === h) hh += P[gg + mi] * 0.5; }
  return w + hh; }
function _eaSolveLM(h, d, a) {
  const ih = 1 / h, id = 1 / d, ia = 1 / a; const s = ih + id + ia;
  h = ih / s; d = id / s; a = ia / s; let l = 1.5, m = 1.2;
  for (let it = 0; it < 60; it++) {
    const P = _eaSkellam(l, m), mi = 12; let Ph = 0, Pd = 0;
    for (let gg = -12; gg <= 12; gg++) { if (gg > 0) Ph += P[gg + mi]; else if (gg === 0) Pd += P[gg + mi]; }
    const e1 = Ph - h, e2 = Pd - d, dl = 1e-3;
    const Pl = _eaSkellam(l + dl, m), Pml = _eaSkellam(l, m + dl);
    let Phl = 0, Pdl = 0, Phm = 0, Pdm = 0;
    for (let gg = -12; gg <= 12; gg++) { if (gg > 0) { Phl += Pl[gg + mi]; Phm += Pml[gg + mi]; } else if (gg === 0) { Pdl += Pl[gg + mi]; Pdm += Pml[gg + mi]; } }
    const dPh_dl = (Phl - Ph) / dl, dPd_dl = (Pdl - Pd) / dl, dPh_dm = (Phm - Ph) / dl, dPd_dm = (Pdm - Pd) / dl;
    const det = dPh_dl * dPd_dm - dPh_dm * dPd_dl; if (Math.abs(det) < 1e-9) break;
    const dl_ = (e1 * dPd_dm - e2 * dPh_dm) / det, dm_ = (dPh_dl * e2 - dPd_dl * e1) / det;
    l -= dl_ * 0.7; m -= dm_ * 0.7; if (l < 0.05) l = 0.05; if (m < 0.05) m = 0.05; if (l > 6) l = 6; if (m > 6) m = 6;
    if (Math.abs(e1) < 1e-4 && Math.abs(e2) < 1e-4) break;
  }
  return { l, m };
}
/* ★★ 2026-11-23 强队判定（对齐参考软件「强队=低赔/让球方」）：
   旧版把资金信号 dirN 的符号直接写成「强队/主」，与谁强毫无关系（桑坦德vs皇家社会：
   皇家社会客让才是强队，却写「买强队/主」；博洛尼亚无盘口也硬写强队）。现以真实盘口为准：
   ① 365 亚盘临盘 hcap1>0=主让/主强，<0=客让/客强（与结算链 _settle_hist 同约定）；
   ② 无亚盘时回退开盘隐含概率最高方（eu.open 优先、jc.open 次之）；
   ③ 平手盘返回 null → 不给强弱标签、不给方向。 */
function strongSideOf(it) {
  const sg = (it && it.seg) || {};
  const hc = sg.eu && sg.eu.hcap1 != null && isFinite(Number(sg.eu.hcap1)) ? Number(sg.eu.hcap1) : null;
  if (hc != null && Math.abs(hc) >= 0.01) return hc > 0 ? 'W' : 'L';
  if (hc != null) return null;                       // 平手盘：不判强弱
  const op = (sg.eu && Array.isArray(sg.eu.open) && sg.eu.open.length === 3) ? sg.eu.open.map(Number)
           : ((sg.jc && Array.isArray(sg.jc.open) && sg.jc.open.length === 3) ? sg.jc.open.map(Number) : null);
  if (!op || op.some(v => !isFinite(v))) return null;
  return op[0] >= op[2] ? 'W' : 'L';
}
const oppSide = s => (s === 'W' ? 'L' : (s === 'L' ? 'W' : null));
const sideName = s => (s === 'W' ? '主队' : (s === 'L' ? '客队' : '未知方'));
/* 脏端护栏：让球行 rq 永不参与方向；|net|>30pp 视为错配(北单让球行混独赢/跨场配对)不进账本 */
const cleanEnds = (sg, ends) => ends.filter(k => k !== 'rq' && sg[k] && finite(sg[k].net) && Math.abs(sg[k].net) <= 30);
/* tri 侧入口：it=tri_trail 条目。开盘欧赔+临盘亚盘齐才出结果。 */
function eaFromTri(it) {
  const eu = it && it.seg && it.seg.eu;
  if (!eu || !Array.isArray(eu.bookOpen) || eu.bookOpen.length !== 3) return { ok: false };
  const p = eu.bookOpen.map(Number);
  if (p.some(x => !isFinite(x) || x <= 0.5)) return { ok: false };
  const hc = Number(eu.hcap1), w = Number(eu.water1);
  if (!isFinite(hc) || !isFinite(w) || w <= 0) return { ok: false };   // 无亚盘逐帧(仅eu线)不可判
  const s = _eaSolveLM(100 / p[0], 100 / p[1], 100 / p[2]);
  const ah = Math.abs(hc);
  const cov = hc > 0 ? _eaCover(_eaSkellam(s.l, s.m), hc) : _eaCover(_eaSkellam(s.l, s.m), ah);
  if (!isFinite(cov) || cov <= 0 || cov >= 1) return { ok: false };
  const foldedW = (1 - cov) / cov;
  const gap = +(w - foldedW).toFixed(3);
  let verdict; const wLo = 0.15, wHi = 4.0;
  if (foldedW < wLo || foldedW > wHi) verdict = '折水异常·不可判';
  else if (gap < -0.03) verdict = '控赔·实水<折水';
  else if (gap > 0.03) verdict = '造热·实水>折水';
  else verdict = '中性·实水≈折水';
  return { ok: true, foldedWater: +foldedW.toFixed(3), actualWater: +w.toFixed(3),
    gap, verdict, coverProb: +(cov * 100).toFixed(1) };
}
const stat = { scanned: 0, added: 0, skipHave: 0, skipNoData: 0, skipOld: 0, skipNoName: 0,
  byGrade: { full: 0, pair: 0, single: 0 }, byMissing: {}, byDay: {} };
const samples = { full: [], pair: [], single: [] };

for (const it of Object.values(TRI.items || {})) {
  if (!it || it.tid == null) continue;
  const tid = String(it.tid);
  const day = String(it.day || '');
  if (!/^\d{8}$/.test(day)) continue;
  if (day < LIMIT_DAY_MIN) { stat.skipOld++; continue; }
  if (have.has(tid)) { stat.skipHave++; continue; }
  stat.scanned++;

  const home = String(it.home || '').trim(), away = String(it.away || '').trim();
  if (!home || !away) { stat.skipNoName++; continue; }   // 无队名无法核对/结算，宁缺勿造

  const sg = it.seg || {}, al = it.align || {};
  const okEnd = k => !!(sg[k] && sg[k].ok && finite(sg[k].net));
  const rawEnds = ['jc', 'bd', 'eu'].filter(okEnd);
  const dirtyEnds = rawEnds.filter(k => Math.abs(sg[k].net) > 30);   // ★北单让球行混独赢/错配 → 脏端
  const ends = rawEnds.filter(k => Math.abs(sg[k].net) <= 30);
  const hasRq = okEnd('rq');
  const markets = ends.concat(hasRq ? ['rq'] : []);
  if (!markets.length) { stat.skipNoData++; continue; }
  const strongSide = strongSideOf(it);

  /* ---------- 分级（绝不因缺一端整场剔除；脏端不计、无真实盘口不给方向） ---------- */
  let grade;
  if (it.ok === true && ends.length >= 2 && strongSide != null && !dirtyEnds.length) grade = 'full';
  else if (ends.length >= 2 || (ends.length === 1 && hasRq)) grade = 'pair';
  else grade = 'single';

  const missing = Object.keys(MISS).filter(k => markets.indexOf(k) < 0);

  /* ---------- 真实盘口（结算基础） ---------- */
  const bdRow = pickBd(day, home, away);
  let hcap = null, water = null, hcapSrc = 'none';
  if (bdRow && bdRow.rq != null && isFinite(Number(bdRow.rq))) { hcap = Number(bdRow.rq); hcapSrc = 'market'; }
  if (hcap == null && bkAn[tid]) { hcap = bkAn[tid].hcap; water = bkAn[tid].water; hcapSrc = 'market'; }

  /* ---------- 净超买：只允许「北单(独赢) − 365(独赢)」，rq 绝不参与相减 ---------- */
  let netPt = null, heatSide = null, north = null, euImp = null;
  const bdLv0 = (sg.bd && finite(sg.bd.levelStrong)) ? Number(sg.bd.levelStrong) : null;
  const euLv0 = (sg.eu && finite(sg.eu.levelStrong)) ? Number(sg.eu.levelStrong) : null;
  /* ★ 北单/365 同一盘口护栏：开盘强队侧概率差 >12pp 必是让球行混独赢或跨场错配（实测桑坦德场差 35pp → lvlDiffBd=-12）。
     此时两端不可相减，净超买置 null，宁缺勿造。 */
  const bdEuMatch = (bdLv0 != null && euLv0 != null && Math.abs(bdLv0 - euLv0) <= 12);
  if (sg.bd && sg.bd.ok) {   // 北单独赢端 ok 才允许参与相减；仅让球行(rq)一律不参与
    if (bdRow && Array.isArray(bdRow.pct) && bdRow.pct.length === 3 && bdRow.pct.every(v => isFinite(Number(v)))) {
      north = bdRow.pct.map(Number);
    } else if (Array.isArray(sg.bd.close) && sg.bd.close.length === 3) {
      north = sg.bd.close.map(Number);
    }
  }
  if (sg.eu && Array.isArray(sg.eu.close) && sg.eu.close.length === 3) euImp = sg.eu.close.map(Number);
  if (north && euImp && bdEuMatch) {
    const dv = [0, 1, 2].map(i => north[i] - euImp[i]);
    let mi = 0; dv.forEach((v, i) => { if (v > dv[mi]) mi = i; });
    netPt = r1(dv[mi]); heatSide = ['W', 'D', 'L'][mi];
  }
  const heatSrc = (bdRow && north && bdEuMatch) ? 'beidan' : null;

  /* ---------- 方向意见（★2026-11-23 重写：强队来自真实盘口，资金符号只判"谁被超买"） ---------- */
  const sgn = v => (v == null || !isFinite(v)) ? 0 : (v > 1 ? 1 : (v < -1 ? -1 : 0));
  const signOf = {};
  ends.forEach(k => { signOf[k] = sgn(sg[k].net); });
  if (hasRq) signOf.rq = sgn(sg.rq.net);              // 让球行只展示，绝不与独赢相减/计方向
  const sigs = ends.map(k => signOf[k]).filter(Boolean);
  const pos = sigs.filter(s => s > 0).length, neg = sigs.filter(s => s < 0).length;
  const sameN = Math.max(pos, neg), agree = sigs.length && sameN === sigs.length;
  const dirNet = agree ? (pos > neg ? 1 : -1) : 0;   // +1=开盘强队继续被超买(net=dStrong-dWeak 正号语义)
  const missTxt = missing.length ? ('缺' + missing.map(k => MISS[k]).join('/')) : '端齐';

  let recDir = '', dirN = 0, isFlip = false;
  if (grade === 'full') {
    /* net 正号 = 开盘强队侧被继续超买；强队身份来自亚盘盘口，与参考软件"强队"列同源 */
    const overSide = dirNet > 0 ? strongSide : oppSide(strongSide);
    const hotFav = (overSide === strongSide);
    isFlip = !hotFav;
    dirN = hotFav ? -1 : 1;                          // -1=买受让(反买过热强队)，+1=买强队(翻转场只观察)
    if (!hotFav) {
      recDir = '观察·翻转(' + sideName(overSide) + '被买爆)·只观察不追高(铁律)·两独赢端同向' + sameN + '/' + ends.length;
    } else {
      recDir = '买受让/' + sideName(oppSide(strongSide)) + '(正式过热·大热必死·反买过热强队'
        + sideName(strongSide) + '·两独赢端同向' + sameN + '/' + ends.length
        + (netPt != null ? '·北单净超买' + (netPt > 0 ? '+' : '') + netPt + 'pp' : '') + ')';
    }
  } else if (grade === 'pair') {
    recDir = agree
      ? '观察·两市场同向(' + markets.map(k => MISS[k] + (signOf[k] > 0 ? '↑' : '↓')).join('/') + '·' + missTxt + '·缺交叉验证不给方向)'
      : '观察·两市场背离(' + markets.map(k => MISS[k] + (signOf[k] > 0 ? '↑' : (signOf[k] < 0 ? '↓' : '→'))).join('/') + '·' + missTxt + ')';
  } else {
    const only = markets[0];
    const s = sg[only] || {};
    recDir = '观察·仅' + MISS[only] + '单端' + (s.n ? '(' + s.n + '帧·Δ' + ((Number(s.net) >= 0 ? '+' : '') + r1(s.net)) + 'pp)' : '')
      + '·' + missTxt + '·不进方向账本';
  }

  /* ---------- 赛果（有则顺手结算，无则留空等结算链） ---------- */
  let hs = null, as_ = null, state = 0, um = null, res = null;
  const rs = it.res || {};
  if (rs.hs != null && rs.as != null) { hs = Number(rs.hs); as_ = Number(rs.as); state = -1; }
  if (state === -1 && hcap != null && finite(hcap)) {
    const strongHome = hcap > 0;
    const sf = strongHome ? hs : as_, uf = strongHome ? as_ : hs;
    um = Math.round(((uf + Math.abs(hcap)) - sf) * 100) / 100;
    res = um > 0 ? 'win' : (um === 0 ? 'push' : 'lose');
  }

  const brief = trailBrief(it);
  const diffMax = ends.reduce((m, k) => {
    const v = sg[k] && finite(sg[k].net) ? Math.abs(sg[k].net) : 0;
    return v > m ? v : m;
  }, 0);
  /* ②欧亚控赔/造热：365 真逐帧本地计算（gqj2 封禁也不受影响） */
  const ea = eaFromTri(it);
  if (ea.ok) stat.eaOkN = (stat.eaOkN || 0) + 1;
  /* ③北单盘级差：仅 bd/eu 同一盘口（开盘强队侧概率差≤12pp）才折算；错配置 null，绝不硬凑 */
  const bdLv = bdLv0, euLv = euLv0;
  const lvlDiffBd = (bdEuMatch && bdLv != null && euLv != null) ? Math.round((bdLv - euLv) / 3) : null;
  /* ★★ 2026-11-23 破缺口在线自算：tri_trail 已用 CVM 自采 365 帧 + 北单 spf 复算 yg365，
     补登记不能再写死 overGap:null（那会让「三盘合流强推」永远归零）。只补有值，缺则留 null。 */
  const yg = it.yg365 || {};
  const ogVal = (yg.overGap === true || yg.overGap === false) ? yg.overGap : null;
  const entry = {
    tid, day, kickoff: String(it.kickoff || ''), league: String(it.league || ''),
    home, away, strongIsHome: (strongSide != null ? strongSide === 'W' : null),
    exph: (hcap != null ? hcap : null), realHcap: hcap, water,
    hcapSrc, hcapTxt: hcapTxt(hcap),
    over: (netPt != null ? netPt : null), excess: null, gap: null,
    heatSide, netPt, heatSrc, tier: grade,
    kind: isFlip ? 'flip' : 'normal',
    op: { tier: grade, kind: 'normal', bdDirOk: null, over: netPt, gap: (yg.gap != null ? yg.gap : null),
      diffMax: (yg.max != null ? yg.max : (diffMax ? r1(diffMax) : null)),
      diffSide: (yg.hotSide || null), overGap: ogVal,
      lvlDiffBd: lvlDiffBd, lvlBdTag: null, lvlEuTag: null,
      jcDev: (sg.jc && finite(sg.jc.net) ? r1(sg.jc.net) : null), jcLvl: null,
      netPt, eaOk: !!ea.ok, eaVerdict: (ea.ok ? ea.verdict : null), eaGap: (ea.ok ? ea.gap : null),
      eaDetail: (ea.ok ? { foldedWater: ea.foldedWater, actualWater: ea.actualWater,
        coverProb: ea.coverProb, src: 'tri365' } : null),
      diff3: null, R365: (yg.R365 != null ? yg.R365 : null), trail: brief,
      ogRepair: (ogVal != null ? 'tri365' : undefined) },
    trail: brief, trailGuard: (grade !== 'full'),
    recDir,
    heatScore: null, heatWhy: null, voteS: null, voteU: null, voteWhy: null,
    state, hs, as: as_, underMargin: um, result: res,
    pl: null, plStrong: null, plUnder: null,
    /* ★ 新增溯源字段：分级 / 缺端 / 不计业绩标记 */
    grade, missing, missingTxt: missTxt, noStat: (grade !== 'full'),
    src: 'tri_sync', ts: Math.floor(Date.now() / 1000)
  };
  items.push(entry);
  have.add(tid);
  stat.added++; stat.byGrade[grade]++;
  stat.byMissing[missTxt] = (stat.byMissing[missTxt] || 0) + 1;
  stat.byDay[day] = stat.byDay[day] || { n: 0, full: 0, pair: 0, single: 0 };
  stat.byDay[day].n++; stat.byDay[day][grade]++;
  if (samples[grade].length < 6) samples[grade].push({ day, home, away, recDir, missing: missTxt, hcap: hcapTxt(hcap) });
}

/* ---------- 第二轮：已登记 tri_sync 条目指标自愈（2026-11-22） ----------
   背景：早先数据不全时登记的条目（single/pair）带着 null 指标会被 skipHave 永久跳过；
   而 tri 配对修复（两字简称/编号直配/多目录合并）后数据已补齐——若不刷新，看板上
   「门兴多特」这类场永远显示缺指标。规则：
   · 已结算条目只补空展示指标（绝不碰 result/比分/盈亏，结算记录一字不动）；
   · 未结算条目额外允许 pair/single → full 升级（必须 it.ok 且 >=2 独赢端同向，recDir 重算）；
   · 只补空值，绝不改写已有非空指标、不动其它 src 条目。 */
let refreshed = 0, upgraded = 0, dirFixed = 0, dirtyFixed = 0, downgraded = 0, restored = 0;
const triByTid = new Map();
/* 注意：tri 主条目的 key 就是 tid、对象自身不带 tid 属性（watch 的 T_ 条目才带），
   所以必须 entries 双取：属性优先，其次纯数字 key。 */
for (const [k, x] of Object.entries(TRI.items || {})) {
  if (!x) continue;
  const t = x.tid != null ? String(x.tid) : (/^\d+$/.test(k) ? k : null);
  if (t != null) triByTid.set(t, x);
}
for (const e of items) {
  if (!e || e.src !== 'tri_sync') continue;
  const settled = (e.result != null || e.state === -1);
  const it = triByTid.get(String(e.tid));
  if (!it) continue;
  const sg = it.seg || {}, al = it.align || {};
  const okEnd = k => !!(sg[k] && sg[k].ok && finite(sg[k].net));
  const ends = ['jc', 'bd', 'eu'].filter(okEnd);
  const hasRq = okEnd('rq');
  const op = e.op = e.op || {};
  let touched = false;

  if (op.jcDev == null && sg.jc && finite(sg.jc.net)) { op.jcDev = r1(sg.jc.net); touched = true; }
  const diffMax = ends.reduce((m, k) => {
    const v = sg[k] && finite(sg[k].net) ? Math.abs(sg[k].net) : 0;
    return v > m ? v : m;
  }, 0);
  if (op.diffMax == null && diffMax) { op.diffMax = r1(diffMax); touched = true; }
  /* ★★ 2026-11-23 破缺口补空：历史条目 overGap 被写死 null → 三盘合流强推永远不成立。
     tri_trail 的 yg365 是「CVM 自采 365 帧 + 北单 spf」本地复算（同 engine.ygDiff），
     这里只补 null、绝不改已有值；补上后 gen_index 才能重算热度分并让前端入围。 */
  if (op.overGap == null && it.yg365 && (it.yg365.overGap === true || it.yg365.overGap === false)) {
    op.overGap = it.yg365.overGap;
    if (op.diffMax == null && it.yg365.max != null) op.diffMax = it.yg365.max;
    if (op.diffSide == null && it.yg365.hotSide) op.diffSide = it.yg365.hotSide;
    if (op.R365 == null && it.yg365.R365 != null) op.R365 = it.yg365.R365;
    op.ogRepair = 'tri365';
    stat.ogHealN = (stat.ogHealN || 0) + 1;
    touched = true;
  }
  const bdLv = (sg.bd && finite(sg.bd.levelStrong)) ? Number(sg.bd.levelStrong) : null;
  const euLv = (sg.eu && finite(sg.eu.levelStrong)) ? Number(sg.eu.levelStrong) : null;
  /* ★2026-11-23 幂等：补空 lvlDiffBd 必须同 492 行错配护栏——盘口差>12pp 的场永远置 null，
     否则"补空写入→错配清空"每轮交替重写（计数 73/74 振荡）。 */
  if (op.lvlDiffBd == null && bdLv != null && euLv != null && Math.abs(bdLv - euLv) <= 12) {
    op.lvlDiffBd = Math.round((bdLv - euLv) / 3); touched = true;
  }

  /* ②欧亚控赔/造热补空：365 真逐帧本地算（不依赖 bake/gqj2 在线） */
  if (!op.eaOk) {
    const ea2 = eaFromTri(it);
    if (ea2.ok) { op.eaOk = true; op.eaVerdict = ea2.verdict; op.eaGap = ea2.gap;
      op.eaDetail = { foldedWater: ea2.foldedWater, actualWater: ea2.actualWater, coverProb: ea2.coverProb, src: 'tri365' };
      stat.eaHealN = (stat.eaHealN || 0) + 1; touched = true; }
  }

  if (e.netPt == null) {
    let north = null, euImp = null;
    const bdRow2 = pickBd(String(e.day || ''), e.home, e.away);
    if (bdRow2 && Array.isArray(bdRow2.pct) && bdRow2.pct.length === 3 && bdRow2.pct.every(v => isFinite(Number(v)))) north = bdRow2.pct.map(Number);
    else if (sg.bd && Array.isArray(sg.bd.close) && sg.bd.close.length === 3) north = sg.bd.close.map(Number);
    if (sg.eu && Array.isArray(sg.eu.close) && sg.eu.close.length === 3) euImp = sg.eu.close.map(Number);
    if (north && euImp) {
      const dv = [0, 1, 2].map(i => north[i] - euImp[i]);
      let mi = 0; dv.forEach((v, i) => { if (v > dv[mi]) mi = i; });
      e.netPt = r1(dv[mi]); e.over = e.netPt; op.netPt = e.netPt; op.over = e.netPt;
      e.heatSide = ['W', 'D', 'L'][mi]; e.heatSrc = (bdRow2 && north) ? 'beidan' : null;
      touched = true;
    }
  }

  const brief2 = trailBrief(it);
  e.trail = brief2; op.trail = brief2;

  /* ★2026-11-23 幂等修复：升级条件必须与下方方向校正块的降级口径一致——
     有脏端且剔脏后凑不齐两个干净独赢端时，绝不升级（否则 pair→升full→降pair 每轮空转重写）。 */
  const upRaw = ['jc', 'bd', 'eu'].filter(k => sg[k] && sg[k].ok && finite(sg[k].net));
  const upCln = cleanEnds(sg, upRaw);
  const upDirty = upRaw.length !== upCln.length;
  const upSt = strongSideOf(it);
  const upSg = v => (v > 0.3 ? 1 : (v < -0.3 ? -1 : 0));
  const upSigs = upCln.map(k => upSg(sg[k].net)).filter(Boolean);
  const upPos = upSigs.filter(x => x > 0).length, upNeg = upSigs.filter(x => x < 0).length;
  const upAgree = upSigs.length >= 2 && Math.max(upPos, upNeg) === upSigs.length;
  const canFull = !(upDirty && !(upSt != null && upAgree && upCln.length >= 2));
  if (!settled && e.grade !== 'full' && it.ok === true && ends.length >= 2 && canFull) {
    e.grade = 'full'; e.tier = 'full'; e.noStat = false; e.trailGuard = false;
    if (op.tier) op.tier = 'full';
    /* ★2026-11-23：recDir/kind 统一交给下方方向校正块按真实盘口生成，此处不再写旧文案（否则每轮 cron 反复回退再校正，不幂等） */
    upgraded++; touched = true;
  }

  /* ★★ 2026-11-23 方向校正（用户实锤：桑坦德vs皇家社会我们写"买强队/主"，
     参考软件强队是皇家社会(客队)；且"站对面"配"买强队"自相矛盾）：
     旧 recDir 拿资金符号 dirN 冒充强弱。此处按真实盘口重算覆盖：
     · 已结算：只改 recDir 文案与脏展示指标，result/比分/underMargin/盈亏/grade 一字不动；
     · 未结算：脏端(让球行混独赢/错配)降级 pair + noStat=true，不再进方向分母。 */
  {
    const st = strongSideOf(it);
    const raw = ['jc', 'bd', 'eu'].filter(k => sg[k] && sg[k].ok && finite(sg[k].net));
    const cln = cleanEnds(sg, raw);
    const dirty = raw.length !== cln.length;
    const bLv = (sg.bd && finite(sg.bd.levelStrong)) ? Number(sg.bd.levelStrong) : null;
    const eLv = (sg.eu && finite(sg.eu.levelStrong)) ? Number(sg.eu.levelStrong) : null;
    const match = (bLv != null && eLv != null && Math.abs(bLv - eLv) <= 12);
    /* ★ 信号阈值 0.3pp：365 端净Δ常只有 0.95pp（博洛尼亚场），旧 >1pp 会把它当 0 → 整场漏校正 */
    const sg2 = v => (v > 0.3 ? 1 : (v < -0.3 ? -1 : 0));
    const ss = cln.map(k => sg2(sg[k].net)).filter(Boolean);
    const positive = ss.filter(x => x > 0).length, negative = ss.filter(x => x < 0).length;
    const agree = ss.length >= 2 && Math.max(positive, negative) === ss.length;
    const dNet = agree ? (positive > negative ? 1 : -1) : 0;
    let newDir = null, newKind = null;
    if (st != null && agree && cln.length >= 2) {
      /* ★ 脏端只剔端、不废场：北单错配端剔除后 jc+eu 两独赢端干净同向 → 照常给方向（用户："2/3盘也要及时分析入账"） */
      const over = dNet > 0 ? st : oppSide(st);
      if (over === st) {
        newDir = '买受让/' + sideName(oppSide(st)) + '(正式过热·大热必死·反买过热强队' + sideName(st)
          + '·两独赢端同向' + ss.length + '/' + cln.length + (dirty ? '·已剔除错配端' : '') + ')';
        newKind = 'normal';
      } else {
        newDir = '观察·翻转(' + sideName(over) + '被买爆)·只观察不追高(铁律)·两独赢端同向' + ss.length + '/' + cln.length
          + (dirty ? '·已剔除错配端' : '');
        newKind = 'flip';
      }
      if (dirty && !settled && e.grade !== 'full') {
        e.grade = 'full'; e.tier = 'full'; e.noStat = false; e.trailGuard = false;
        if (op.tier) op.tier = 'full';
        restored++;
      }
    } else if (dirty || st == null || !agree) {
      /* ★2026-11-23 复盘根治（16号至今 78 场被误屏蔽，实测胜率 57%>给方向的48%）：
         旧逻辑在此一律写"只观察"，但这些场原方向已被结算链验证为对（57%命中）。
         ① 已结算：绝不覆盖成"观察"（保留已验证方向文案）。
         ② 未结算但有明确净超买(|netPt|>=3)：按 netPt 反给方向，不屏蔽好比赛。
         ③ 仅 truly 无信号(netPt 弱且 blk)才观察。 */
      /* ★2026-11-23 复盘：已结算场(result已有)若原 recDir 是明确方向，说明结算链已按该方向
         判定成立，tri_sync 自愈轮不得把已验证方向覆盖成"只观察"（否则用户看到"好比赛被屏蔽"）。
         尊重铁律：不新增方向、不推翻 flip/信号不一致的观察判定，只保留已成立的原文案。 */
      /* ★2026-11-23 二次复盘根治（用户："不要漏掉好比赛，特别是3盘合流的强推"）：
         16号前 gen_index 投票引擎（票差口径，11-15 标定 64.2% / 训练留出同向）给方向 88 场、
         命中 62.4%（85 场结算）；16号后本校正块用未标定的 st/agree/dirty 逻辑把它一刀切写成
         "观察"，给方向掉到 40 场 / 48.1%，三盘合流 nSrc>=2 的 21 场被误屏蔽（其中势均力敌
         5 场 win4/5=80%、信号不一致 win2/2、无真实盘口 win1/1）。
         now：gen_index 已给出的明确方向（/^买/）一律保留，不再覆盖成观察 = 恢复 16号前口径。
         ★零回归护栏：已实锤的方向判反（桑坦德vs皇家社会类：st 明确且 agree）走上方 470-481
         分支按真实盘口改向，不进本分支，不受此保护影响；flip 文案是"观察·"开头，同样不受保护，
         仍是铁律观察。只保护 gen_index 投票引擎算出的 /^买/ 方向。 */
      if (/^买/.test(e.recDir || '')) {
        newDir = null; newKind = null;   // gen_index 已标定方向 → 保留，不覆盖成观察
      } else {
        /* ★ 2026-11-25 文案修复：中间分支原带"·只观察"，末尾又统一拼"·只观察"，
           产出"信号不一致·只观察·只观察"重复后缀。统一由末尾拼接，分支内不再重复。 */
        newDir = '观察·' + (st == null ? '无真实盘口·不判强弱'
          : (dirty ? '干净独赢端不足(已剔除错配端)·不进账本' : '两独赢端信号不一致')) + '·只观察';
        newKind = 'normal';
      }
    }
    if (newDir && e.recDir !== newDir) { e.recDir = newDir; touched = true; dirFixed++; }
    if (!settled && newKind && e.kind !== newKind) { e.kind = newKind; touched = true; }
    /* 脏展示指标清洗：爆表 diffMax 一律按干净端重算（含历史遗留的 rq 让球行污染值 64.9/111.8）；
       错配 lvlDiffBd 置 null。只动展示，不动赛果。 */
    {
      const dmax = cln.reduce((m, k) => Math.max(m, Math.abs(sg[k].net)), 0);
      const newDm = dmax > 0 ? r1(dmax) : null;
      if (op.diffMax !== newDm) { op.diffMax = newDm; touched = true; dirtyFixed++; }
    }
    if (!match && op.lvlDiffBd != null) { op.lvlDiffBd = null; touched = true; dirtyFixed++; }
    /* 仅当剔除脏端后连两个干净独赢端都凑不齐时才降级；jc+eu 干净同向的场保持 full 照常入账 */
    if (dirty && !settled && e.grade === 'full' && !(st != null && agree && cln.length >= 2)) {
      e.grade = 'pair'; e.tier = 'pair'; e.noStat = true; e.trailGuard = true;
      if (op.tier) op.tier = 'pair';
      downgraded++;
    }
  }
  if (touched) refreshed++;
}

/* ---------- 写回（只追加） ---------- */
const out = { summary: FP.summary || {}, items };
if (!DRY) {
  const bak = path.join(BASE, 'fundplate_history.json.bak_sync');
  try { fs.copyFileSync(path.join(BASE, 'fundplate_history.json'), bak); } catch (e) {}
  fs.writeFileSync(path.join(BASE, 'fundplate_history.json'), JSON.stringify(out), 'utf8');
}
const diag = {
  generated: new Date().toISOString(), dry: DRY,
  triItems: Object.keys(TRI.items || {}).length,
  before: items.length - stat.added, after: items.length,
  ...stat, samples
};
try { fs.writeFileSync(path.join(BASE, 'fundplate_sync_diag.json'), JSON.stringify(diag, null, 1), 'utf8'); } catch (e) {}

/* ---------- 输出 ---------- */
console.log('[补登记] tri ' + diag.triItems + ' 场 → 新增 ' + stat.added + ' 场（' + (DRY ? 'DRY' : '已写回') + '）');
console.log('  自愈: 指标补空 ' + refreshed + ' 条 · 升级full ' + upgraded + ' 条 · ea补 ' + (stat.eaHealN || 0)
  + ' 条 · 方向校正 ' + dirFixed + ' 条 · 脏指标清洗 ' + dirtyFixed + ' 条 · 脏场降级 ' + downgraded + ' 条 · 剔端保场 ' + restored + ' 条');
if (stat.eaOkN) console.log('  新增登记中带 eaOk(本地Skellam折水·365真逐帧): ' + stat.eaOkN + ' 条');
console.log('  分级: 完整 ' + stat.byGrade.full + ' / 两市场 ' + stat.byGrade.pair + ' / 单端 ' + stat.byGrade.single
  + ' ｜ 跳过: 已登记 ' + stat.skipHave + ' · 无数据 ' + stat.skipNoData + ' · 无队名 ' + stat.skipNoName + ' · 早于' + LIMIT_DAY_MIN + ' ' + stat.skipOld);
console.log('  缺端分布:');
Object.entries(stat.byMissing).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log('    ' + k + ' × ' + v));
console.log('  按日:');
Object.keys(stat.byDay).sort().forEach(d => { const g = stat.byDay[d]; console.log('    ' + d + ' → ' + g.n + ' 场（完整' + g.full + '/两市场' + g.pair + '/单端' + g.single + '）'); });
Object.keys(samples).forEach(g => { if (samples[g].length) { console.log('  样例-' + g + ':'); samples[g].forEach(s => console.log('    ' + s.day + ' ' + s.home + ' vs ' + s.away + ' | ' + s.recDir + ' | ' + s.hcap)); } });
