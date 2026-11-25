#!/usr/bin/env node
/* 三盘赛前轨迹：账本与补漏观察隔离；观察不出票、不结算、不进入标定 tid。 */
'use strict';
/* ★2026-11-21 wrapper 自兜底：CVM 系统 node 默认堆仅~992MB，球探逐帧全量灌入会 OOM(rc=-6)。
   历次靠调用点(refresh_all.py / prekick)带 --max-old-space-size=4096，但 git checkout / 覆盖反复把参数冲掉。
   这里在业务/锁逻辑之前自检：若当前进程未带该参数，则以 4096MB 堆 spawn 自己重跑并透传退出码。
   v8.setFlagsFromString 无法突破启动堆上限（实测），故只能用 wrapper 重启这一条路。
   TRI_NO_REEXEC=1 时跳过（防止无限重启）。*/
if (!process.env.TRI_NO_REEXEC && !(process.execArgv || []).some(a => /^--max-old-space-size/.test(a))) {
  const cp = require('child_process');
  const r = cp.spawnSync(process.execPath, ['--max-old-space-size=4096', __filename, ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, TRI_NO_REEXEC: '1' }, cwd: process.cwd(),
  });
  if (r.error) { console.error('[tri_trail] re-exec failed:', r.error.message); process.exit(1); }
  process.exit(r.status == null ? 1 : r.status);
}
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const BASE = process.env.TRI_BASE || __dirname;
const F = n => path.join(BASE, n);
/* ★2026-11-21 A+B 治标：新增每5分钟赛前临盘预冻结 tick，必须与 15 分钟主链互斥，
   否则两个实例同时写 tri_trail.json / linpan_ledger.json 会互相覆盖。锁超时 5 分钟自清。 */
const TRI_LOCK = F('.tri_build.lock');
let _triLockOwned = false;
function _triLockOwnerAlive() {
  try {
    const pid = parseInt(fs.readFileSync(TRI_LOCK, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // 发信号0探测进程存活； ESRCH=已死, EPERM=活着但无权限
    return true;
  } catch (e) { return e && e.code === 'EPERM'; } // EPERM 说明进程存在
}
function _triLockAcquire() {
  if (process.env.TRI_DRY_RUN === '1') return true;
  try { fs.writeFileSync(TRI_LOCK, String(process.pid) + '\n', { flag: 'wx' }); _triLockOwned = true; return true; }
  catch (_) {
    // ★2026-11-21 防死锁：拥有者进程已死（如 OOM 崩溃 rc=-6）立即清锁自接，
    //   不再只靠 mtime>5min —— 崩溃后锁 mtime 会被 prekick 重写导致永不超时，曾卡死3小时。
    try {
      const st = fs.statSync(TRI_LOCK);
      const ownerDead = !_triLockOwnerAlive();
      if (ownerDead || Date.now() - st.mtimeMs > 300000) { fs.unlinkSync(TRI_LOCK); return _triLockAcquire(); }
    } catch (__) {}
    return false;
  }
}
function _triLockRelease() { if (!_triLockOwned) return; try { fs.unlinkSync(TRI_LOCK); } catch (_) {} }
if (!_triLockAcquire()) { console.log('[三盘] 另一构建实例持锁，跳过本轮'); process.exit(0); }
process.on('exit', _triLockRelease);
process.on('SIGINT', () => { _triLockRelease(); process.exit(130); });
process.on('SIGTERM', () => { _triLockRelease(); process.exit(143); });
const defSnap = fs.existsSync('/opt/football/pool_cloud/snap') ? '/opt/football/pool_cloud/snap'
  : (fs.existsSync('D:/北单竞彩数据/快照流水') ? 'D:/北单竞彩数据/快照流水' : F('snap'));
const SNAP_DIR = process.env.TRI_SNAP_DIR || defSnap;
/* ★★ 2026-11-22 多目录合并读365逐帧（根治「CVM自采帧从未被消费」）：
   CVM 本地采集器 eu365.py / t7_odds.py(球探备源) 直写 /opt/football/pool_cloud/eu365，
   旧版 tri_trail 只读 push 上来的 eu365_frames → gqj2 封禁期本地断帧、CVM 自采的
   数百帧(含球探 titan007 全量历史)零消费、eu.ok 塌 → 大量场次误判「缺365·三盘不齐」。
   现在合并所有存在的目录按同一 schema 读；fp 去重(seen 集合)天然防跨目录重复。 */
const EU365_MAIN = process.env.TRI_EU365_DIR || (fs.existsSync('D:/北单竞彩数据/365逐帧') ? 'D:/北单竞彩数据/365逐帧' : F('eu365_frames'));
const EU365_DIRS = [...new Set([EU365_MAIN, '/opt/football/pool_cloud/eu365', F('../pool_cloud/eu365')]
  .filter(d => d && d !== EU365_MAIN && fs.existsSync(d)).concat([EU365_MAIN].filter(d => fs.existsSync(d))))];
const EU365_DIR = EU365_DIRS[0] || EU365_MAIN; // 仅 coverage 展示用
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } }
function readHistJs(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^[^{]*/, '').replace(/;\s*$/, '')); }
  catch (_) { return fb; }
}
let PUA = {};
try { const m = fs.readFileSync(F('ui.js'), 'utf8').match(/const _DG_PUA=(\{[\s\S]*?\});/); if (m) PUA = JSON.parse(m[1]); } catch (_) {}
if (!Object.keys(PUA).length) PUA = readJson(F('_pool_collector/pua_map.json'), {});
function decode(s) {
  return String(s || '').replace(/<[^>]*>/g, '')
    .replace(/&#x([eE][0-9a-fA-F]{2,4});/g, (_, c) => PUA[c.toLowerCase()] || '')
    .replace(/[\uE000-\uF8FF]/g, c => PUA[c.charCodeAt(0).toString(16)] || '')
    .replace(/[\s·・\-]/g, '');
}
function norm(s) { return decode(s).replace(/[（）()]/g, '').toLowerCase(); }
const ALIAS = [
  [/查维斯/g, '沙维什'], [/阿尔巴塞特/g, '阿尔瓦塞特'], [/邓伯施|邓伯什/g, '登博思'],
  [/雷克斯欧斯|雷克索斯|雷克索/g, '雷克斯'], [/萨瓦德尔/g, '萨瓦德'], [/阿尔梅勒城/g, '阿尔梅勒'],
  [/海尔蒙特体育/g, '海尔蒙特'], [/维戈塞尔塔/g, '塞尔塔'], [/皇家马德里/g, '皇马'],
  [/马德里竞技/g, '马竞'], [/巴塞罗那/g, '巴萨'], [/尤文图斯/g, '尤文']
];
function wnorm(s) { let v = norm(s); for (const [re, x] of ALIAS) v = v.replace(re, x); return v; }
function identity(s) {
  const v = norm(s), age = [...v.matchAll(/(?:u|under)(\d{2})/g)].map(m => m[1]);
  const cn = v.match(/(\d{2})岁/); if (cn) age.push(cn[1]);
  // ★ 2026-11-18 青年队别名：北单把 U21/U20 简写成裸「U」（如「捷克U」「丹麦U」「芬兰U」），
  //   竞彩/账本写全「捷克U21」。裸 U 无数字 → age 为空 → 与带年龄版本 sameIdentity=false → sim=0，
  //   导致三盘身份桥接失败、北单 160+ 帧被丢弃。这里给裸 U 结尾打通配标记 U*，
  //   仅在下述 sameIdentity 里与具体年龄兼容（其余身份维度必须完全一致，成年队不受影响）。
  if (!age.length && /u$/i.test(v) && /\d/.test(v) === false) age.push('U*');
  const raw = String(s || '').replace(/<[^>]*>/g, '').toLowerCase();
  return [/(女|women|woman|ladies|female|femenin)/i.test(v) || /(?:^|[\s（(-])w[）)]?\s*$/i.test(raw), [...new Set(age)].sort().join(','),
    /青年|青队|youth|juvenil/i.test(v), /(?:b队|二队|预备|后备|reserves?|b$|ii$)/i.test(v)
      || /(?:^|[\s（(-])b(?:[）)]|\s*team)?\s*$/i.test(raw)].join('|');
}
function sameIdentity(a, b) {
  const ia = identity(a), ib = identity(b);
  if (ia === ib) return true;
  const pa = ia.split('|'), pb = ib.split('|');
  if (pa.length !== pb.length) return false;
  let diff = 0, ageOk = false;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] === pb[i]) continue;
    diff++;
    if (i === 1) {
      // 年龄维度差异：允许「带 Uxx 年龄」与「完全无年龄 / 裸U / U*」互通，
      // 但要求两边队名去掉年龄后缀后的主体一致，避免把不同年龄/不同队误并。
      const aa = pa[i] === '' || pa[i] === 'U*' || /^\d{2}$/.test(pa[i]);
      const bb = pb[i] === '' || pb[i] === 'U*' || /^\d{2}$/.test(pb[i]);
      const stripped = s => wnorm(s).replace(/(?:under|u)\d{2}$/i, '').replace(/u$/i, '');
      ageOk = aa && bb && stripped(a) === stripped(b);
      if (!ageOk) return false;
    } else return false;
  }
  return diff === 1 && ageOk;
}
function sim(a, b) {
  if (!sameIdentity(a, b)) return 0;
  a = wnorm(a); b = wnorm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b, longer = a.length <= b.length ? b : a;
  // 双向包含算同队：竞彩/北单常用简称（西雅图 / 盐湖城），365 用全称
  // （西雅图海湾人 / 皇家盐湖城）。旧规则只认前缀，「皇家盐湖城」含「盐湖城」
  // 的后缀写法 sim 只有 0.75 → 365 身份匹配失败，真实逐帧被判「无数据」。
  // 短名至少 3 字且占长名一半以上，配合同联赛+时间+唯一候选护栏才放行。
  if (shorter.length >= 3 && shorter.length / longer.length >= 0.5 && longer.includes(shorter)) return 0.92;
  /* ★★ 2026-11-22 两字简称前缀/后缀放行（门兴多特真根因）：
     竞彩/北单对「门兴格拉德巴赫」只写「门兴」、「霍芬海姆」写「霍村」这类两字简称，
     LCS 只得 0.44 < 0.8 → 整场配不上账本/365，40 帧竞彩序列+181 帧365逐帧被扔观察区。
     两字必须整词贴边（前缀或后缀，如 门兴|格拉德巴赫、皇家|盐湖城），
     拒「联合」「利亚」这类中段子串；再叠联赛+开赛的10min+唯一候选既有护栏防撞名。 */
  if (shorter.length === 2 && (longer.startsWith(shorter) || longer.endsWith(shorter))) return 0.92;
  if (Math.min(a.length, b.length) >= 2 && Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.5
    && (a.startsWith(b) || b.startsWith(a))) return 0.92;
  const dp = Array(b.length + 1).fill(0);
  for (const x of a) { let prev = 0; for (let j = 1; j <= b.length; j++) {
    const old = dp[j]; dp[j] = x === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = old;
  } }
  return 2 * dp[b.length] / (a.length + b.length);
}
/* ★ 2026-11-17 友谊赛跨源别名归一（身份桥接，不放宽玩法护栏）：
   同一场国际友谊赛，竞彩叫「国际赛」、北单叫「友谊赛」、365 叫「国际友谊」，
   sim 只有 0.571 < 0.6 → leagueOK=false → matchEu365 拿不到唯一候选 → 竞彩/北单/365
   被拆成三条各自只有单端的 watch 组，UI 显示「序列不齐」，但三端帧其实都在
   （中国vs巴林 20:00：竞彩15帧/北单98帧/365 219条）。这里只把这三个同义词归一，
   使身份可桥接；队名≥0.8、开赛时间≤600秒、唯一候选等护栏在 matchEu365 里全部保留。
   归一仅限「纯友谊赛同义词」，不得推广为模糊联赛匹配。 */
function _friendlyCanon(s) {
  const v = norm(s);
  if (v === '国际赛' || v === '友谊赛' || v === '国际友谊' || v === '国际友谊赛') return '国际友谊';
  return v;
}
/* ★ 2026-11-18 青年联赛跨源别名：欧洲青年预选赛各源写法不同——
   竞彩账本「欧青U21外 / 欧洲U20」，北单「U21欧预 / U21欧预赛 / U20欧预」。
   sim 只有 0.5~0.545 < 0.6 → leagueOK=false → 队名即使桥接成功仍被联赛关卡挡住。
   这里只对「同年龄段(U21 或 U20) + 明确欧洲青年预选语义」做归一，
   不放宽成年联赛、不跨年龄( U21≠U20 )、不放宽模糊联赛匹配。 */
function _youthCanon(s) {
  const v = norm(s);
  if (/u21/.test(v) && /欧|青|预|外/.test(v)) return 'U21欧青';
  if (/u20/.test(v) && /欧|青|预|外|洲/.test(v)) return 'U20欧青';
  return v;
}
/* ★★ 2026-11-25 跨源联赛别名归一（治福冈黄蜂vs横滨水手「日职联 vs J联赛」配对根因）：
   账本(365/竞彩侧)与北单快照对同一联赛写法不同，sim(LCS) 常 <0.6 → leagueOK=false →
   队名 sim 明明 0.92、北单 no=46 有真实 spf(rq=0) 序列，仍被联赛关卡整场砍掉 →
   bd=null → nSrc=1 → 看板显示「序列不齐·只观察」。这不是数据缺失，是身份桥接漏了别名。
   实测对照（账本写法 → 北单写法）：日职/日职联 → J联赛/J1联赛、美职业 → 美职、
   墨西联/墨西超 → 墨联、欧罗巴杯 → 欧联、欧冠杯 → 欧冠、韩K联/韩职 → K联赛/K1联赛、
   韩K2联 → K2联赛、中北美国联 → 中北美国家联赛、英足总杯 → 足总杯、
   丹麦超 → 丹超、丹麦甲 → 丹甲、捷克甲 → 捷甲、阿根廷超级杯 → 阿超杯。
   严格一一映射，绝不模糊放宽：J联赛(J1) 与 J2联赛 仍是两个不同代号，绝不混配。 */
