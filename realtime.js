


















/* realtime.js — 实时分析调度器 + 实时汇总面板（增量模块）
 *
 * 接入：在 ui.js 的 init() 末尾调用 startRealtime() 即可
 *
 * 设计：
 *   - 调度：未开赛(state=0)每 60s 重算，进行中(state=1/2/3)每 30s 重算，完场冻结
 *   - 并发：每批 6 个（已验证源站零限流，留余量给浏览器同时请求多个域）
 *   - 失败：单场失败仅记录，不影响其他
 *   - 汇总：每次 render() 后调 renderSummary() 重算 4 个汇总卡片
 */
'use strict';

/* ---------- 调度器 ---------- */
const SCHED = {
  running: false,
  pool: 6,                    // 并发
  batchInit: 150,             // 首次全量：一次最多处理 150 场（源站零限流，快速铺满）
  batchTick: 60,              // 定增增量：每轮最多 60 场（按"最久未分析"优先）
  timers: [],                 // setInterval 句柄
  progress: { done: 0, total: 0, errors: 0, lastTick: 0 },
  // 单场上次分析时间（避免过于频繁重算同场）
  lastAnalyzed: new Map(),
  // 单场最近错误（MATCHES 会被 loadMatches 重建，故错误存这里而非挂在对象上）
  errors: new Map(),
  initDone: false,
  ticking: false             // 防重入锁
};
function shouldAnalyze(m){
  // 完场不重算
  if (m.state === '-1') return false;
  const last = SCHED.lastAnalyzed.get(m.tid) || 0;
  // 上次失败（多为源站暂无盘口/已下架）→ 5 分钟才重试一次，避免空转刷屏
  if (SCHED.errors && SCHED.errors.has(m.tid)) return Date.now() - last >= 300000;
  // 已分析的：进行中 30s 周期，未开赛 60s 周期——> 距上次 25s 内不重算
  const minGap = isLive(m.state) ? 25000 : 55000;
  return Date.now() - last >= minGap;
}
async function analyzeInBackground(m){
  try{
    // force=true：强制重拉最新盘口（亚盘/欧赔/大小球），实现真·实时赔率更新
    // （analysis 交锋/排名/伤停 由 getAnalysisCached 内部 5 分钟缓存，省请求）
    await analyzeMatch(m, true);
    SCHED.errors.delete(m.tid);
  }catch(e){
    SCHED.errors.set(m.tid, e.message || '分析失败');
    SCHED.progress.errors++;
  }
  SCHED.lastAnalyzed.set(m.tid, Date.now());
  SCHED.progress.done++;
  m._aErr = SCHED.errors.get(m.tid) || null;    // 供当次渲染显示
}
async function runBatch(matches, label){
  if (!matches.length) return;
  SCHED.progress.total += matches.length;
  let i = 0;
  async function worker(){
    while(i < matches.length){
      const m = matches[i++];
      if (!m) break;
      await analyzeInBackground(m);
      if ((SCHED.progress.done & 7) === 0) updateSchedStatus(label);   // 每 8 场刷一次状态，减少 DOM 抖动
    }
  }
  await Promise.all(Array.from({length: Math.min(SCHED.pool, matches.length)}, worker));
}
function updateSchedStatus(label){
  const upd = $('upd'); if (!upd) return;
  const now = new Date().toLocaleTimeString('zh-CN');
  const p = SCHED.progress;
  const pending = Math.max(0, p.total - p.done);
  if (p.total > 0 && pending > 0){
    upd.textContent = `${now} · 实时分析 ${label} · ${p.done}/${p.total}${p.errors?` · 失败${p.errors}`:''}`;
  }
}
async function tickRealtime(reason){
  if (SOURCE.state === 'offline') return;
  if (!$('rtAuto') || !$('rtAuto').checked) return;
  if (SCHED.ticking) return;                 // 防重入：上一轮未跑完时跳过本次触发
  SCHED.ticking = true;
  try{
    const isInit = (reason === 'init') && !SCHED.initDone;
    if (isInit){
      // 首次全量：连续多批铺满所有"进行中+未开赛"，不设 30s 间隔（源站零限流）
      let guard = 0;
      while (guard++ < 30){
        const stale = MATCHES.filter(m => shouldAnalyze(m))
          .sort((a,b)=> (SCHED.lastAnalyzed.get(a.tid)||0) - (SCHED.lastAnalyzed.get(b.tid)||0));
        if (!stale.length) break;
        const batch = stale.slice(0, SCHED.batchInit);
        SCHED.progress = { done: 0, total: batch.length, errors: 0, lastTick: Date.now() };
        updateSchedStatus('首次全量');
        await runBatch(batch, '首次全量');
        safeRender();
      }
      SCHED.initDone = true;
    } else {
      // 定时增量：按"最久未分析"优先，每轮最多 batchTick 场
      const stale = MATCHES.filter(m => shouldAnalyze(m))
        .sort((a,b)=> (SCHED.lastAnalyzed.get(a.tid)||0) - (SCHED.lastAnalyzed.get(b.tid)||0));
      const targets = stale.slice(0, SCHED.batchTick);
      if (!targets.length) return;
      SCHED.progress = { done: 0, total: targets.length, errors: 0, lastTick: Date.now() };
      updateSchedStatus('定时增量');
      await runBatch(targets, '定时增量');
      safeRender();
    }
    const upd = $('upd');
    if (upd){
      const errN = SCHED.errors.size;
      const pending = MATCHES.filter(m => m.state !== '-1' && !SCHED.lastAnalyzed.has(m.tid)).length;
      upd.textContent = `${new Date().toLocaleTimeString('zh-CN')} · 实时分析 ▸ 已覆盖 ${SCHED.lastAnalyzed.size}/${MATCHES.length} 场`
        + (pending ? ` · 待分析 ${pending}` : ' · 全部已覆盖')
        + (errN ? ` · 无盘口/失败 ${errN}` : '');
    }
  } finally {
    SCHED.ticking = false;
  }
}
/* 安全重绘：用户有输入焦点时跳过（避免清空正在填的投注占比/战意/搜索），
   并保留滚动位置。用户主动触发的 render() 不受影响。 */