const _LEAGUE_ALIAS = new Map([
  ['日职', 'J1联赛'], ['日职联', 'J1联赛'], ['j联赛', 'J1联赛'], ['j1联赛', 'J1联赛'],
  ['美职业', '美职'], ['美职', '美职'],
  ['墨西联', '墨联'], ['墨西超', '墨联'], ['墨联', '墨联'], ['墨超', '墨超'],
  ['欧罗巴杯', '欧联'], ['欧联', '欧联'], ['欧罗巴联赛', '欧联'],
  ['欧冠杯', '欧冠'], ['欧冠', '欧冠'], ['欧冠联赛', '欧冠'],
  ['韩k联', 'k联赛'], ['韩职', 'k联赛'], ['k联赛', 'k联赛'], ['k1联赛', 'k联赛'],
  ['韩k2联', 'k2联赛'], ['k2联赛', 'k2联赛'],
  ['中北美国联', '中北美国家联赛'], ['中北美国家联赛', '中北美国家联赛'],
  ['英足总杯', '足总杯'], ['足总杯', '足总杯'],
  ['丹麦超', '丹超'], ['丹麦甲', '丹甲'], ['捷克甲', '捷甲'],
  ['阿根廷超级杯', '阿超杯'], ['阿超杯', '阿超杯'],
]);
function _leagueCanon(s) {
  const v = norm(s);
  return _LEAGUE_ALIAS.get(v) || v;
}
function leagueOK(a, b) {
  if (!(norm(a) && norm(b))) return false;
  if (_friendlyCanon(a) === _friendlyCanon(b) && _friendlyCanon(a) === '国际友谊') return true;
  const ya = _youthCanon(a), yb = _youthCanon(b);
  if (ya === yb && (ya === 'U21欧青' || ya === 'U20欧青')) return true;
  // ★2026-11-25：严格别名归一后相等即放行；别名表外的写法仍走原 sim>=0.6 硬门槛，不放宽。
  if (_leagueCanon(a) === _leagueCanon(b) && _LEAGUE_ALIAS.has(norm(a)) && _LEAGUE_ALIAS.has(norm(b))) return true;
  return sim(a, b) >= 0.6;
}
function epochMs(v) {
  if ((typeof v !== 'string' && typeof v !== 'number') || String(v).trim() === '') return 0;
  const n = Number(v), ms = n < 1e12 ? n * 1000 : n;
  return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : 0;
}
function tsOf(s) {
  const v = String(s || '').trim().replace(' ', 'T');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?$/.test(v)) return 0;
  const n = Date.parse(v + (/(?:Z|[+-]\d\d:\d\d)$/.test(v) ? '' : '+08:00'));
  return Number.isFinite(n) ? n : 0;
}
function dayOf(k) { return k ? new Date(k + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '') : ''; }
function hhmmOf(s) {
  const m = String(s || '').match(/(?:^|[ T])(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return m && +m[1] < 24 && +m[2] < 60 && (m[3] == null || +m[3] < 60)
    ? m[1].padStart(2, '0') + ':' + m[2] + (m[3] == null ? '' : ':' + m[3]) : '';
}
function dayKick(day, hm) {
  if (!/^\d{8}$/.test(String(day)) || !/^\d\d:\d\d(?::\d\d)?$/.test(hm)
    || +hm.slice(0, 2) > 23 || +hm.slice(3, 5) > 59 || (hm.length > 5 && +hm.slice(6) > 59)) return 0;
  const k = tsOf(day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6, 8) + ' ' + hm);
  return dayOf(k) === day ? k : 0;
}
function shiftDay(day, d) { const k = dayKick(day, '12:00'); return k ? dayOf(k + d * 86400e3) : ''; }
function ledgerKick(e) {
  return epochMs(e.ko) || tsOf(e.ko) || dayKick(String(e.day || ''), hhmmOf(e.kickoff));
}
function groupKick(g) {
  const full = tsOf(g.kickoff);
  const official = [...new Set(g.frames.map(f => tsOf((f.bdOfficial || {}).endTime)).filter(Boolean))];
  if (official.length > 1) { g.scheduleConflict = true; return 0; }
  if (official.length === 1) {
    const k = official[0] + 5 * 60e3, hm = hhmmOf(g.kickoff);
    if ((full && Math.abs(full - k) > 5 * 60e3)
      || (!full && hm && Math.abs(dayKick(dayOf(k), hm) - k) > 5 * 60e3)) {
      g.scheduleConflict = true; return 0;
    }
    return full || k;
  }
  if (full) return full;
  const hm = hhmmOf(g.kickoff), day = String(g.date || '');
  // 本地流水：竞彩 date 为自然比赛日；北单凌晨 HHMM 属销售日次日。
  return dayKick(g.src === '北单' && hm && +hm.slice(0, 2) < 12 ? shiftDay(day, 1) : day, hm);
}
function parseHcap(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const s = String(v).trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/[+-]?(?:\d+(?:\.\d+)?|\.\d+))?$/.test(s)) return null;
  const parts = s.split('/'), a = Number(parts[0]);
  let n = a;
  if (parts.length === 2) {
    let b = Number(parts[1]);
    if (!/^[+-]/.test(parts[1]) && /^-/.test(parts[0])) b = -b;
    if (Math.abs(a - b) !== 0.5) return null;
    n = (a + b) / 2;
  }
  return Number.isFinite(n) && Math.abs(n) <= 20 && Math.abs(n * 4 - Math.round(n * 4)) < 1e-8 ? n : null;
}
function implied(o) {
  if (!Array.isArray(o) || o.length !== 3) return null;
  const a = o.map(Number); if (a.some(x => !Number.isFinite(x) || x <= 1)) return null;
  const sum = a.reduce((s, x) => s + 1 / x, 0);
  return a.map(x => +(100 / x / sum).toFixed(3));
}
function pct3(a) {
  const v = a.map(Number); if (v.some(x => !Number.isFinite(x) || x <= 0)) return null;
  const sum = v.reduce((s, x) => s + x, 0); return v.map(x => +(100 * x / sum).toFixed(3));
}
const placeholder = p => Math.abs(p[0] - p[1]) < 0.01 && Math.abs(p[1] - p[2]) < 0.01;
const postPhase = f => /赛后|开赛后|完场|终场|结束|进行中|滚球|中场|下半场|上半场|加时|点球|post|finish|ended|in[-_ ]?play|live/i.test(String(f.phase || ''));
const audit = { rejectedPostKick: 0, rejectedPhase: 0, rejectedUnknownKick: 0, phaseRescued: 0, retained: { jc: 0, bd: 0, rq: 0, eu: 0, asia: 0 }, postKickRetained: 0, phaseRetained: 0, unknownKickRetained: 0 };
const retainedFrames = [];
/* ★★ 2026-11-23 根治：北单官方补登帧（澳客页已下架时由官方 XML 单独补的那一帧）
   带有真实独赢 SP（pools.spf rq=0 或 pools.bdSpf handicap=0 且三项有值），
   但 phase 常被标成「未知(官方停售)」/「完场(官方补登)」，旧 preFrames 一律当赛后丢弃
   → bd 段 n=0 → yg365 算不出 → overGap 恒 null → 强推整批消失。
   实测 16 号后 52 场 handicap=0 的真独赢盘就是这样被丢的。
   这里只在【北单 + 三项赔率真实有值 + 时间戳严格早于开赛】时放行，绝不放宽「已开奖 SP 已下架」（三项 null）。 */