function safeRender(){
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')){
    return;   // 用户正在操作 → 不打断
  }
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  render();
  window.scrollTo(0, y);
}
function startRealtime(){
  if (SCHED.running) return;
  SCHED.running = true;
  // 首次：等比赛列表到位后启动（最多等 20s；有数据即开始，不空转）
  let waited = 0;
  const kick = ()=>{
    if (MATCHES.length){ tickRealtime('init'); return; }
    if (waited >= 20000){ tickRealtime('init'); return; }   // 兜底：20s 后无论如何试一次
    waited += 500; setTimeout(kick, 500);
  };
  setTimeout(kick, 800);
  // 定时增量：每 30s 触发一次，由 shouldAnalyze 决定哪些要重算
  SCHED.timers.push(setInterval(()=>{ if (!document.hidden) refreshNearKickoff(6); }, 120000));
  SCHED.timers.push(setInterval(()=> tickRealtime('periodic'), 30000));
  // 页面可见性恢复时立即跑一次（避免后台错过刷新）
  document.addEventListener('visibilitychange', ()=>{
    if (!document.hidden && $('rtAuto') && $('rtAuto').checked){
      tickRealtime('resume');
    }
  });
}
function stopRealtime(){
  SCHED.timers.forEach(t => clearInterval(t));
  SCHED.timers = [];
  SCHED.running = false;
}

/* ---------- 汇总面板（4 卡片：Top 价值 / 信号分布 / 命中率 / 联赛热度）---------- */
function sumTopValue(){
  // 按价值分降序取 Top 10（只取已分析）
  const arr = MATCHES.filter(m => m.analysis && m.state !== '-1')
    .map(m => ({
      t: `${m.home} vs ${m.away}`,
      v: Math.round(m.analysis.value_score || 0),
      d: m.analysis.dir,
      lg: m.league,
      c: Math.round(m.analysis.conf || 0),
      tid: m.tid,
      st: m.state
    }))
    .sort((a,b)=> b.v - a.v)
    .slice(0, 10);
  if (!arr.length) return '<p class="note">尚未有分析结果（实时分析启动后 1~2 分钟内填充）</p>';
  const color = v => v >= 70 ? '#e54545' : v >= 50 ? '#ff7a3c' : '#8b98a9';
  return '<ol class="sum-ol">' + arr.map(x =>
    `<li onclick="gotoMatch(${x.tid})" title="点击直达该场分析" style="cursor:pointer"><span class="v" style="color:${color(x.v)}">${x.v}</span><span class="lg">${x.lg||''}</span><span class="t">${x.t}</span><span class="d">${labelWDL(x.d)}${x.c?` · conf${x.c}`:''}${x.st==='1'||x.st==='2'||x.st==='3'?' 🔴':''}</span></li>`
  ).join('') + '</ol>';
}
function sumSigDist(){
  // 信号分布：按 W/D/L + 信号类型
  const buckets = { '盘型W':{n:0,h:0}, '盘水W':{n:0,h:0}, '流向L':{n:0,h:0}, 'betfa主':{n:0,h:0}, 'betfa客':{n:0,h:0} };
  const stats = { total: 0, w: 0, d: 0, l: 0, skip: 0 };
  for (const m of MATCHES){
    if (!m.analysis) continue;
    stats.total++;
    // 与卡片一致：用 dirClass 解析方向（"仅初盘·W"/"强信号·主胜" 都能正确归类）
    const dc = (typeof dirClass === 'function') ? dirClass(m.analysis.dir) : 'G';
    if (dc === 'W') stats.w++;
    else if (dc === 'L') stats.l++;
    else if (dc === 'D') stats.d++;
    else stats.skip++;
    // 信号命中统计（来自 vote）
    if (m.analysis.vote && m.analysis.vote.picks){
      for (const k of m.analysis.vote.picks){
        if (k === 's_pan_kb:W') buckets['盘型W'].n++;
        if (k === 's_pan:W') buckets['盘水W'].n++;
        if (k === 's_flow:L') buckets['流向L'].n++;
        if (k === 'betfa:W') buckets['betfa主'].n++;
        if (k === 'betfa:L') buckets['betfa客'].n++;
      }
    }
  }
  // 信号命中率（从历史回归）
  const rateMap = { '盘型W':59, '盘水W':52, '流向L':44, 'betfa主':null, 'betfa客':null };
  const rows = Object.entries(buckets).map(([k, v])=>{
    const r = rateMap[k];
    return `<tr><td>${k}</td><td>${v.n}</td><td>${r!=null? r+'%' : '—'}</td></tr>`;
  }).join('');
  const dirPct = stats.total ? `${stats.w}主 / ${stats.d}平 / ${stats.l}客 / ${stats.skip}观望` : '无';
  return `<p class="note">总 ${stats.total} 场：${dirPct}</p>
    <table class="sum-tb"><tr><th>信号</th><th>命中场数</th><th>历史命中率</th></tr>${rows}</table>`;
}
function sumHitRate(){
  // 复盘命中率：优先用后台自动复盘的 window.REVIEW_DATA（跨设备持久、按日期归集，不受本机 localStorage 限制），
  // 仅当本地尚无 REVIEW_DATA 时回退到 predLog（本机 localStorage，设备绑定、易空）。
  const RD = window.REVIEW_DATA;
  if (RD && (RD.allDirTotal || 0) > 0){
    const dirRate = RD.allDirRate, callRate = RD.allRate;
    const days = (RD.days || []).slice().sort((a, b) => b.date.localeCompare(a.date));
    // 最近复盘：从最新日期往前取有调用的若干场
    const recent = [];
    for (const d of days){
      for (const r of (d.rows || []).slice().sort((x, y) => (y.conf || 0) - (x.conf || 0))){
        if (r.hit != null) recent.push(r);
      }
      if (recent.length >= 8) break;
    }
    const recentHTML = recent.slice(0, 8).map(r => {
      const act = actualDir(r.hs, r.as);
      const tag = r.hit ? '<span class="badge bW">命中</span>' : '<span class="badge bL">未中</span>';
      return `<div class="kv"><span>${r.home || ''} vs ${r.away || ''}</span><span>${labelWDL(r.dir)} → ${labelWDL(act)} (${r.hs}:${r.as}) ${tag}</span></div>`;
    }).join('');
    return `<p class="bignum">${RD.allDirHits} / ${RD.allDirTotal} = <b>${dirRate}%</b></p>
      <p class="note">模型方向命中率（模型原始方向 vs 实际赛果）｜ 调用命中率(热度调整) ${callRate}%（${RD.allHits}/${RD.allTotal}）｜ 更新 ${RD.updated || '—'}</p>
      <h5 style="margin:8px 0 4px">最近复盘</h5>${recentHTML || '<p class="note">暂无</p>'}`;
  }
  // 回退：predLog（本机 localStorage）
  const done = predLog.filter(p => p.status === 'done');
  const rated = done.filter(p => p.hit != null);
  const total = rated.length;
  const hit = rated.filter(p => p.hit).length;
  const rate = total ? Math.round(hit / total * 100) : 0;
  if (!rated.length) return '<p class="note">暂无完场复盘数据（比赛结束后自动比对）</p>';
  const recent = rated.slice(-8).reverse().map(p => {
    const tag = p.hit ? '<span class="badge bW">命中</span>' : '<span class="badge bL">未中</span>';
    return `<div class="kv"><span>${p.home || ''} vs ${p.away || ''}</span><span>${labelWDL(p.dir)} → ${labelWDL(p.actual)} (${p.score || ''}) ${tag}</span></div>`;
  }).join('');
  return `<p class="bignum">${hit} / ${total} = <b>${rate}%</b></p>
    <p class="note">本机复盘命中率（模型方向 vs 实际赛果，设备绑定）</p>
    <h5 style="margin:8px 0 4px">最近复盘</h5>${recent}`;
}
function sumLeagueHot(){
  // 联赛场次统计 + 总进球（仅完场）
  const cnt = {}, goal = {}, live = {};
  for (const m of MATCHES){
    const lg = m.league || '未知';
    cnt[lg] = (cnt[lg]||0) + 1;
    if (isLive(m.state)) live[lg] = (live[lg]||0) + 1;
    if (m.state === '-1' && m.home_score != null && m.away_score != null){
      goal[lg] = (goal[lg]||0) + (m.home_score + m.away_score);
    }
  }
  const arr = Object.entries(cnt).sort((a,b)=> b[1]-a[1]).slice(0, 12);
  if (!arr.length) return '<p class="note">暂无联赛数据</p>';
  const max = Math.max(...arr.map(x=>x[1]));
  return arr.map(([lg, n])=>{
    const w = Math.round(n / max * 100);
    return `<div class="bar-row">
      <span class="bar-lg">${lg}</span>
      <span class="bar-bg"><span class="bar-fg" style="width:${w}%"></span></span>
      <span class="bar-n">${n}场${live[lg]?` · 🔴${live[lg]}`:''}${goal[lg]?` · ⚽${goal[lg]}`:''}</span>
    </div>`;
  }).join('');
}
function renderSummary(){
  const el = $('summary'); if (!el) return;
  const tv = $('sumTop'); if (tv) tv.innerHTML = sumTopValue();
  const sd = $('sumSig'); if (sd) sd.innerHTML = sumSigDist();
  const hr = $('sumHit'); if (hr) hr.innerHTML = sumHitRate();
  const lh = $('sumLg'); if (lh) lh.innerHTML = sumLeagueHot();
}


