function hasRealBdOdds(f) {
  const P = f.pools || {}, S = P.spf || {}, B = P.bdSpf || {};
  const ok3 = v => { const x = Number(v); return isFinite(x) && x > 1.01 && x < 67; };
  if (parseHcap(S.rq) === 0 && ok3(S.h) && ok3(S.d) && ok3(S.a)) return true;
  if (parseHcap(B.handicap) === 0 && ok3(B['3']) && ok3(B['1']) && ok3(B['0'])) return true;
  return false;
}
function preFrames(frames, kick) {
  const out = [];
  for (const f of frames) {
    if (!kick) { audit.rejectedUnknownKick++; continue; }
    const ts = tsOf(f.ts || f.t), ep = f.ep == null ? ts : epochMs(f.ep);
    /* ★★ 2026-11-23：官方补登帧的采集时刻常晚于停售几分钟（例：瓦斯科达伽马 06:06:53
       采集、06:05 开赛），但帧里装的是【停售瞬间的官方终值 SP】，其有效时点是
       bdOfficial.endTime（停售），一定早于开赛。用采集时刻当赛前判据会把整批真终值判成
       赛后脏数据 —— 这就是「北单明明有 SP、线上却一场强推都没有」的最后一环。
       只对「北单 + 三项赔率真实有值 + endTime 严格早于开赛」生效，其余口径不动。 */
    let eff = ts, effEp = ep;
    if (f.src === '北单' && hasRealBdOdds(f)) {
      const et = tsOf((f.bdOfficial || {}).endTime);
      if (et && et < kick) { eff = et; effEp = et; }
    }
    if (!ts || !ep || eff >= kick || effEp >= kick) { audit.rejectedPostKick++; continue; }
    if (postPhase(f)) {
      if (f.src === '北单' && hasRealBdOdds(f)) {
        audit.phaseRescuedBdOdds = (audit.phaseRescuedBdOdds || 0) + 1;
        out.push(Object.assign({}, f, { phase: '赛前(官方终值)', valueTs: eff }));
        continue;
      }
      /* ★ 2026-11-17：北单凌晨场 date=销售日、time=次日凌晨，采集器旧 _phase()
         未跨日，把 00:00~03:45 的赛前帧误标「开赛后(残帧)」。此处防御：
         时间戳已严格 < 权威开赛 kick，且北单官方 bdOfficial 佐证未开赛 → 救回赛前帧。
         竞彩/365 的 phase 语义可信，仍按原规则剔除，绝不放宽它们的赛后判定。 */
      const bo = f.bdOfficial || {};
      const st = String(bo.state || '');
      const endTs = tsOf(bo.endTime);
      const officialOk = /销售中|待开赛|未开赛|预售|sale|open/i.test(st)
        || !!(endTs && Math.abs(endTs + 5 * 60e3 - kick) <= 5 * 60e3);
      if (f.src === '北单' && officialOk) {
        audit.phaseRescued++;
        out.push(Object.assign({}, f, { phase: '赛前(相位纠偏)' }));
        continue;
      }
      audit.rejectedPhase++; continue;
    }
    out.push(eff !== ts ? Object.assign({}, f, { valueTs: eff }) : f);
  }
  return out;
}
function retain(kind, frames, kick) {
  for (const f of frames) {
    /* 官方终值帧的采集 ts 可能晚于开赛，但值时刻是停售 endTime(valueTs)；
       保留审计按值时刻计，序列排序仍用真实采集 ts（终值自然排在最后）。 */
    const ts = f.valueTs || tsOf(f.ts || f.t);
    const ep = f.valueTs || (f.ep == null ? ts : epochMs(f.ep));
    retainedFrames.push({ kind, ts, ep, kick, phase: f.phase });
  }
}
function segment(frames) {
  if (!frames.length) return null;
  const k = Math.max(1, Math.min(Math.ceil(frames.length * 0.25), 5));
  const avg = a => [0, 1, 2].map(i => +(a.reduce((s, p) => s + p[i], 0) / a.length).toFixed(3));
  return { open: avg(frames.slice(0, k)), close: avg(frames.slice(-k)) };
}
function trail(seq, strongIdx, minN) {
  if (!seq.length) return { n: 0, ok: false, f: [] };
  /* ★★ 2026-11-23：单帧终值。官方补登场次只有 1 帧真实 SP，但「破缺口」只需要
     终值一个点（yg365 用 rawClose/rawOpen），不需要序列。允许 minN=1 时判 ok，
     并显式标 singleFrame，方向类判定（依赖 dStrong/net/拐点）仍按单帧=无变化处理。 */
  if (seq.length === 1) {
    const p = seq[0].p, wi = strongIdx === 0 ? 2 : 0;
    return { n: 1, ok: 1 >= minN, singleFrame: true, t0: seq[0].t, t1: seq[0].t,
      open: p.slice(), close: p.slice(), dStrong: 0, dWeak: 0, net: 0, netEnds: 0, netTurn: null,
      levelStrong: +p[strongIdx].toFixed(2), levelWeak: +p[wi].toFixed(2),
      turnT: null, turnAmp: 0, firstMoveT: null, firstMoveTs: null,
      changes: 0, flat: true, f: [[seq[0].t, ...p]] };
  }
  const sg = segment(seq.map(x => x.p)), wi = strongIdx === 0 ? 2 : 0;
  const dStrong = +(sg.close[strongIdx] - sg.open[strongIdx]).toFixed(2);
  const dWeak = +(sg.close[wi] - sg.open[wi]).toFixed(2), dn = p => p[strongIdx] - p[wi];
  let maxJump = 0, turnT = null, turnI = -1, firstMoveT = null, changes = 0;
  for (let i = 1; i < seq.length; i++) {
    const d = dn(seq[i].p) - dn(seq[i - 1].p);
    if (Math.abs(d) > Math.abs(maxJump)) { maxJump = +d.toFixed(2); turnT = seq[i].t; turnI = i; }
    if (firstMoveT === null && Math.abs(d) >= 1.5) firstMoveT = seq[i].t;
    if (seq[i].p.some((v, j) => Math.abs(v - seq[i - 1].p[j]) > 0.01)) changes++;
  }
  let netTurn = null;
  if (turnI > 0) {
    const pre = segment(seq.slice(0, turnI).map(x => x.p)), post = segment(seq.slice(turnI).map(x => x.p));
    netTurn = +(dn(post.close) - dn(pre.open)).toFixed(2);
  }
  return { n: seq.length, ok: seq.length >= minN, t0: seq[0].t, t1: seq.at(-1).t,
    open: sg.open, close: sg.close, dStrong, dWeak, net: +(dStrong - dWeak).toFixed(2),
    netEnds: +(dn(seq.at(-1).p) - dn(seq[0].p)).toFixed(2), netTurn,
    levelStrong: +sg.open[strongIdx].toFixed(2), levelWeak: +sg.open[wi].toFixed(2),
    turnT, turnAmp: maxJump, firstMoveT, firstMoveTs: firstMoveT ? tsOf(firstMoveT) : null,
    changes, flat: changes === 0,
    f: seq.filter((_, i) => seq.length <= 24 || i % Math.ceil(seq.length / 24) === 0 || i === seq.length - 1).map(x => [x.t, ...x.p]) };
}
function buildTrail(frames, extract, strongIdx, kick, kind) {
  const seq = [];
  for (const f of preFrames(frames, kick)) {
    const p = extract(f); if (!p || placeholder(p)) continue;
    retain(kind, [f], kick); seq.push({ t: f.ts, p });
  }
  seq.sort((a, b) => tsOf(a.t) - tsOf(b.t));
  return trail(seq, strongIdx, 3);
}
function bdValue(f, src) {
  const P = f.pools || {}, row = P[src] || {};
  if (parseHcap(src === 'bdSpf' ? row.handicap : row.rq) !== 0) return null;
  if (src === 'spf') return implied([row.h, row.d, row.a]);
  if (src === 'fund') return pct3([row['胜'], row['平'], row['负']]);
  if (src === 'bdSpf') return implied([row['3'], row['1'], row['0']]);
  return null;
}
function rqValue(f) {
  const P = f.pools || {}, candidates = [];
  for (const [key, row, field] of [['rqspf', P.rqspf, 'rq'], ['spf', P.spf, 'rq'], ['bdSpf', P.bdSpf, 'handicap']]) {
    if (!row) continue;
    const rq = parseHcap(row[field]); if (rq == null) continue;
    const goal = parseHcap(row.goalLine); if (goal != null && goal !== rq) return null;
    if (rq === 0) continue;
    candidates.push({ key, row, rq });
  }
  const fu = P.fund || {}, frq = parseHcap(fu.rq);
  const lines = new Set(candidates.map(x => x.rq)); if (frq != null && frq !== 0) lines.add(frq);
  if (lines.size !== 1 || !candidates.length) return null;
  const rq = [...lines][0];
  if (frq === rq) { const p = pct3([fu['胜'], fu['平'], fu['负']]); if (p) return { p, rq, market: 'rqspf:fund' }; }
  for (const c of candidates) {
    const p = c.key === 'bdSpf' ? implied([c.row['3'], c.row['1'], c.row['0']]) : implied([c.row.h, c.row.d, c.row.a]);
    if (p) return { p, rq, market: 'rqspf:' + c.key };
  }
  return null;
}
function buildBd(grp, strongIdx, kick) {
  const bdChannels = new Map();
  const bdFrames = preFrames(grp.frames, kick).sort((a, b) => tsOf(a.ts) - tsOf(b.ts));
  // 同来源同rq=0建轨迹；固定优先级，不因帧数不足跨源补齐。
  for (const src of ['spf', 'fund', 'bdSpf']) {
    const seq = [];
    for (const f of bdFrames) {
      const p = bdValue(f, src); if (!p || placeholder(p)) continue;
      const row = (f.pools || {})[src] || {};
      const raw = src === 'spf' ? [Number(row.h), Number(row.d), Number(row.a)]
        : (src === 'bdSpf' ? [Number(row['3']), Number(row['1']), Number(row['0'])] : null);
      seq.push({ f, p, raw });
    }
    if (seq.length) bdChannels.set(src + '|0', seq);
  }
  const chosen = bdChannels.entries().next().value;
  const selectedBd = chosen ? chosen[1] : [];
  retain('bd', selectedBd.map(x => x.f), kick);
  const bd = trail(selectedBd.map(x => ({ t: x.f.ts, p: x.p })), strongIdx, 1);
  /* 帧数 <3 的 bd 段：数据够算「破缺口」（单点终值即可），但序列类判定不可信，
     打薄序列标记供 align/方向环节降级，避免单帧被当成「序列齐·三盘同向」。 */
  if (selectedBd.length < 3) bd.thinSeq = true;
  Object.assign(bd, { no: grp.no, home: grp.home, away: grp.away,
    chosenSource: chosen ? chosen[0].split('|')[0] : null,
    observedN: [...bdChannels.values()].reduce((n, v) => n + v.length, 0),
    channels: [...bdChannels].map(([key, v]) => ({ key, n: v.length })),
    src: chosen ? chosen[0].split('|')[0] + '(不让球独赢)' : 'none(仅让球行/无独赢帧)' });
  const _rawSeq = selectedBd.filter(x => x.raw && x.raw.every(v => Number.isFinite(v) && v > 1.01));
  bd.rawOpen = _rawSeq.length ? _rawSeq[0].raw : null;
  bd.rawClose = _rawSeq.length ? _rawSeq.at(-1).raw : null;
  const seq = [];
  for (const f of preFrames(grp.frames, kick)) {
    const x = rqValue(f); if (!x || placeholder(x.p) || (Math.abs(x.p[0] - x.p[2]) < 0.01 && x.p[1] > 50)) continue;
    seq.push({ f, ...x });
  }
  if (!seq.length) return { bd, rq: null };
  const channels = new Map();
  for (const x of seq) { const key=x.market+'|'+x.rq; if(!channels.has(key))channels.set(key,[]); channels.get(key).push(x); }
  // 不同来源不拼接也不整段抛弃：独立分通道，优先保留真实fund占比通道。
  const selected = [...channels.values()].sort((a,b)=>(b[0].market==='rqspf:fund')-(a[0].market==='rqspf:fund') || b.length-a.length)[0];
  retain('rq', selected.map(x => x.f), kick);
  const rq = trail(selected.map(x => ({ t: x.f.ts, p: x.p })), strongIdx, 3);
  return { bd, rq: Object.assign(rq, { rq: selected[0].rq, goalLine: selected[0].rq, market: selected[0].market,
    observedN:seq.length, channels:[...channels].map(([key,v])=>({key,n:v.length})),
    comparable: true, usable: false, note: '让球胜平负·同来源同盘口分通道·不可与365独赢相减·不参与方向票' }) };
}
const snapDirs = [...new Set([SNAP_DIR, F('local_pool_snap')])].filter(d=>fs.existsSync(d));
const snapFiles = snapDirs.flatMap(d=>fs.readdirSync(d).filter(f=>/^\d{8}\.jsonl$/.test(f)).sort().map(f=>path.join(d,f)));
if (!snapFiles.length) { console.warn('[tri_trail] 快照为空，保留原产物'); process.exit(0); }
const groups = new Map(); let lines = 0, badLines = 0;
for (const fn of snapFiles) {
  for (const line of fs.readFileSync(fn, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue; lines++;
    let o; try { o = JSON.parse(line); } catch (_) { badLines++; continue; }
    if (!o || !['竞彩', '北单'].includes(o.src) || !o.pools) continue;
    /* ★★ 2026-11-24 根治「三盘看着齐却被|net|>30当脏端全剔」：
       官方 XML 补登帧的 o.date 是【整个销售周标签】，不可靠——实测蒙扎vs佛罗伦萨
       11-20/21/22/23 四个快照文件里的 no=322 帧，o.date 全被写成 20261123，
       按 o.date|no 归并就把 4 天 478 帧并进一组 → bd 序列跨4天震荡、net 虚高到+31
       → cleanEnds 剔脏端 → converge=false → 三盘合流整批消失。
       修：北单分组的 date 改用【快照文件名日期 = 真实采集/销售日】，o.date 仅作兜底。
       文件名日期是采集器按日切分的物理事实，不会被补登标签污染；每天322独立成组，
       配对时只有开赛日对齐的组入围。这是数据正确性修复，不动任何方向/结算口径。 */
    const date = (o.src === '北单') ? String(path.basename(fn).slice(0, 8) || o.date || '')
                                    : String(o.date || path.basename(fn).slice(0, 8));
    /* ★★ 2026-11-23 根治「D盘有、线上没有」：北单同一场比赛同时存在
       「澳客页帧（短队名/简写 kickoff）」和「官方 XML 补登帧（官方全名/完整 endTime）」，
       旧 key 把 home/away/kickoff 都拼进去 → 同一场被拆成 2~3 个 group，
       配对时只有一个能中，另一批帧（往往正是有真实独赢 SP 的官方帧）整组被丢。
       北单编号 no + 销售日 date 在同一天内唯一（跨日会重排，故必须带 date），
       用它做归并键；竞彩无稳定数字编号，保持原键。 */
    const key = (o.src === '北单' && o.no != null && String(o.no) !== '')
      ? ['北单NO', date, String(o.no)].join('|')
      : [date, o.kickoff, o.src, o.home, o.away, o.league || ''].join('|');
    if (!groups.has(key)) groups.set(key, { key, date, kickoff: o.kickoff, src: o.src, home: o.home, away: o.away, league: o.league || '', no: o.no, frames: [], sigs: new Set() });
    const grp = groups.get(key);
    // 多目录（CVM pool_cloud + local_pool_snap）与抓取补录会带来同帧重复，按时间+玩法签名去重
    const fsig = o.ts + '|' + o.src + '|' + JSON.stringify(o.pools || {});
    if (!grp.sigs.has(fsig)) { grp.sigs.add(fsig); grp.frames.push(o); }
  }
}
const glist = [...groups.values()];
for (const g of glist) { g.frames.sort((a, b) => tsOf(a.ts) - tsOf(b.ts)); g.kick = groupKick(g); }
let H = readJson(F('fundplate_history.json'), null);
if (!H || !Array.isArray(H.items) || !H.items.length) H = readHistJs(F('fundplate_hist.js'), { items: [] });
const hist = (H.items || []).filter(e => e && e.tid != null);
if (!hist.length) { console.warn('[tri_trail] 账本为空，保留原产物'); process.exit(0); }
const OT = readJson(F('odds_timeline.json'), { items: {} }), otItems = OT.items || OT;
const eu365Meta = new Map(), eu365ByTid = new Map();
/* ★★ 2026-11-22 官方销售编号直配索引（根治「365抓到了却判缺365 / 三盘不齐」）：
   365逐帧自带 saleNumbers=["竞彩:周六019"]/["北单:85"]，与竞彩/北单快照 o.no 同源唯一，
   是比队名模糊匹配严格得多的官方身份键。旧 matchEu365 只认「队名sim>=0.8 + 开赛10min
   + 联赛一致 + 候选唯一」，译名差异/北单销售截止早于真实开赛数小时/多候选歧义 任一命中
   就整场丢掉365 → 实测 11-21~23 有 186 场好比赛(拜仁vs科隆283帧、曼城vs富勒姆156帧、
   利物浦vs曼联397帧)被误判「缺365·三盘不齐·不进方向账本」。
   这里只在【原护栏失败(0候选或>1候选)】时按编号兜底直配，原护栏成功的场一字不动=零回归。 */
const saleNoIdx = new Map();
/* ★★ 2026-11-23：反向索引 tid → 北单销售编号。用于【北单快照 ↔ 账本】的身份直配。
   此前北单配对只靠「队名 sim≥0.8 + 停售时刻±10分」，译名不同（瑞模/雷莫）或
   endTime 与真实开赛错位就整场丢失；365 帧的 saleNumbers 里「北单:12」是官方编号，
   与北单快照 o.no 同源，是最硬的身份键。 */
const tidToBdNos = new Map();
let euByNoHit = 0, euByNoAmbig = 0;
let euByNameHit = 0, euByNameAmbig = 0;
let eu365Files = 0, eu365Frames = 0, eu365PostKick = 0, eu365Bad = 0;
const seen = new Set();
for (const _edir of EU365_DIRS) {
  if (!fs.existsSync(_edir)) continue;
  for (const fn of fs.readdirSync(_edir).filter(f => /^\d{8}\.jsonl$/.test(f)).sort()) {
    eu365Files++;
    let _raw;
    try { _raw = fs.readFileSync(path.join(_edir, fn), 'utf8'); }
    catch (_) { continue; } // 采集器正在写/归档，文件可能瞬时被移走，跳过即可
    for (const line of _raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (_) { eu365Bad++; continue; }
      const tid = String(o.tid || '');
      if (!tid) continue;
      /* ★ 官方销售编号索引：day|编号 → tid 集合。365 逐帧自带 saleNumbers
         (["竞彩:周六019"]/["北单:85"])，与竞彩/北单快照 o.no 同源，是官方唯一身份键。
         只在候选唯一时采信；多 tid 争同一编号视为歧义、拒绝（同 matchEu365 原护栏）。 */
      const _sDay = String(o.day || path.basename(fn).slice(0, 8));
      for (const _sn of (o.saleNumbers || [])) {
        const _m = String(_sn || '').match(/^(?:竞彩|北单)[:：]\s*(\S+)\s*$/);
        if (!_m) continue;
        const _k = _sDay + '|' + _m[1];
        if (!saleNoIdx.has(_k)) saleNoIdx.set(_k, new Set());
        saleNoIdx.get(_k).add(tid);
        if (/^北单[:：]/.test(String(_sn || ''))) {
          if (!tidToBdNos.has(tid)) tidToBdNos.set(tid, new Set());
          tidToBdNos.get(tid).add(_m[1]);
        }
      }
      const kickEpoch = epochMs(o.kick_ts), kickText = tsOf(o.kickoff);
      const kick = kickEpoch || kickText, capturedAt = tsOf(o.capturedAt);
      const invalidMeta = !!(kickEpoch && kickText && Math.abs(kickEpoch - kickText) > 60e3)
        || !!(kick && o.day && String(o.day) !== dayOf(kick));
      if (o.home && o.away) {
        const next = { home: String(o.home), away: String(o.away), league: String(o.league || ''), kickoff: String(o.kickoff || ''),
          day: dayOf(kick), kick_ts: kick, capturedAt, conflict: invalidMeta };
        const cur = eu365Meta.get(tid);
        if (!cur) eu365Meta.set(tid, next);
        else {
          const changed = !!(cur.kick_ts && kick && cur.kick_ts !== kick)
            || wnorm(cur.home) !== wnorm(next.home) || wnorm(cur.away) !== wnorm(next.away);
          // 只有双队身份一致且官方快照开赛时间独立支持的新元数据，才解除旧时间冲突。
          const supported = !invalidMeta && glist.some(g => g.kick && Math.abs(g.kick-kick)<=10*60e3
            && leagueOK(g.league,next.league) && sim(g.home,next.home)>=0.8 && sim(g.away,next.away)>=0.8);
          const conflict = supported ? false : (cur.conflict || changed || invalidMeta);
          if (capturedAt && (!cur.capturedAt || capturedAt > cur.capturedAt)) eu365Meta.set(tid, { ...next, conflict });
          else if (supported && sim(cur.home,next.home)>=0.8 && sim(cur.away,next.away)>=0.8) eu365Meta.set(tid, {...next, conflict:false});
          else cur.conflict = conflict;
        }
      }
      if (o.sane === false || !['eu', 'asia'].includes(o.market)) { eu365Bad++; continue; }
      const ep = epochMs(o.epoch), ts = tsOf(o.ts);
      if (!ep || !ts || Math.abs(ep - ts) > 60e3) { eu365Bad++; continue; }
      const fp = tid + '|' + o.market + '|' + (o.fp || [ep, o.a, o.b, o.c].join('|'));
      if (seen.has(fp)) continue; seen.add(fp);
      if (!eu365ByTid.has(tid)) eu365ByTid.set(tid, { eu: [], asia: [] });
      const g = eu365ByTid.get(tid);
      if (o.market === 'eu') {
        const vals = [o.a, o.b, o.c].map(Number), sum = vals.reduce((s, x) => s + 1 / x, 0);
        const p = implied([o.b, o.a, o.c]);
        if (!p || vals.some(x => x <= 1.01 || x >= 67) || !(sum > 1 && sum < 1.35) || placeholder(p)) { eu365Bad++; continue; }
        g.eu.push({ t: o.ts, ep, p, phase: o.phase, frameKick: kick, raw: [Number(o.b), Number(o.a), Number(o.c)] });
      } else {
        const hcap = parseHcap(o.a), water = o.b == null || String(o.b).trim() === '' ? null : Number(o.b);
        if (hcap == null || !Number.isFinite(water) || water <= 0) { eu365Bad++; continue; }
        g.asia.push({ t: o.ts, ep, hcap, water, phase: o.phase, frameKick: kick });
      }
    }
  }
  }
  for (const [tid, g] of eu365ByTid) {
    const mt = eu365Meta.get(tid), kick = mt && !mt.conflict ? mt.kick_ts : 0;
    for (const kind of ['eu', 'asia']) {
      const before = g[kind].length;
      g[kind] = preFrames(g[kind], kick).filter(f => !f.frameKick || f.ep < f.frameKick).sort((a, b) => a.ep - b.ep);
      eu365PostKick += before - g[kind].length; eu365Frames += g[kind].length;
    }
  }
function buildEuFromFrames(g, strongIdx, kick) {
  if (!g) return null;
  const seq = preFrames(g.eu, kick), as = preFrames(g.asia, kick);
  if (seq.length < 2) return null;
  retain('eu', seq, kick); retain('asia', as, kick);
  return Object.assign(trail(seq, strongIdx, 2), { srcKind: 'b365_frames',
    src: 'Bet365逐帧·严格赛前', anchorNote: '仅真实赛前变化帧', euFrames: seq.length, asiaFrames: as.length,
    hcap0: as.length ? as[0].hcap : null, hcap1: as.length ? as.at(-1).hcap : null,
    water0: as.length ? as[0].water : null, water1: as.length ? as.at(-1).water : null,
    bookOpen: seq[0].p, bookClose: seq.at(-1).p,
    rawOpen: seq[0].raw || null, rawClose: seq.at(-1).raw || null });
}
function buildEuTimeline(frames, strongIdx, kick) {
  const seq = [];
  const sorted = preFrames(frames, kick).sort((a, b) => tsOf(a.t) - tsOf(b.t));
  for (const f of sorted) {
    const c = ((f.c || {}).Bet365 || {}).c;
    const p = c ? implied([c.h, c.d, c.a]) : null;
    if (!p || placeholder(p)) continue;
    seq.push({ t: f.t, p }); retain('eu', [f], kick);
  }
  if (!seq.length) return null;
  const eu = trail(seq, strongIdx, 2);
  return Object.assign(eu, { srcKind: 'b365_timeline_c', src: '仅Bet365.c赛前即时价',
    anchorNote: '首末均为赛前即时价，不读取汇总或o', bookOpen: seq[0].p,
    bookClose: seq.at(-1).p });
}
function timeCompatible(g, kick) {
  if (!g.kick || !kick) return false;
  // 北单可能给销售截止时间，只容许提前五分钟；其它完整开赛时间容差十分钟。
  const hasEnd = g.frames.some(f => tsOf((f.bdOfficial || {}).endTime));
  const full = tsOf(g.kickoff);
  // ★ 2026-11-19：北单元数据里的 kickoff/endTime 常比竞彩真实开赛早 2~3 小时（例：3111660
  //   奥兰多vs辛辛那提，北单 11-19 06:05 / endTime 11-20 06:00，竞彩 11-20 08:30），
  //   旧 5/10 分钟硬护栏把【真实存在的北单独赢序列】整路丢掉，看板老显示"三盘不齐"。
  //   只在北单组本身有 >=8 帧真实 spf(rq=0) 独赢序列时放宽到 180 分钟；纯让球行/少帧组
  //   仍走原 5/10 分钟，避免把零星 rq 帧误配到别场。dry-run：ledger ok 95→97，零 ok 回归。
  if (g.src === '北单') {
    const singleFrames = g.frames.filter(f => { const s = (f.pools || {}).spf; return s && Number(s.rq) === 0 && s.h && s.d && s.a; }).length;
    /* ★★ 2026-11-23 第五次修正（用户："D盘有全部数据，线上三盘合流一场都没有"）。
       原门槛 >=8 帧才放宽到 180min/12h —— 但北单小场次快照常只有 2~7 帧 spf，
       于是被 5/10 分钟硬门槛挡掉：bd=null → seg.bd 空 → yg365Of 拿不到北单 raw →
       overGap 恒 null → 热推三盘合流全灭。实测 16 号后 180 场"有 365、无北单"
       正是这一类（不是数据缺失，是配对被门槛误杀）。
       yg365Of 只需开盘+临盘两帧；故放宽起点降到 2 帧。护栏一条不减：
       官方全名齐全 + 同日 + 北单不晚于开赛 + 差<=12h + 队名 sim>=0.8 + 联赛 + 唯一候选。 */
    if (singleFrames >= 2) {
      const off = (g.frames.find(f => (f.bdOfficial || {}).endTime) || {}).bdOfficial || {};
      // ★ 2026-11-20 第二次修正：北单的 kick 其实是「销售截止+5分」，合法地早于
      //   真实开赛数小时（西雅图vs盐湖城：北单 06:05 / 竞彩 11:00，差 4h55m）。
      //   旧 180 分钟仍会误杀。只在【官方全名齐全 + 同日 + 北单时间早于账本开赛 +
      //   差<=12h + 真实独赢帧 + 队名/联赛 sim 护栏 + 唯一候选】下放行，
      //   绝不反向放宽（北单时间晚于开赛仍走 5/10 分钟）。
      if (off.host && off.guest && dayOf(g.kick) === dayOf(kick) && g.kick <= kick && kick - g.kick <= 12 * 3600e3) return true;
      return Math.abs(g.kick - kick) <= 180 * 60e3;
    }
    return Math.abs(g.kick - kick) <= (full && !hasEnd ? 5 : 10) * 60e3;
  }
  return Math.abs(g.kick - kick) <= 10 * 60e3;
}
function matchEu365(g) {
  const cand = [];
  for (const [tid, mt] of eu365Meta) {
    if (mt.conflict || !g.kick || !mt.kick_ts || Math.abs(g.kick - mt.kick_ts) > 10 * 60e3) continue;
    const sh = sim(g.home, mt.home), sa = sim(g.away, mt.away);
    if (sh < 0.8 || sa < 0.8 || !leagueOK(g.league, mt.league)) continue;
    cand.push({ tid, mt, sh, sa, timeEq: g.kick === mt.kick_ts, score: +(sh * 60 + sa * 60).toFixed(1),
      kickDiffMin: (g.kick - mt.kick_ts) / 60e3 });
  }
  // 多候选一律拒绝，不靠最佳分掩盖身份歧义。
  if (cand.length === 1) return cand[0];
  /* ★★ 2026-11-22 兜底：官方销售编号直配（原护栏失败才走，原护栏成功的场一字不动=零回归）。
     场景：北单销售截止早于真实开赛数小时 / 译名差异 / 多候选歧义 → 旧 strict 全拒，
     但 365 逐帧里编号与竞彩/北单 no 完全一致，是最可靠的官方身份键。
     护栏：①编号唯一对应 1 个 tid（多 tid 歧义拒绝）②同 day ③tid 在 eu365Meta 存在
     ④队名双向基本吻合(sim>=0.5，防编号跨场误配)⑤eu 真实逐帧 >=2 帧。
     满足即挂上真 tid → 365 真逐帧被 buildEuFromFrames 读进 seg.eu。
     开关 TRI_NO_BYNO=1 可关闭，供 dry-run 前后对比。 */
  // 0 候选(时间/队名被挡) 或 >1 候选(歧义) 都交给官方编号解歧；编号唯一即强证据。
  if (process.env.TRI_NO_BYNO === '1') return null;
  const _gDay = String(g.date || dayOf(g.kick) || '');
  const _gNo = String(g.no || '').trim();
  if (!_gDay || !_gNo || !saleNoIdx.size) return null;
  /* ★★ 2026-11-23 断点修复（用户："D盘有全部数据，线上却一场都抓不到"）：
     北单 `date` 是【销售分组日】，常比 365 的真实开赛日早一天（例：巴恩斯利 vs 谢周三
     北单 20261120 03:55 / 365 day=20261121 04:00；横滨FC 也是 20261121 但北单记 20261121-1）。
     旧代码只查 _gDay 这一天 → 编号索引查不到 → byNo 兜底静默失败 → eu=null →
     整场退化成 W_ 无 tid 观察场，于是"三盘合流"永远凑不齐两盘以上。
     修：编号索引按 date±1 三天合并查，仍要求全局唯一 tid + 队名 sim>=0.5 双护栏，
     歧义（跨日同编号命中 >1 tid）照样拒绝，不放宽任何身份判据。 */
  const _dayKeys = [_gDay];
  for (const _dd of [-1, 1]) { const s = shiftDay(_gDay, _dd); if (s && s !== _gDay) _dayKeys.push(s); }
  const _tids = new Set();
  for (const _dk of _dayKeys) { const _s = saleNoIdx.get(_dk + '|' + _gNo); if (_s) _s.forEach(t => _tids.add(t)); }
  if (_tids.size > 1) euByNoAmbig++;
  if (_tids.size === 1) {
    const _tid0 = [..._tids][0], _mt0 = eu365Meta.get(_tid0), _fr0 = eu365ByTid.get(_tid0);
    const _sh0 = _mt0 ? sim(g.home, _mt0.home) : 0, _sa0 = _mt0 ? sim(g.away, _mt0.away) : 0;
    if (_mt0 && !_mt0.conflict && _fr0 && _fr0.eu.length >= 2 && _sh0 >= 0.5 && _sa0 >= 0.5) {
      euByNoHit++;
      return { tid: _tid0, mt: _mt0, sh: _sh0, sa: _sa0,
        timeEq: g.kick === _mt0.kick_ts, score: +(_sh0 * 60 + _sa0 * 60).toFixed(1),
        kickDiffMin: (g.kick - _mt0.kick_ts) / 60e3, byNo: true };
    }
  }
  /* ★★ 2026-11-23 第三级兜底：队名+联赛+开赛日±1 唯一（编号缺失/编号异源时）。
     用户实测"D盘 365 明明有巴恩斯利 vs 谢周三，线上却整场 eu=null"——因为北单组的
     `no` 与 365 `saleNumbers` 不同源（部分场 365 侧编号为空字符串），byNo 无键可查。
     这里改用最稳的物理身份：①开赛时间差 <=12h ②队名双向 sim>=0.8 ③联赛 leagueOK
     ④该 tid 有 >=2 帧真 365 逐帧 ⑤候选必须全局唯一（多候选一律拒绝，绝不靠最高分猜）。
     仍不改动 strict/byNo 已成功的任何场次，纯增量兜底。TRI_NO_BYNAME=1 可关闭。 */
  if (process.env.TRI_NO_BYNAME === '1') return null;
  if (!g.kick) return null;
  const _nameCand = [];
  for (const [tid2, mt2] of eu365Meta) {
    if (mt2.conflict || !mt2.kick_ts) continue;
    if (Math.abs(g.kick - mt2.kick_ts) > 12 * 3600e3) continue;
    if (mt2.day && !_dayKeys.includes(String(mt2.day))) continue;
    const sh2 = sim(g.home, mt2.home), sa2 = sim(g.away, mt2.away);
    if (sh2 < 0.8 || sa2 < 0.8 || !leagueOK(g.league, mt2.league)) continue;
    const fr2 = eu365ByTid.get(tid2);
    if (!fr2 || fr2.eu.length < 2) continue;
    _nameCand.push({ tid: tid2, mt: mt2, sh: sh2, sa: sa2,
      timeEq: g.kick === mt2.kick_ts, score: +(sh2 * 60 + sa2 * 60).toFixed(1),
      kickDiffMin: (g.kick - mt2.kick_ts) / 60e3, byName: true });
  }
  if (_nameCand.length === 1) { euByNameHit++; return _nameCand[0]; }
  if (_nameCand.length > 1) euByNameAmbig++;
  return null;
}
/* ★★ 2026-11-23 队名宽松兜底（治 275 场「无北单候选」）：
   账本用全称（维多利亚 / 布拉干蒂诺RB），北单快照用短简称（维多利 / 布拉干）。
   `sim` 的"包含即同队"要求短名占长名 >=50%，"布拉干"(3)/"布拉干蒂诺RB"(7)=0.43
   → 落到 LCS=0.60 < 0.8 → 判不同队 → bd=null → yg365 恒 null → 三盘合流全灭。
   这里只在 strict 完全无候选时做一次宽松兜底：①任一方包含另一方（短名>=2字）
   ②同联赛 leagueOK ③timeCompatible 已过 ④全局唯一候选。多候选一律拒绝。 */
function looseTeam(a, b) {
  const x = wnorm(a), y = wnorm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const s = x.length <= y.length ? x : y, L = x.length <= y.length ? y : x;
  if (s.length >= 2 && L.includes(s) && s.length / L.length >= 0.34) return 0.9;
  return 0;
}
const used = new Set(), pairs = new Map();
const proposals = [];
/* 2026-11-23 配对断点诊断计数（只读，不改判定） */
const pairDiag = { bdNoCand: 0, bdNoMulti: 0, bdProposed: 0, jcNoCand: 0, bdOwnerDrop: 0, jcOwnerDrop: 0, bdLooseHit: 0, bdLooseAmbig: 0, bdTimeHit: 0, bdTimeAmbig: 0, bdNoKeyHit: 0, bdNoKeyAmbig: 0 };
for (const e of hist) {
  const tid = String(e.tid), kick = ledgerKick(e); pairs.set(tid, { jc: null, bd: null });
  for (const src of ['竞彩', '北单']) {
    const _dEpoch = s => { const x = String(s || ''); return /^\d{8}$/.test(x) ? Date.parse(x.slice(0, 4) + '-' + x.slice(4, 6) + '-' + x.slice(6)) : NaN; };
    /* ★★ 2026-11-23 第〇级（最硬）：官方销售编号直配。
       365 帧 saleNumbers「北单:12」 ↔ 北单快照 o.no。绕过队名译名差异与
       停售时刻/真实开赛错位。只认【编号命中 + 销售日 ±1 天 + 全局唯一】，多条即拒绝。 */
    let cand = null;
    if (src === '北单') {
      const _nos = tidToBdNos.get(tid);
      if (_nos && _nos.size) {
        const _ed = _dEpoch(e.day);
        const byNo = glist.filter(g => g.src === '北单' && _nos.has(String(g.no || '').trim())
          && (!isFinite(_ed) || !isFinite(_dEpoch(g.date)) || Math.abs(_dEpoch(g.date) - _ed) <= 86400e3)
          && (!e.league || !g.league || leagueOK(e.league, g.league)));
        if (byNo.length === 1) { cand = byNo; pairDiag.bdNoKeyHit = (pairDiag.bdNoKeyHit || 0) + 1; }
        else if (byNo.length > 1) pairDiag.bdNoKeyAmbig = (pairDiag.bdNoKeyAmbig || 0) + 1;
      }
    }
    if (!cand) cand = glist.filter(g => g.src === src && timeCompatible(g, kick)
      && sim(e.home, g.home) >= 0.8 && sim(e.away, g.away) >= 0.8
      && (!e.league || !g.league || leagueOK(e.league, g.league)));
    const _isBd = src === '北单';
    if (!cand.length) {
      /* 宽松兜底：strict 全无候选时，用"包含即同队"再找一次，必须全局唯一。 */
      const looseCand = glist.filter(g => g.src === src && timeCompatible(g, kick)
        && looseTeam(e.home, g.home) >= 0.9 && looseTeam(e.away, g.away) >= 0.9
        && (!e.league || !g.league || leagueOK(e.league, g.league)));
      if (looseCand.length === 1) { cand = looseCand; if (_isBd) pairDiag.bdLooseHit++; }
      else if (looseCand.length > 1) { if (_isBd) pairDiag.bdLooseAmbig++; }
      /* 第三级兜底：译名完全不同的场（北单「瑞模」 vs 账本「雷莫」→ 无包含关系，任何 sim 都救不了）。
         改用最硬的物理身份：同联赛 + 开赛时刻 ±10 分钟内【全局唯一】一个组，才认。
         同联赛同时开赛两场以上即为多候选，一律拒绝（绝不靠"最像"猜）。 */
      if (!cand.length && kick && _isBd) {
        const timeOnly = glist.filter(g => g.src === src && g.kick
          && Math.abs(g.kick - kick) <= 10 * 60e3
          && (!e.league || !g.league || leagueOK(e.league, g.league)));
        if (timeOnly.length === 1) { cand = timeOnly; if (_isBd) pairDiag.bdTimeHit++; }
        else if (timeOnly.length > 1) { if (_isBd) pairDiag.bdTimeAmbig++; }
      }
    }
    if (!cand.length) { if (_isBd) pairDiag.bdNoCand++; else pairDiag.jcNoCand++; }
    if (process.env.TRI_DEBUG_TID && tid === process.env.TRI_DEBUG_TID) {
      const _f = k => (k ? new Date(k + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) : '0');
      const _all = glist.filter(g => g.src === src && sim(e.home, g.home) >= 0.5)
        .slice(0, 6).map(g => ({ key: g.key, no: g.no, kick: _f(g.kick), n: g.frames.length,
          timeOK: timeCompatible(g, kick), sh: +sim(e.home, g.home).toFixed(2), sa: +sim(e.away, g.away).toFixed(2),
          lgOK: e.league && g.league ? leagueOK(e.league, g.league) : null }));
      console.error('[DBG]', tid, src, 'ledgerKick', _f(kick), 'cand', cand.length, 'nearGroups', JSON.stringify(_all));
    }
    // 同一销售编号的全名/简称/截止时刻是同场不同分组，不是多场候选。
    // 只合并编号一致且开赛在容差内的组；不同编号或身份冲突仍拒绝。
    /* ★★ 2026-11-24 根治「三盘看着齐却全被|net|>30剔成脏端」真因：
       北单会把同一场比赛在多个销售日反复挂同一编号（实测蒙扎vs佛罗伦萨
       11-20~23 连续4天都=no322），byName/12h 放宽让多天同编号组都进 cand，
       这里再把它们 frames 全并进一条 trail → bd 序列跨4天震荡、net 虚高到±60~97
       → cleanEnds 当错配脏端剔除 → converge=false → 三盘合流整批消失。
       修：只保留与权威开赛日对齐的销售日组（北单销售日 = 开赛日 或 前一天，
       凌晨场跨日已由 dayKick 处理），拒绝把早于开赛日2天以上的组混入。
       这是数据正确性修复，不动任何方向/结算口径；无合规组时退回原 cand 不硬凑。 */
    let _mergeCand = cand;
    if (_isBd && kick && cand.length > 1) {
      const _kDay = dayOf(kick);
      const _near = cand.filter(g => {
        const gd = String(g.date || dayOf(g.kick) || '');
        if (!gd) return true;                       // 无销售日的组不擅自剔除
        return gd === _kDay || gd === shiftDay(_kDay, -1) || gd === shiftDay(_kDay, 1);
      });
      if (_near.length) _mergeCand = _near;         // 有合规组才收紧；否则保持原样
    }
    const nos = new Set(_mergeCand.map(g => String(g.no || '')));
    if (_mergeCand.length && nos.size === 1 && !nos.has('')) {
      const cand = _mergeCand;
      const sorted = cand.slice().sort((a,b) => b.frames.length-a.frames.length);
      const merged = Object.assign({}, sorted[0], { keys: cand.map(g=>g.key), frames: [] });
      const seen = new Set();
      for (const g of cand) for (const f of g.frames) {
        const sig = f.ts + '|' + JSON.stringify(f.pools);
        if (!seen.has(sig)) { seen.add(sig); merged.frames.push(f); }
      }
      merged.frames.sort((a,b)=>tsOf(a.ts)-tsOf(b.ts));
      proposals.push({ tid, kind: src === '竞彩' ? 'jc' : 'bd', g: merged });
      if (_isBd) pairDiag.bdProposed++;
    } else if (cand.length && _isBd) pairDiag.bdNoMulti++;
  }
}
const owners = new Map();
for (const x of proposals) for (const key of (x.g.keys || [x.g.key])) {
  if (!owners.has(key)) owners.set(key, new Set()); owners.get(key).add(x.tid);
}
for (const x of proposals) {
  const _clean = (x.g.keys || [x.g.key]).every(key => owners.get(key).size === 1);
  if (_clean) { pairs.get(x.tid)[x.kind] = x.g; for (const key of (x.g.keys || [x.g.key])) used.add(key); }
  else if (x.kind === 'bd') pairDiag.bdOwnerDrop++; else pairDiag.jcOwnerDrop++;
}
function alignSegments(seg, kick, conflict) {
  const { jc, bd, eu, rq } = seg;
  const ends = [['jc', jc], ['bd', bd], ['eu', eu]].filter(([, v]) => v && v.ok && Number.isFinite(v.net));
  const sgn = v => v.net > 1 ? 1 : (v.net < -1 ? -1 : 0);
  const signs = ends.map(([, v]) => sgn(v)).filter(Boolean);
  const same = signs.length ? Math.max(signs.filter(x => x > 0).length, signs.filter(x => x < 0).length) : 0;
  const rqSign = rq && rq.comparable && Number.isFinite(rq.net) ? sgn(rq) : 0;
  const lead = ends.filter(([, v]) => v.firstMoveTs).sort((a, b) => a[1].firstMoveTs - b[1].firstMoveTs)[0];
  const flags = { jcOk: !!(jc && jc.ok), bdOk: !!(bd && bd.ok), euOk: !!(eu && eu.ok),
    rqOnly: !!(rq && !(bd && bd.ok)), nSrc: ends.length,
    euLate: !!(eu && eu.ok && jc && jc.ok && tsOf(eu.t0) > tsOf(jc.t1)), unknownKick: !kick, scheduleConflict: !!conflict };
  // ★2026-11-20 修：北单只有让球行(rq)时 bd 不在 ends 内；若竞彩+365 两个「独赢」端
  // 都齐(ends>=2)，两端与让球行无数学混算，理应入围。rqOnly 不再一票否决——移除它
  // 不放宽任何门槛(ends>=2 仍在)，只纠正「有两盘独赢数据却被整场否决」的错误。
  const ok = !!kick && !conflict && ends.length >= 2 && !flags.euLate;
  const oneEndWhy = () => {
    if (ends.length === 1) {
      const k = ends[0][0], n = ends[0][1].n || 0;
      const nm = k === 'bd' ? '北单' : (k === 'jc' ? '竞彩' : '365');
      return '仅' + nm + '单端完整实时序列(' + n + '帧·开盘→临盘)·缺第二独立盘口交叉验证·不进方向账本';
    }
    return flags.rqOnly ? '北单只有让球行·独赢缺失，且无第二个独赢端' : '有效独立端不足2路(单端不入围)';
  };
  return { flags, ok, why: ok ? '' : (!kick ? '无可靠开赛时间·仅展示' : conflict ? '赛程元数据冲突·不可结算'
    : flags.euLate ? '365首帧晚于竞彩末帧·时点错配' : oneEndWhy()),
    align: { nSrc: ends.length, signs, same, dir: signs.length && signs.every(s => s === signs[0]) ? signs[0] : 0,
      lead: lead ? lead[0] : null, leadT: lead ? lead[1].firstMoveT : null,
      converge: ends.length >= 2 && signs.length === ends.length && signs.every(s => s === signs[0]),
      rqSign, sameWithRq: rqSign ? same + (signs.filter(s => s === rqSign).length >= 2 ? 1 : 0) : same,
      rqFade: rq && rq.comparable && Number.isFinite(rq.net) ? rq.net : null } };
}
/* ★★ 2026-11-23 让球轴三盘对齐（治「竞彩/北单/365 都有、面板却说不齐」）：
 *   独赢轴(lucrative h/d/a)天生缺：竞彩遇到强弱悬殊只开【让球胜平负】不开胜平负，
 *   北单也一样只挂让球行。原来 _build_tri_trail 只读 pools.had 与 pools.spf(rq=0)，
 *   这两种场就被判「竞彩缺/北单缺」，于是三盘合流永远不成立。
 *   让球轴完全独立计算：竞彩 hhad(线在 goalLineValue，不是 handicap) + 北单 rqspf + 365 亚盘。
 *   只用于如实展示与降档观察，绝不参与 overGap / 强推门槛（深盘证伪，铁律不变）。 */
function buildRqAxis(jcRq, rq, eu) {
  const sgn = v => !Number.isFinite(v) ? 0 : (v > 1 ? 1 : (v < -1 ? -1 : 0));
  const legs = [];
  if (jcRq && jcRq.ok && jcRq.line != null) {
    legs.push({ k: 'jc', line: jcRq.line, dir: sgn(jcRq.net), n: jcRq.n, open: jcRq.open, close: jcRq.close });
  }
  if (rq && rq.ok && rq.rq != null) {
    legs.push({ k: 'bd', line: rq.rq, dir: sgn(rq.net), n: rq.n, open: rq.open, close: rq.close });
  }
  if (eu && eu.hcap1 != null && Number.isFinite(eu.water0) && Number.isFinite(eu.water1)) {
    const dw = +(eu.water0 - eu.water1).toFixed(3);  // 主水下降 = 主队被买 = 主热
    legs.push({ k: 'eu', line: eu.hcap1, lineOpen: eu.hcap0, dir: dw > 0.02 ? 1 : (dw < -0.02 ? -1 : 0),
      n: eu.asiaFrames || 0, w0: eu.water0, w1: eu.water1, dw });
  }
  const lineOk = legs.length >= 2 && legs.every(l => Math.abs(Math.abs(l.line) - Math.abs(legs[0].line)) <= 0.26);
  const dirs = legs.map(l => l.dir);
  const converge = legs.length === 3 && lineOk && dirs.every(d => d !== 0 && d === dirs[0]);
  const _al = legs.length ? Math.abs(legs[0].line) : null;
  /* 盘型分级按历史口径：浅盘(|线|<=0.5·唯一站住的边)、中盘(0.75~1.25)、深盘(>=1.5·已证伪)。 */
  const grade = _al == null ? null : (_al <= 0.5 ? '浅盘' : (_al < 1.5 ? '中盘' : '深盘'));
  const deep = _al == null ? null : _al >= 1.5;
  return { n: legs.length, legs, lineOk, dirs, converge, deep, grade,
    line: legs.length ? legs[0].line : null,
    /* 允许进「观察」展示：三端齐 & 同线；进「强推」仍要独赢轴 overGap，绝不越权 */
    ready: legs.length === 3 && lineOk,
    note: legs.length < 2 ? '让球轴不足2端' : (!lineOk ? '让球线不一致(' + legs.map(l => l.k + ':' + l.line).join(' ') + ')'
      : (converge ? '让球轴3/3同线同向·' + grade : '让球轴同线但方向不一致·' + grade)) };
}
function buildSegments(pr, eu365, strongIdx, kick, ot) {
  let jc = null, bd = null, rq = null, jcRq = null;
  if (pr.jc) {
    jc = buildTrail(pr.jc.frames, f => { const h = (f.pools || {}).had; return h ? implied([h.h, h.d, h.a]) : null; }, strongIdx, kick, 'jc');
    Object.assign(jc, { no: pr.jc.no, home: pr.jc.home, away: pr.jc.away });
    /* 竞彩让球胜平负：让球线字段是 goalLineValue/goalLine，handicap 恒为空。 */
    jcRq = buildTrail(pr.jc.frames, f => { const h = (f.pools || {}).hhad; return h ? implied([h.h, h.d, h.a]) : null; }, strongIdx, kick, 'jcRq');
    const jl = preFrames(pr.jc.frames, kick)
      .map(f => { const h = (f.pools || {}).hhad || {}; return parseHcap(h.goalLineValue != null ? h.goalLineValue : h.goalLine); })
      .filter(v => v != null && v !== 0);
    jcRq.line = jl.length ? jl[jl.length - 1] : null;
    jcRq.no = pr.jc.no;
  }
  if (pr.bd) ({ bd, rq } = buildBd(pr.bd, strongIdx, kick));
  const eu = buildEuFromFrames(eu365, strongIdx, kick) || buildEuTimeline(ot || [], strongIdx, kick);
  const rqAxis = buildRqAxis(jcRq, rq, eu);
  return { jc, bd, eu, rq, jcRq, rqAxis };
}
/* ★★ 2026-11-23 破缺口(overGap) 在线自算（治「三盘合流强推一场都没有」）：
 *   与 engine.ygDiff 逐字同式，输入改成本文件自己读到的【原始小数赔率】——
 *   北单 spf(h,d,a) + 365 帧(b=主,a=平,c=客)，取临盘最后一笔。
 *   这样 overGap 不再依赖 bake 是否被 gqj2 567 挡住，也不会被补登记写死 null。 */
function yg365Of(seg) {
  try {
    const bd = seg && seg.bd, eu = seg && seg.eu;
    const sp = bd && (bd.rawClose || bd.rawOpen);
    const oc = eu && (eu.rawClose || eu.rawOpen);
    if (!sp || !oc || sp.length !== 3 || oc.length !== 3) return null;
    if (!(sp.every(v => v > 1.01 && v < 67) && oc.every(v => v > 1.01 && v < 67))) return null;
    const R365 = +(1 / oc.reduce((a2, v) => a2 + 1 / v, 0)).toFixed(4);
    if (!(R365 > 0.7 && R365 < 1.35)) return null;
    const pconv = sp.map(v => 1 / (v * R365)), p365 = oc.map(v => 1 / v);
    let hotI = 0; for (let i = 1; i < 3; i++) if (p365[i] > p365[hotI]) hotI = i;
    const hotDiffPP = +((pconv[hotI] - p365[hotI]) * 100).toFixed(2);
    const gap = +((1 - R365) * 100).toFixed(2);
    const diffMax = +Math.abs(hotDiffPP).toFixed(2);
    if (diffMax > 40) return { overGap: null, max: diffMax, gap, hotSide: null, R365, src: 'tri365', nulled: true };
    return { overGap: hotDiffPP > gap, max: diffMax, hotDiffPP, gap, hotSide: ['W', 'D', 'L'][hotI], R365, src: 'tri365' };
  } catch (e) { return null; }
}
const items = {}; let nWithAny = 0, nOk = 0, nRqOnly = 0;
/* fundplate_history 里部分队名带 <span class="tm"> 之类的内联标签，直接透传到线上会污染渲染，
   统一去标签（PUA 私有区编码不动，前端仍走 decodeName 还原）。 */
const plainName = v => String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
for (const e of hist) {
  const tid = String(e.tid), pr = pairs.get(tid), ot = otItems[tid] || [], g = eu365ByTid.get(tid), mt = eu365Meta.get(tid);
  if (!pr.jc && !pr.bd && !ot.length && !(g && g.eu.length >= 2)) continue;
  const kick = ledgerKick(e), conflict = !!(mt && (mt.conflict || (kick && mt.kick_ts && Math.abs(kick - mt.kick_ts) > 10 * 60e3)));
  let strongIdx = e.strongIsHome === false ? 2 : 0;
  if (e.strongIsHome == null && parseHcap(e.realHcap) < 0) strongIdx = 2;
  const seg = buildSegments(pr, conflict ? null : g, strongIdx, kick, conflict ? [] : ot);
  if (process.env.TRI_DEBUG_TID && tid === process.env.TRI_DEBUG_TID) {
    const _bf = pr.bd ? pr.bd.frames : [];
    const _pre = _bf.filter(f => { const ts = tsOf(f.ts || f.t); return ts && ts < kick; });
    const _ok = _pre.filter(f => { const r = (f.pools || {}).spf; return r && Number(r.rq) === 0 && r.h && r.d && r.a; });
    console.error('[DBG3]', 'raw', _bf.length, 'tsLtKick', _pre.length, 'spfValid', _ok.length,
      'sampleRaw', JSON.stringify(_bf.slice(0, 2).map(f => ({ ts: f.ts, phase: f.phase, ep: f.ep }))),
      'samplePre', JSON.stringify(_pre.slice(0, 2).map(f => ({ ts: f.ts, phase: f.phase, spf: (f.pools || {}).spf }))));
  }
  const status = alignSegments(seg, kick, conflict);
  items[tid] = { day: String(e.day || ''), kickoff: String(e.kickoff || ''), kickTs: kick, strongIdx,
    /* ★★ 2026-11-23 用户："比赛队名呢"——线上「临盘·三盘合流(已并入主表)」整列只有 VS、没有队名。
       根因：账本区 item 只写了 day/kickoff/seg，从没带过 home/away/league；
       前端只能拿到 undefined，主表那批行就渲染成空白。（观察区 watch 项一直有队名，所以只有合并行空。）
       这里从 fundplate_history 原样带出（PUA 私有区编码串，与主表同源），由前端 decodeName 统一还原。 */
    home: plainName(e.home), away: plainName(e.away), homeZht: plainName(e.homeZht),
    awayZht: plainName(e.awayZht), league: plainName(e.league),
    homeId: (e.homeId == null ? null : e.homeId), awayId: (e.awayId == null ? null : e.awayId),
    seg, yg365: yg365Of(seg), rqAxis: seg.rqAxis,
    /* 比分随条目带出，供临盘区按独赢口径现算结算（主表亚盘结算另算，互不影响）。 */
    res: (e.hs != null && e.as != null) ? { hs: e.hs, as: e.as, verified: true } : null,
    ...status };
  nWithAny++; if (status.ok) nOk++; if (status.flags.rqOnly) nRqOnly++;
}
// 快照对比断言：观察区不得改变任何原 tid 的 seg/ok/align/flags 等字段。
const ledgerSnapshot = JSON.stringify(items);
const ledgerTids = new Set(hist.map(e => String(e.tid)));
const TODAY = dayOf(Date.now()), dayMin = shiftDay(TODAY, -Number(process.env.TRI_WATCH_BACK || 3)), dayMax = shiftDay(TODAY, Number(process.env.TRI_WATCH_AHEAD || 2));
const wb = new Map(), watchMatches = new Map(), watchClaims = new Map();
for (const g of glist) {
  if (used.has(g.key)) continue;
  const day = dayOf(g.kick) || String(g.date || ''); if (day < dayMin || day > dayMax) continue;
  const mi = matchEu365(g); watchMatches.set(g.key, mi);
  if (mi) {
    const claim = mi.tid + '|' + g.src;
    if (!watchClaims.has(claim)) watchClaims.set(claim, new Set());
    watchClaims.get(claim).add(String(g.no || g.key));
  }
}
for (const g of glist) {
  if (!watchMatches.has(g.key)) continue;
  const day = dayOf(g.kick) || String(g.date || '');
  const candidate = watchMatches.get(g.key);
  const mi = candidate && watchClaims.get(candidate.tid + '|' + g.src).size === 1 ? candidate : null;
  // 多分组争用同一 tid/来源也拒绝匹配，独立展示，不拼接歧义轨迹。
  const key = mi ? 'T' + mi.tid : 'W_' + Buffer.from(g.key).toString('base64url');
  if (!wb.has(key)) wb.set(key, { tid: mi ? mi.tid : null, day: mi ? mi.mt.day : day,
    kick: mi ? mi.mt.kick_ts : g.kick, home: g.home, away: g.away, league: g.league || (mi ? mi.mt.league : ''),
    scheduleConflict: !!g.scheduleConflict, jc: null, bd: null, mi });
  const b = wb.get(key), kind = g.src === '竞彩' ? 'jc' : 'bd';
  b.scheduleConflict = b.scheduleConflict || !!g.scheduleConflict;
  if (b[kind]) {
    assert(String(b[kind].no) === String(g.no) && mi, '不同编号的观察组不得合并');
    const seen = new Set(b[kind].frames.map(f=>f.ts+'|'+JSON.stringify(f.pools)));
    b[kind] = Object.assign({}, b[kind], { frames: b[kind].frames.concat(g.frames.filter(f=>!seen.has(f.ts+'|'+JSON.stringify(f.pools)))).sort((a,c)=>tsOf(a.ts)-tsOf(c.ts)) });
  } else b[kind] = g;
}
/* ★ 2026-11-20 观察区同场桥接（账本主链零改动）：
   竞彩「西雅图 vs 盐湖城 11:00」和北单「西雅图 vs 皇家盐 06:05(=销售截止+5分)」
   是同一场，但 365 赛程接口被限流没拿到 tid，365 身份链断掉后两条各只有一端的
   观察记录被拆开展示。D 盘实际有竞彩 21 帧 + 北单 395 帧独赢序列。
   这里只在观察区做保守桥接：同日 + 同联赛 + 官方全名/简称双向可证明同身份 +
   北单 >=8 帧真实 spf(rq=0) 独赢 + 唯一候选 + 不同 tid 不并。 */
function _officialNames(g) {
  const off = (g.frames.find(f => (f.bdOfficial || {}).host) || {}).bdOfficial || {};
  return { home: off.host || g.home, away: off.guest || g.away };
}
const loose = [...wb.entries()].filter(([, b]) => !b.euOnly && !(b.jc && b.bd));
let watchBridged = 0;
for (const [k1] of loose) {
  if (!wb.has(k1)) continue;
  const cur = wb.get(k1);
  if (cur.euOnly || (cur.jc && cur.bd)) continue;
  const need = cur.jc ? 'bd' : 'jc';
  const own = cur.jc || cur.bd, cand = [];
  for (const [k2] of loose) {
    if (k2 === k1 || !wb.has(k2)) continue;
    const b2 = wb.get(k2), g2 = b2[need];
    if (!g2 || b2.euOnly || (b2.jc && b2.bd)) continue;
    if (b2.tid && cur.tid && b2.tid !== cur.tid) continue;
    const d1 = dayOf(own.kick) || String(own.date || ''), d2 = dayOf(g2.kick) || String(g2.date || '');
    if (!d1 || d1 !== d2 || !leagueOK(own.league, g2.league)) continue;
    const n1 = _officialNames(own), n2 = _officialNames(g2);
    if (sim(n1.home, n2.home) < 0.8 || sim(n1.away, n2.away) < 0.8) continue;
    const bd = own.src === '北单' ? own : g2;
    const singles = bd.frames.filter(f => { const s = (f.pools || {}).spf; return s && Number(s.rq) === 0 && s.h && s.d && s.a; }).length;
    if (singles < 8) continue;
    cand.push([k2, b2]);
  }
  if (cand.length !== 1) continue;
  const [, other] = cand[0], jc = cur.jc || other.jc, bd = cur.bd || other.bd;
  const tid = cur.tid || other.tid, mi = cur.mi || other.mi;
  if (tid && ledgerTids.has(tid)) continue;   // 观察区不得触碰账本 tid
  const keepKey = tid ? 'T' + tid : k1;
  const merged = { ...cur, jc, bd, tid, mi, day: mi ? mi.mt.day : (cur.day || other.day),
    kick: mi ? mi.mt.kick_ts : jc.kick, home: jc.home, away: jc.away,
    league: jc.league || cur.league, scheduleConflict: !!(cur.scheduleConflict || other.scheduleConflict) };
  if (tid && keepKey !== k1 && wb.has(keepKey)) continue;
  wb.delete(k1); for (const [k2] of cand) wb.delete(k2);
  wb.set(keepKey, merged); watchBridged++;
}
const EU_ONLY_LG_OK = /欧国联|世界杯|欧洲杯|美洲杯|欧冠|欧联|英超|西甲|意甲|德甲|法甲|英冠|西乙|德乙|意乙|荷甲|葡超|友谊/;
const EU_ONLY_BAD = /U\d|女|后备|业余|青年|预备|B队|丙|丁/i;
for (const [tid, mt] of eu365Meta) {
  const g = eu365ByTid.get(tid);
  if (items[tid] || wb.has('T' + tid) || mt.conflict || !g || g.eu.length < 8 || mt.day < shiftDay(TODAY, -1) || mt.day > dayMax) continue;
  // 仅官方竞彩/北单范围：没有任何可靠官方快照认领的纯365比赛不进板块。
  const officialMatch = glist.some(x=>x.kick && Math.abs(x.kick-mt.kick_ts)<=10*60e3
    && leagueOK(x.league,mt.league) && sim(x.home,mt.home)>=0.8 && sim(x.away,mt.away)>=0.8);
  if (!officialMatch) continue;
  if (!EU_ONLY_LG_OK.test(mt.league) || EU_ONLY_BAD.test(mt.league + mt.home + mt.away)) continue;
  wb.set('T' + tid, { tid, day: mt.day, kick: mt.kick_ts, home: mt.home, away: mt.away, league: mt.league, jc: null, bd: null, mi: null, euOnly: true });
}
function scoreValue(v) {
  if ((typeof v !== 'number' && typeof v !== 'string') || !/^\d+$/.test(String(v))) return null;
  const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function resultIdentity(row, b) {
  const kick = epochMs(row.kickTs), home = row.home, away = row.away;
  return !!(kick && b.kick && home && away && row.league && b.league && row.day === b.day
    && Math.abs(kick - b.kick) <= 10 * 60e3 && wnorm(home) === wnorm(b.home) && wnorm(away) === wnorm(b.away)
    && sameIdentity(home, b.home) && sameIdentity(away, b.away) && leagueOK(row.league, b.league));
}
const RES_CACHE = F('_watch_sched_cache.json'), resCache = readJson(RES_CACHE, { days: {} });
resCache.days = resCache.days || {};
const needDays = new Set([...wb.values()].filter(b => b.tid && b.kick && b.kick < Date.now()).map(b => b.day));
function cacheAllDone(c) {
  const rows = c && c.rows && Object.values(c.rows);
  return !!(rows && rows.length && rows.every(r => String(r.state) === '-1' && scoreValue(r.hs) != null && scoreValue(r.as) != null
    && r.home && r.away && r.league && epochMs(r.kickTs) && r.day === dayOf(epochMs(r.kickTs))));
}
let cacheChanged = false;
if (process.env.TRI_OFFLINE !== '1') for (const d of needDays) {
  const c = resCache.days[d], age = c ? Date.now() - Number(c.fetchedAt || 0) : Infinity;
  if (age >= 0 && (age < 10 * 60e3 || (cacheAllDone(c) && age < 24 * 3600e3))) continue;
  try {
    const { execFileSync } = require('child_process');
    const txt = execFileSync('curl', ['-s', '--max-time', '12', '-A', 'Mozilla/5.0', '-e', 'https://m.gqj2.tv/',
      'https://api.gqj2.tv/getfootball_list?day=' + d + '&state=0'], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }).toString('utf8');
    const j = JSON.parse(txt); if (!Array.isArray(j.data) || !j.data.length) continue;
    const rows = {};
    for (const m of j.data) {
      const tid = String(m.tournament_id || ''); if (!tid) continue;
      const kickTs = epochMs(m.match_time_int) || tsOf(m.match_time) || dayKick(d, hhmmOf(m.match_time));
      rows[tid] = { state: m.state, hs: m.home_score, as: m.away_score,
        home: decode(m.home_name_zh), away: decode(m.away_name_zh), league: decode(m.league_name_zh), day: dayOf(kickTs), kickTs };
    }
    if (Object.keys(rows).length) { resCache.days[d] = { fetchedAt: Date.now(), rows }; cacheChanged = true; }
  } catch (_) { /* 外部赛果缺失时保留旧缓存，但不会自动信任其身份。 */ }
}
if (cacheChanged && process.env.TRI_DRY_RUN !== '1') fs.writeFileSync(RES_CACHE, JSON.stringify(resCache));
const attachCandidates = []; let nWatch = 0;
/* ★ 2026-11-20 观察区赛前方向冻结 sidecar（详见循环内注释） */
const FROZEN_FILE = F('watch_dir_frozen.json');
const frozenBook = readJson(FROZEN_FILE, { items: {} });
frozenBook.items = frozenBook.items || {};
let frozenDirty = false;
function _sgnOf(net) { return net > 1 ? 1 : (net < -1 ? -1 : 0); }
/* ★2026-11-20 用户："这里面每一场都有完整实时序列，为什么一场方向都不给/观察个鸡巴"。
   观察方向(watchDir)是只读观察档(watchOnly · statisticsEligible=false · 不下注指令)，
   门槛不应照搬正式账本的"两端交叉验证"。原门槛 status.ok && Math.max(pos,neg)>=2
   把全部单端场(北单172帧等)挡在门外——这是"有数据不分析"的真根因。
   现放宽：未开赛 + 有①完整序列(n>=20帧)②明确有符号净Δ(|net|>=8pp)的端 → 冻结观察方向。
   语义沿用项目已上线的"反北单净Δ"观察档：资金推强方(dom>0)→站对面买弱方(weak)；
   资金撤强方(dom<0)→买强方(strong)。全程标注单端观察·不作下注依据·不进任何业绩。
   ★ 正式账本入围门槛(ends>=2)一字未动——单端方向留出段证伪，绝不进引擎/ROI。 */
function _watchDirBuild(key, b, seg, status, strongIdx, res) {
  const nowMs = Date.now(), notYet = !!(b.kick && b.kick > nowMs);
  const signs = (status && status.align && status.align.signs) || [];
  const pos = signs.filter(s => s > 0).length, neg = signs.filter(s => s < 0).length;
  const dom = pos > neg ? 1 : (neg > pos ? -1 : 0);
  const sameN = (status && status.align && status.align.same) || 0;
  const MIN_N = 20, MIN_NET = 8; // 完整序列帧数下限 + 明确净Δ下限(pp)
  if (notYet && dom !== 0) {
    const ends = ['jc', 'bd', 'eu'].map(k => seg[k]).filter(v => v && v.ok && Number.isFinite(v.net));
    const valid = ends.filter(v => (v.n || 0) >= MIN_N && Math.abs(v.net) >= MIN_NET);
    const domNets = valid.filter(v => _sgnOf(v.net) === dom).map(v => v.net);
    if (domNets.length >= 1) {
      const netNow = +(domNets.reduce((s, x) => s + x, 0) / domNets.length).toFixed(2);
      const side = dom > 0 ? 'weak' : 'strong'; // 推强方→站对面买弱方；撤强方→买强方
      const nEnds = valid.length;
      const fr = frozenBook.items[key];
      const nowISO = new Date().toISOString();
      const usable = v => v === 'weak' || v === 'strong';
      if (!fr) {
        frozenBook.items[key] = { side, home: b.home, away: b.away, day: b.day, kick: b.kick, strongIdx,
          frozenAt: nowISO, firstFrozenAt: nowISO, netAtFreeze: netNow, sameN, nEnds,
          lead: (status.align.lead || null), flips: [] };
        frozenDirty = true;
      } else if (!usable(fr.side)) {
        /* ★2026-11-21：旧版 sidecar 里的 fade/旧档是不可执行方向，后续几十次强翻转
           全被"首冻结不推翻"锁死（例：特鲁瓦vs勒阿弗尔，3端31/293/436帧、同向2/3、
           fade 冻结后 20 次 strong -25pp，页面仍写"不出方向"）。这类旧值不是有效冻结，
           必须在赛前按当前同一 Δ 口径重定方向；保留原值与全部翻转史供审计。 */
        const flips = fr.flips || [];
        flips.push({ at: nowISO, side, net: netNow, reFreeze: true });
        Object.assign(fr, { side, netAtFreeze: netNow, sameN, nEnds,
          frozenAt: nowISO, firstFrozenAt: fr.firstFrozenAt || fr.frozenAt || nowISO,
          reFrozenAt: nowISO, reFrozenFrom: fr.side, reFrozenReason: 'legacy-unusable-side',
          lead: (status.align.lead || fr.lead || null), flips });
        frozenDirty = true;
      } else if (fr.side !== side) {
        const flips = (fr.flips = fr.flips || []);
        flips.push({ at: nowISO, side, net: netNow });
        /* 赛前持续同向翻转 (>=2 次) 或净Δ显著放大且已两端确认 → 重定方向，仍只发生在开赛前。
           单次抖动不翻，避免临盘来回改向；翻转史全部保留。 */
        const tail = flips.slice(-3).filter(f => f.side === side).length;
        const stronger = nEnds >= 2 && Math.abs(netNow) >= Math.max(20, Math.abs(+fr.netAtFreeze || 0) * 1.5);
        if (tail >= 2 || stronger) {
          Object.assign(fr, { side, netAtFreeze: netNow, sameN, nEnds,
            frozenAt: nowISO, firstFrozenAt: fr.firstFrozenAt || fr.frozenAt || nowISO,
            reFrozenAt: nowISO, reFrozenFrom: fr.side === side ? null : fr.side,
            reFrozenReason: tail >= 2 ? 'sustained-prekick-flip' : 'stronger-two-end-prekick',
            lead: (status.align.lead || fr.lead || null) });
        }
        frozenDirty = true; // 翻转始终记录；满足持续证据才重定
      }
    }
  }
  const fr = frozenBook.items[key];
  if (!fr) return null;
  const out = { side: fr.side, frozenAt: fr.frozenAt, firstFrozenAt: fr.firstFrozenAt || fr.frozenAt || null,
    reFrozenAt: fr.reFrozenAt || null, reFrozenFrom: fr.reFrozenFrom || null, reFrozenReason: fr.reFrozenReason || null,
    netAtFreeze: fr.netAtFreeze, sameN: fr.sameN,
    nEnds: fr.nEnds || 1, lead: fr.lead || null, flips: fr.flips || [], watchOnly: true };
  if ((fr.side === 'weak' || fr.side === 'strong') && res && res.verified === true && res.hs != null && res.as != null) {
    const strongIsHome = fr.strongIdx !== 2;
    const pickHome = fr.side === 'strong' ? strongIsHome : !strongIsHome; // strong=买强方; weak=买弱方
    out.chk = { hit: pickHome ? res.hs > res.as : res.as > res.hs, hs: res.hs, as: res.as,
      pick: pickHome ? '主' : '客', note: '观察方向独赢核对·单场展示不入任何统计' };
  }
  return out;
}
/* ★★★ 2026-11-21 A+B 临盘分区闸门（用户选 A+B）
   A（治本·入账新鲜度）：入临盘方向账本必须"真临盘"——至少一个有效独赢端的末帧距开赛≤120分钟；
     旧口径只看 ends>=2+未开赛，导致 24 场入账里 23 场末帧>2h（中位1.1天），而真临盘场被挡。
   B（治标·展示放行）：真临盘强信号若因"已开赛/单端/冻结时还没临盘帧"错过入账，仍按正式方向展示，
     但只做单场核对，绝不补进业绩分母（守住赛前冻结、不事后回填铁律）。
   ★ 决策口径：promoted=可入账（A+原 ends>=2+未开赛+方向）；
     promotedDisplay=可展示方向（promoted 或 B 展示放行）；displayOnly=B 放行但未入账。 */
const LATE_FRESH_MIN = 120;
function _abGate(x, nowMs, tsFn, sgnFn) {
  const ends = ['jc', 'bd', 'eu'].map(k => {
    const v = x.seg && x.seg[k];
    return v && v.ok && Number.isFinite(v.net) && v.t1 ? { k, t: tsFn(v.t1), n: +v.n || 0, net: +v.net } : null;
  }).filter(Boolean).filter(v => v.t > 0 && x.kickTs && v.t < x.kickTs);
  ends.sort((a, b) => b.t - a.t);
  const best = ends[0] || null;
  const gapMin = best ? Math.round((x.kickTs - best.t) / 60000) : null;
  const fresh = !!(best && gapMin >= 0 && gapMin <= LATE_FRESH_MIN);
  const signs = (x.align && x.align.signs) || [];
  const pos = signs.filter(s => s > 0).length, neg = signs.filter(s => s < 0).length;
  const dom = pos > neg ? 1 : (neg > pos ? -1 : 0);
  const valid = ends.filter(v => v.n >= 20 && Math.abs(v.net) >= 8);
  const domNets = dom ? valid.filter(v => sgnFn(v.net) === dom).map(v => v.net) : [];
  // 冻结 sidecar 没赶上的已开赛场：用同一数据口径现算展示方向，只入 displayOnly，不写冻结文件。
  let dir = x.watchDir || null, computed = false;
  if (!dir && dom && domNets.length) {
    dir = { side: dom > 0 ? 'weak' : 'strong', frozenAt: null,
      netAtFreeze: +(domNets.reduce((s, v) => s + v, 0) / domNets.length).toFixed(2),
      sameN: (x.align && x.align.same) || 0, nEnds: valid.length,
      lead: (x.align && x.align.lead) || null, flips: [], watchOnly: true, displayComputed: true };
    computed = true;
  }
  const sideOk = !!(dir && (dir.side === 'weak' || dir.side === 'strong'));
  const preKick = !!(x.kickTs && x.kickTs > nowMs);
  const nEnds = (x.flags && x.flags.nSrc) || ends.length;
  const promoted = !!(fresh && preKick && x.ok && nEnds >= 2 && sideOk);
  const displayOnly = !!(fresh && sideOk && !promoted);
  const why = promoted ? '' : (!fresh ? '无真临盘(末帧>' + LATE_FRESH_MIN + '分钟)·不入围'
    : displayOnly ? (preKick ? '单端真临盘·展示核对不入账' : '已开赛真临盘强信号·展示核对不入账') : '无明确方向');
  return { dir, computed, promoted, promotedDisplay: !!(promoted || displayOnly), displayOnly,
    fresh, gapMin, end: best && best.k, why };
}
for (const [key, b] of wb) {
  const mt = b.tid ? eu365Meta.get(b.tid) : null, conflict = !!(b.scheduleConflict || (mt && mt.conflict));
  const g = b.tid && !conflict ? eu365ByTid.get(b.tid) : null;
  const sg = g ? { eu: preFrames(g.eu, b.kick), asia: preFrames(g.asia, b.kick) } : null;
  let strongIdx = 0, strongNote = '';
  if (sg && sg.asia.length && sg.asia[0].hcap !== 0) strongIdx = sg.asia[0].hcap > 0 ? 0 : 2;
  else if (sg && sg.eu.length) { strongIdx = sg.eu[0].p[0] >= sg.eu[0].p[2] ? 0 : 2; strongNote = '欧赔首帧定强弱'; }
  else strongNote = '无365·默认主强仅供读数';
  const seg = buildSegments(b, sg, strongIdx, b.kick, []), status = alignSegments(seg, b.kick, conflict);
  const reasons = [];
  if (!b.tid) reasons.push('工程待核：官方身份尚未可靠关联365');
  if (b.tid && seg.bd && seg.bd.ok && seg.eu && seg.eu.ok) reasons.push('两盘序列可用·账本登记链未收录（不是无法分析）');
  else if (b.tid) reasons.push('序列观察补录·不进方向业绩');
  if (b.bd && seg.rq && !(seg.bd && seg.bd.n)) reasons.push('玩法限制：北单仅让球；可读让球走势，不可减365独赢');
  if (!b.bd) reasons.push('该比赛未取得北单快照（待核售卖/采集）');
  if (!b.jc) reasons.push('该比赛未取得竞彩快照（不等于365缺失）');
  if (b.jc && !(seg.jc && seg.jc.n)) reasons.push('竞彩独赢为空或无有效赛前帧');
  if (!b.kick) reasons.push('无可靠开赛时间');
  if (conflict) reasons.push('赛程冲突·不可结算');
  if (b.euOnly) reasons.push('竞彩北单均未在售·仅365');
  if (strongNote) reasons.push(strongNote);
  if (ledgerTids.has(b.tid)) { attachCandidates.push({ tid: b.tid, key, jc: !!b.jc, bd: !!b.bd, attached: [], isolated: true }); continue; }
  const c = resCache.days[b.day], row = b.tid && c && c.rows && c.rows[b.tid];
  let res = null;
  if (row && String(row.state) === '-1' && scoreValue(row.hs) != null && scoreValue(row.as) != null
    && !conflict && resultIdentity(row, b)) {
    res = { hs: scoreValue(row.hs), as: scoreValue(row.as), verified: true, external: true,
      note: '身份核对通过的外部完场比分·不结算亚盘' };
  }
  assert(!ledgerTids.has(key), '观察 key 不得命中任何账本 tid');
  /* ★ 2026-11-21 观察区赛前方向冻结（用户："有数据不分析"）：
     bake 被 567 封禁冻结 → 新场进不了账本 → 全部掉观察区"不进方向业绩"。
     但观察区序列是活的（本地采集+球探备源），未开赛场完全来得及做**赛前**方向冻结。
     口径与铁律真信号一致：各端有符号Δ(sgn net) + 同向数(align.same>=2) + 先动(lead)。
     资金合流强队方(主导符号+1) → 站对面买弱方独赢（与过热板块"真合流买受让"同语义）；
     资金撤强队方(主导-1) → 只标"背离观察"，不出方向（无标定支持追弱队资金）。
     冻结纪律（与账本"赛前冻结、赛后不改"一致）：
     - sidecar watch_dir_frozen.json 只增不覆：首冻结 side 永不推翻；
     - 方向翻转只记 flips（观察卡标⚠），不覆盖；
     - 开赛后不再新增冻结；赛后核对只做单场展示，不进任何命中/ROI 汇总。 */
  const dirFrozen = _watchDirBuild(key, b, seg, status, strongIdx, res);
  /* ★2026-11-21 A+B 临盘入围：A=真临盘(末帧≤120分)才入账；B=已开赛/单端错过的真临盘强信号仍正式展示核对。
     ★ 入账去向是独立的【临盘方向账本 linpan_ledger.json】(独赢口径)，不是 fundplate_history(亚盘让球口径)；
       后者两套结算语义混算会把胜负判反、污染 555 条已验证历史。见下方账本块。 */
  const ab = _abGate({ kickTs: b.kick, ok: status.ok, flags: status.flags, seg, align: status.align, watchDir: dirFrozen },
    Date.now(), tsOf, _sgnOf);
  const dirBuilt = ab.dir;
  const promoted = ab.promoted;
  items[key] = { day: b.day, kickoff: b.kick ? new Date(b.kick + 8 * 3600e3).toISOString().slice(11, 16) : '', kickTs: b.kick,
    home: b.home, away: b.away, league: b.league, noJc: b.jc ? String(b.jc.no || '') : '', noBd: b.bd ? String(b.bd.no || '') : '',
    watch: true, promoted, promotedDisplay: ab.promotedDisplay, displayOnly: ab.displayOnly,
    late: { fresh: ab.fresh, gapMin: ab.gapMin, end: ab.end, why: ab.why, computed: ab.computed },
    watchWhy: reasons.join('；'), tid: b.tid, originalTid: b.tid, statisticsEligible: false, settlementEligible: false,
    matchInfo: b.mi ? { score: b.mi.score, timeEq: b.mi.timeEq, sh: b.mi.sh, sa: b.mi.sa, kickDiffMin: b.mi.kickDiffMin } : null,
    strongIdx, seg, ...status, res, watchDir: dirBuilt };
  nWatch++;
}
assert.equal(JSON.stringify(Object.fromEntries(Object.entries(items).filter(([, v]) => !v.watch))), ledgerSnapshot, '观察区污染原账本轨迹');
let nWatchDir = 0, nWatchDirWeak = 0, nPromoted = 0;
for (const [key, it] of Object.entries(items)) if (it.watch) {
  assert(!ledgerTids.has(key) && it.statisticsEligible === false && it.settlementEligible === false);
  if (it.promoted) {
    // ★2026-11-20 用户改判"把观察区有方向的放进去入账"：promoted 现在进【独立临盘方向账本】(独赢口径)，
    //   但 statisticsEligible/settlementEligible 仍为 false —— 这两个标志专指【亚盘让球账本/fundplate】，
    //   绝不能因入临盘账本就翻成 true，否则混算把亚盘业绩污染。语义见 linpan_ledger.json 块。
    assert(it.statisticsEligible === false && it.settlementEligible === false, 'promoted 不得进亚盘让球账本统计');
    assert(it.ok === true && it.watchDir && ['weak', 'strong'].indexOf(it.watchDir.side) >= 0, 'promoted 必须序列齐且有明确方向');
    assert(it.late && it.late.fresh === true, 'A门：promoted 必须有真临盘末帧(≤120分)');
    assert(it.displayOnly !== true, 'promoted 与 displayOnly 互斥');
    nPromoted++;
  }
  assert(!it.res || (it.res.verified === true && scoreValue(it.res.hs) != null && scoreValue(it.res.as) != null
    && !['verdict', 'ahLine', 'um'].some(k => Object.hasOwn(it.res, k))), '观察区只允许已核验合法比分');
  if (it.watchDir) {
    assert(it.watchDir.watchOnly === true && it.statisticsEligible === false, '观察方向不得进任何业绩统计');
    assert(['weak', 'strong', 'fade'].indexOf(it.watchDir.side) >= 0, '观察方向 side 只允许 weak/strong/fade');
    nWatchDir++; if (it.watchDir.side === 'weak') nWatchDirWeak++;
  }
}
for (const f of retainedFrames) {
  audit.retained[f.kind]++;
  if (!f.kick) audit.unknownKickRetained++;
  if (!(f.ts > 0 && f.ep > 0 && f.ts < f.kick && f.ep < f.kick)) audit.postKickRetained++;
  if (postPhase(f)) audit.phaseRetained++;
}
assert.equal(audit.postKickRetained, 0, '实际保留帧存在赛后或无效时间');
assert.equal(audit.phaseRetained, 0, '实际保留帧存在赛后 phase');
assert.equal(audit.unknownKickRetained, 0, '实际保留帧缺可靠 kick');

/* ★★★ 2026-11-20 独立【临盘方向账本】linpan_ledger.json（用户："把观察区有方向的放进去入账，赛前临盘不符合再剔除"）。
   为什么必须独立账本、绝不并入 fundplate_history / dir_ledger：
     · fundplate_history = 亚盘让球口径，结算 underMargin=(受让进球+|hcap|)−让球方进球，方向 recDir=买强队/买受让；
     · dir_ledger = 买强队/买受让的样本外账本，同样亚盘口径；
     · 观察区 watchDir = 独赢口径：weak=站对面买弱方独赢 / strong=买强方独赢，结算直接用真实比分 hs/as；
   三者结算语义不同，混算会把胜负判反、污染 555 条已验证的历史 → 物理隔离，独立前向账本。
   纪律（对齐项目"赛前冻结、赛后不改、不事后回填"铁律）：
     ① 只收 promoted（A门真临盘末帧≤120分 + 序列齐 ends>=2 + 明确方向 weak/strong + 未开赛）的场次；B 展示放行不进分母；
     ② 首入账冻结 {side, pickHome, strongIdx, netAtFreeze, 真实盘口/水位} 快照，算法改版不回写；
     ③ 赛前若方向翻转(watchDir.flips 增加) / 序列由 ok 转不齐 / 来源被撤 → state='dropped'，剔除出业绩分母（留痕，不物理删除）；
     ④ 开赛即冻结，赛后不再改方向；⑤ 赛后用已核验独赢比分结算一次，已结算不覆盖；
     ⑥ 统计带 n/命中/ROI/±SE，按 side 分组，小样本不宣称显著。 */
const LL_FILE = F('linpan_ledger.json');
const llBook = readJson(LL_FILE, { v: 1, items: {}, summary: {} });
llBook.items = llBook.items || {};
let llNew = 0, llDrop = 0, llSettle = 0;
const LL_NOW = Date.now();
for (const [key, it] of Object.entries(items)) {
  if (!it.watch || !it.watchDir) continue;
  const wd = it.watchDir;
  if (['weak', 'strong'].indexOf(wd.side) < 0) continue;
  const preKick = !!(it.kickTs && it.kickTs > LL_NOW);
  const flipsN = (wd.flips || []).length;
  const rec = llBook.items[key];
  if (!rec) {
    // 首次入账：必须当前 promoted（序列齐+方向明确+未开赛）；历史已完场场不事后回填。
    if (!it.promoted || !preKick) continue;
    const strongIsHome = it.strongIdx !== 2;
    const pickHome = wd.side === 'strong' ? strongIsHome : !strongIsHome;
    const eu = it.seg && it.seg.eu;
    const jc = it.seg && it.seg.jc;
    llBook.items[key] = {
      key, tid: it.tid || null, day: it.day, kickoff: it.kickoff, kickTs: it.kickTs,
      home: it.home, away: it.away, league: it.league,
      side: wd.side, pickHome, pick: pickHome ? '主' : '客', strongIdx: it.strongIdx,
      frozenAt: wd.frozenAt, enrollAt: new Date().toISOString(),
      netAtFreeze: wd.netAtFreeze, sameN: wd.sameN, nEnds: wd.nEnds, lead: wd.lead || null,
      flipsAtEnroll: flipsN,
      // 独赢赔率快照：用 365 收盘隐含概率反推（close=[主,平,客] 百分比），无则 null（ROI 该场不计）
      odds: (eu && eu.ok && Array.isArray(eu.close) && eu.close.length === 3 && pickHome ? eu.close[0] : null)
        || (eu && eu.ok && Array.isArray(eu.close) && eu.close.length === 3 && !pickHome ? eu.close[2] : null),
      oddsPct: true, oddsSrc: '365收盘隐含概率%',
      euClose: eu && eu.ok ? eu.close : null, jcClose: jc && jc.ok ? jc.close : null,
      freshWindowMin: it.late && it.late.gapMin, lateEnd: it.late && it.late.end,
      state: 'active', result: null, whyDrop: null
    };
    llNew++;
  } else {
    // 已入账：赛前复核是否符合；开赛后不再剔除（冻结）
    if (rec.state === 'active' && preKick) {
      let why = null;
      if (flipsN > (rec.flipsAtEnroll || 0)) why = '赛前方向翻转(' + wd.side + ')';
      /* ★★ 2026-11-23 严重逻辑错误修复（临盘账本 17/22 被 dropped、用户看不到结算）：
         旧条件 `it.late.fresh === false` 会在【每一次 15 分钟重建】时重新计算"末帧距开赛"。
         赛前冻结之后，末帧不再更新是常态 → gapMin 单调增大 → 过了 120 分就必然判不新鲜
         → 已入账的场被自己剔除。这不是"新鲜度不达标"，是时间自然流逝。
         正确口径：新鲜度只在【首入账】时判定一次（promoted 门已经做了）；入账后只有
         「有效端真的消失（来源被撤）」才 drop。绝不因时间推移 drop 已冻结的方向。 */
      else if (it.late && it.late.end == null && !it.ok) why = '赛前临盘端消失(来源被撤)';
      else if (!it.promoted && !it.ok) why = '赛前序列由齐转不齐';
      else if (wd.side !== rec.side) why = '赛前方向改变(' + rec.side + '→' + wd.side + ')';
      if (why) { rec.state = 'dropped'; rec.whyDrop = why; rec.dropAt = new Date().toISOString(); llDrop++; }
    }
    // 赛后结算：已核验真实比分 + 已开赛 → 独赢胜负（只结算一次）
    if (rec.state === 'active' && it.kickTs && it.kickTs <= LL_NOW && it.res && it.res.verified === true
        && scoreValue(it.res.hs) != null && scoreValue(it.res.as) != null && rec.result == null) {
      const hs = scoreValue(it.res.hs), as = scoreValue(it.res.as);
      rec.result = rec.pickHome ? (hs > as ? 'win' : (hs === as ? 'draw' : 'lose'))
                                : (as > hs ? 'win' : (as === hs ? 'draw' : 'lose'));
      rec.hs = hs; rec.as = as; rec.settleAt = new Date().toISOString(); llSettle++;
    }
  }
}
// 汇总：命中/ROI/±SE，只算 active 且已结算（dropped 剔除出分母）
function _llAgg(arr) {
  const decided = arr.filter(e => e.result === 'win' || e.result === 'lose'); // 平局不计命中分母
  const n = decided.length, w = decided.filter(e => e.result === 'win').length, l = n - w;
  let pl = 0, nOdds = 0;
  for (const e of decided) {
    // odds 存的是 365 收盘【隐含概率百分比】(如 14.655%)，十进制赔率 = 100/p（如 6.82）；
    // 赢 +（赔率−1）= +(100/p−1)，输 −1。★曾误写 odds/100−1 会把 ROI 算反，此处已修。
    if (e.odds != null && +e.odds > 0 && +e.odds < 100) { nOdds++; pl += (e.result === 'win' ? (100 / (+e.odds) - 1) : -1); }
  }
  const hit = n ? w / n : 0;
  return { n, w, l, draw: arr.filter(e => e.result === 'draw').length,
    hit: n ? +(hit * 100).toFixed(1) : null,
    roi: nOdds ? +(pl / nOdds * 100).toFixed(1) : null, nOdds,
    se: n ? +(Math.sqrt(hit * (1 - hit) / n) * 100).toFixed(1) : null,
    significant: n >= 4 && hit > 0 && Math.abs(hit - 1 / 2) > 1.96 * Math.sqrt(hit * (1 - hit) / n) };
}
const llActive = Object.values(llBook.items).filter(e => e.state === 'active');
const llDropped = Object.values(llBook.items).filter(e => e.state === 'dropped');
llBook.summary = {
  updatedAt: new Date().toISOString(), v: 1,
  total: Object.values(llBook.items).length, active: llActive.length, dropped: llDropped.length,
  settled: llActive.filter(e => e.result != null).length, pending: llActive.filter(e => e.result == null).length,
  all: _llAgg(llActive),
  bySide: { weak: _llAgg(llActive.filter(e => e.side === 'weak')), strong: _llAgg(llActive.filter(e => e.side === 'strong')) },
  note: '独立临盘方向账本·独赢口径(weak买弱方/strong买强方)·A+B门(末帧≤120分才入账/真临盘强信号展示核对不入分母)；与 fundplate_history(亚盘让球)物理隔离不可混算；赛前不符合剔除、开赛冻结、赛后只结算一次。'
};
if (process.env.TRI_DRY_RUN !== '1') fs.writeFileSync(LL_FILE, JSON.stringify(llBook));
console.log('[linpan_ledger] 入账+' + llNew + ' 赛前剔除+' + llDrop + ' 赛后结算+' + llSettle
  + ' | 在场' + llActive.length + ' 剔除' + llDropped.length
  + ' 已结算' + llBook.summary.settled + ' 命中' + llBook.summary.all.hit + ' ROI' + llBook.summary.all.roi);

const coverage = {};
for (const [name, rows] of [['ledger', Object.values(items).filter(x => !x.watch)], ['watch', Object.values(items).filter(x => x.watch)]]) {
  coverage[name] = { n: rows.length, ok: rows.filter(x => x.ok).length,
    promoted: rows.filter(x => x.promoted).length, displayOnly: rows.filter(x => x.displayOnly).length,
    freshLate: rows.filter(x => x.late && x.late.fresh).length,
    jcOk: rows.filter(x => x.flags.jcOk).length, bdOk: rows.filter(x => x.flags.bdOk).length, euOk: rows.filter(x => x.flags.euOk).length,
    rq: rows.filter(x => x.seg.rq).length, unknownKick: rows.filter(x => !x.kickTs).length,
    unmatched: rows.filter(x => x.watch && !x.tid).length, verifiedScores: rows.filter(x => x.res && x.res.verified).length,
    pendingScores: rows.filter(x => x.res && !x.res.verified).length };
}
const out = { generated: new Date().toISOString(), v: 3,
  source: '赛前快照 + Bet365真实逐帧 / 仅Bet365.c回退；watch独立键隔离', eu365Dir: EU365_DIRS.join(' + ') || null,
  eu365Files, eu365Frames, eu365PostKick, eu365Bad, eu365Tids: eu365ByTid.size,
  metadataConflicts: [...eu365Meta.values()].filter(x => x.conflict).length,
  snapDir: SNAP_DIR, snapFiles: snapFiles.length, lines, badLines, histN: hist.length, n: nWithAny, nOk, nRqOnly,
  nWatch, watchBridged, nWatchDir, nWatchDirWeak, nPromoted, llNew, llDrop, llSettle, attachCandidates, coverage, audit,
  euByNoHit, euByNoAmbig, euByNameHit, euByNameAmbig, pairDiag, saleNoIdxSize: saleNoIdx.size, items };
/* ★ 2026-11-22 dry-run 诊断：把本次构建结果另存到独立文件，供 A/B 精确对比
   （开了/关了官方编号直配，哪些场从"缺365"变成"有365"、ok/zero-regression）。
   只写显式指定的 TRI_DIAG_OUT，绝不碰 tri_trail.json 等权威产物。 */
if (process.env.TRI_DIAG_OUT) {
  try { fs.writeFileSync(process.env.TRI_DIAG_OUT, JSON.stringify(out)); } catch (e) { console.warn('[tri_trail] diag写失败', e.message); }
}
if (process.env.TRI_DRY_RUN !== '1') {
  if (frozenDirty) fs.writeFileSync(FROZEN_FILE, JSON.stringify(frozenBook));
  fs.writeFileSync(F('tri_trail.json'), JSON.stringify(out));
}
console.log('[tri_trail] coverage=' + JSON.stringify(coverage));
console.log('[tri_trail] audit=' + JSON.stringify(audit));
console.log('[tri_trail] 账本隔离断言通过；postKick实际保留=0；metadataConflicts=' + out.metadataConflicts + (process.env.TRI_DRY_RUN === '1' ? '；只读试构建' : ' -> ' + F('tri_trail.json')));
