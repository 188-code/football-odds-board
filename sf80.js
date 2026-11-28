/* ═══════════════════════════════════════════════════════════════════════
   胜率80%选场 · 胜负差指数（澳客思维复刻）—— 独立只读板块
   ★ 完全独立于三盘资金过热板块：不改其任何判定/统计/分母/DOM。
     数据源 window.__SF80__（gen_index 内联 gzip），按 tid 与资金板对齐展示。
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var SF = null, tidMap = {}, ready = false;
  var dayFilter = '', pickFilter = '', showLimit = 60;
  var NM = { H: '胜', D: '平', A: '负' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function build() {
    try {
      SF = window.__SF80__ || null;
      tidMap = {};
      if (SF && SF.rows) SF.rows.forEach(function (r) { tidMap[String(r.tid)] = r; });
      ready = !!SF;
    } catch (e) { ready = false; }
  }

  function init() {
    build();
    var btn = document.getElementById('btnSf80');
    if (btn) btn.addEventListener('click', openSf80);
    window.addEventListener('sf80-ready', function () { build(); if (isOpen()) render(); });
    // 数据晚到兜底（与 v27 竞态同款）
    if (window.__SF80__ && !ready) setTimeout(function () { build(); }, 0);
  }

  function isOpen() { var m = document.getElementById('sf80Modal'); return !!(m && m.classList.contains('show')); }
  function openSf80() { if (!ready) build(); render(); var m = document.getElementById('sf80Modal'); if (m) m.classList.add('show'); }
  function closeSf80() { var m = document.getElementById('sf80Modal'); if (m) m.classList.remove('show'); }
  window.openSf80 = openSf80; window.closeSf80 = closeSf80;

  function colorFor(n) { return n >= 45 ? '#dc2626' : (n >= 30 ? '#ea580c' : '#2563eb'); }
  function diffTxt(d) { var v = +d; return (v > 0 ? '+' : '') + v.toFixed(1); }
  function diffCol(d) { var v = +d; return v > 0 ? '#dc2626' : (v < 0 ? '#16a34a' : '#94a3b8'); }

  function kpi() {
    var s = (SF && SF.summary) || {};
    var o = s.overall || {}, t = s.train || {}, h = s.holdout || {};
    var bp = s.byPick || {};
    function box(label, val, col, sub) {
      return '<div class="rcard" style="min-width:118px"><div class="rn" style="color:' + (col || 'var(--acc)') + '">' + val + '</div><div class="rl">' + label + '</div>' + (sub ? '<div style="font-size:10px;opacity:.6;margin-top:2px">' + sub + '</div>' : '') + '</div>';
    }
    return '<div class="rcard" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">'
      + box('纳入场次', o.n == null ? '—' : o.n, '#8b5cf6')
      + box('已结算', o.settled == null ? '—' : o.settled, '#6366f1')
      + box('双选覆盖', o.pct == null ? '—' : o.pct + '%', '#dc2626', o.hit + '中 / ' + o.pass + '错')
      + box('训练段', t.pct == null ? '—' : t.pct + '%', '#2563eb', (t.settled || 0) + ' 场')
      + box('留出段', h.pct == null ? '—' : h.pct + '%', '#ea580c', (h.settled || 0) + ' 场')
      + box('胜平双选', bp.HD && bp.HD.pct != null ? bp.HD.pct + '%' : '—', '#059669', bp.HD ? bp.HD.settled + ' 场' : '')
      + box('胜负双选', bp.HA && bp.HA.pct != null ? bp.HA.pct + '%' : '—', '#059669', bp.HA ? bp.HA.settled + ' 场' : '')
      + box('平负双选', bp.DA && bp.DA.pct != null ? bp.DA.pct + '%' : '—', '#d97706', bp.DA ? bp.DA.settled + ' 场' : '')
      + '</div>';
  }

  function note() {
    var s = (SF && SF.summary) || {};
    return '<div class="note" style="border-left:3px solid #ec4899;margin:8px 0 12px;line-height:1.7">'
      + '<b>这是什么：</b>复刻澳客「胜负差指数」思维，用同源数据自制 —— '
      + '① <b>胜负指数</b> = 365 欧赔在竞彩销售截止前 30 分钟冻结盘的归一化隐含概率（胜/平/负三项和≈100，越高=市场越看好该项）；'
      + '② <b>胜负差</b> = 冻结盘 − 初盘（百分点，正=看好态度上升，负=下降，与截图同口径）；'
      + '③ <b>80%预测</b> = 取指数最高的两项做双选（排除一个结果）。<br>'
      + '<b style="color:#dc2626">⚠ 诚实标注：</b>实测 ' + esc(s.period || '') + ' 共 ' + ((s.overall || {}).settled || 0)
      + ' 场已结算，双选覆盖 <b>' + ((s.overall || {}).pct || '—') + '%</b>（训练 ' + ((s.train || {}).pct || '—') + '% / 留出 ' + ((s.holdout || {}).pct || '—') + '%）。'
      + '所谓「80%」本质是<b>双选的数学覆盖率</b>（三项排除一项），<b>不是选对单场的 edge、更不是投注必胜</b>；'
      + '澳客话术「差异值居中概率偏高」经实测并不成立（居中规则仅 69.4% < 双选 75.8%），故按命中率最高的规则复刻。'
      + '本板块<b>只读展示，不改三盘资金过热板块任何判定/统计/分母，也不并入主账业绩</b>。'
      + '</div>';
  }

  function filters() {
    var days = [], picks = ['HD', 'HA', 'DA'];
    if (SF && SF.rows) SF.rows.forEach(function (r) { if (days.indexOf(r.day) < 0) days.push(r.day); });
    days.sort().reverse();
    var dd = days.slice(0, 14);
    var h = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:12px">'
      + '<span>日期：</span><button class="htab-btn' + (dayFilter === '' ? ' on' : '') + '" data-df="">近场</button>';
    dd.forEach(function (d) { h += '<button class="htab-btn' + (dayFilter === d ? ' on' : '') + '" data-df="' + esc(d) + '">' + esc(d.slice(4, 6) + '/' + d.slice(6, 8)) + '</button>'; });
    h += '<span style="margin-left:10px">预测：</span><button class="htab-btn' + (pickFilter === '' ? ' on' : '') + '" data-pf="">全部</button>';
    picks.forEach(function (p) { h += '<button class="htab-btn' + (pickFilter === p ? ' on' : '') + '" data-pf="' + p + '">' + ({ HD: '胜平', HA: '胜负', DA: '平负' }[p]) + '</button>'; });
    h += '</div>';
    return h;
  }

  function rowsHTML() {
    if (!SF || !SF.rows) return '<p class="note">数据尚未注入。</p>';
    var list = SF.rows.filter(function (r) {
      if (dayFilter && r.day !== dayFilter) return false;
      if (pickFilter && r.pick !== pickFilter) return false;
      return true;
    });
    // 未来场优先（未结算），其次按日期倒序
    list.sort(function (a, b) {
      var ap = a.result == null ? 1 : 0, bp = b.result == null ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return b.day.localeCompare(a.day) || String(a.tid).localeCompare(String(b.tid));
    });
    var shown = list.slice(0, showLimit);
    if (!shown.length) return '<p class="note">该筛选下暂无场次。</p>';
    var h = '<table class="htab" style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>'
      + '<th>日期/开赛</th><th>联赛</th><th>对阵</th><th>竞彩SP</th>'
      + '<th>胜负指数 胜/平/负</th><th>胜负差 胜/平/负</th><th>80%预测</th><th>排除</th><th>赛果</th><th>覆盖</th><th>帧</th></tr></thead><tbody>';
    shown.forEach(function (r) {
      var idx = r.idx || [0, 0, 0], dif = r.diff || [0, 0, 0], sp = r.jcSp;
      var idxHTML = idx.map(function (v, i) { return '<span style="color:' + colorFor(v) + ';font-weight:' + (v === Math.max.apply(null, idx) ? '800' : '500') + '">' + (+v).toFixed(1) + '</span>'; }).join(' / ');
      var difHTML = dif.map(function (v) { return '<span style="color:' + diffCol(v) + '">' + diffTxt(v) + '</span>'; }).join(' / ');
      var ok = r.result ? (r.pick.indexOf(r.result) >= 0) : null;
      var hitHTML = ok == null ? '<span style="opacity:.5">未结算</span>' : (ok ? '<b style="color:#dc2626">✓</b>' : '<b style="color:#16a34a">✗</b>');
      var resHTML = r.score ? esc(r.score) + ' ' + NM[r.result] : '<span style="opacity:.5">—</span>';
      h += '<tr style="border-top:1px solid var(--line)">'
        + '<td style="padding:5px 6px;white-space:nowrap">' + esc(r.day.slice(4, 6) + '/' + r.day.slice(6, 8) + ' ' + (r.kickoff || '').slice(-5)) + '</td>'
        + '<td style="padding:5px 6px">' + esc(r.league || '') + '</td>'
        + '<td style="padding:5px 6px"><b>' + esc(r.home) + '</b> vs <b>' + esc(r.away) + '</b></td>'
        + '<td style="padding:5px 6px;white-space:nowrap">' + (sp ? sp.map(function (x) { return (+x).toFixed(2); }).join('/') : '<span style="opacity:.4">—</span>') + '</td>'
        + '<td style="padding:5px 6px;white-space:nowrap;font-variant-numeric:tabular-nums">' + idxHTML + '</td>'
        + '<td style="padding:5px 6px;white-space:nowrap;font-variant-numeric:tabular-nums">' + difHTML + '</td>'
        + '<td style="padding:5px 6px;font-weight:800;color:#ec4899">' + esc(r.pickTxt || '') + '</td>'
        + '<td style="padding:5px 6px;opacity:.65">' + esc(r.excluded || '') + '</td>'
        + '<td style="padding:5px 6px;white-space:nowrap">' + resHTML + '</td>'
        + '<td style="padding:5px 6px">' + hitHTML + '</td>'
        + '<td style="padding:5px 6px;opacity:.5">' + (r.frames || 0) + '</td>'
        + '</tr>';
    });
    h += '</tbody></table>';
    if (list.length > shown.length) h += '<div style="margin-top:8px;font-size:11px;opacity:.6">已显示 ' + shown.length + ' / ' + list.length + ' 场</div>';
    return h;
  }

  function render() {
    var host = document.getElementById('sf80Content');
    if (!host) return;
    if (!ready) { host.innerHTML = '<p class="note">数据尚未注入完成，请稍后重开本板块。</p>'; return; }
    host.innerHTML = note() + kpi() + filters() + rowsHTML();
    host.querySelectorAll('[data-df]').forEach(function (b) {
      b.addEventListener('click', function () { dayFilter = b.getAttribute('data-df'); render(); });
    });
    host.querySelectorAll('[data-pf]').forEach(function (b) {
      b.addEventListener('click', function () { pickFilter = b.getAttribute('data-pf'); render(); });
    });
  }

  /* ★ 资金板"每场后面加列"：不碰原DOM结构，返回一段可插入对阵单元格后的迷你 HTML。
     资金板如需接入，只需在行内调用 window.sf80MiniForTid(tid)（当前默认不启用，保持原板块零改动）。 */
  window.sf80MiniForTid = function (tid) {
    if (!ready) build();
    var r = tidMap[String(tid)];
    if (!r) return '';
    var idx = r.idx || [0, 0, 0], dif = r.diff || [0, 0, 0];
    var top = idx.map(function (v, i) { return [v, i]; }).sort(function (a, b) { return b[0] - a[0]; });
    return '<span class="sf80-mini" data-sf80-tid="' + esc(tid) + '" style="display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid #ec4899;border-radius:10px;font-size:9.5px;color:#ec4899;font-weight:700" title="胜率80%选场·胜负差指数：指数' + idx.map(function (x) { return (+x).toFixed(0); }).join('/') + ' 差' + dif.map(function (x) { return diffTxt(x); }).join('/') + ' 双选' + esc(r.pickTxt) + '（双选覆盖非单场edge）">80% ' + esc(r.pickTxt) + '</span>';
  };
  window.SF80_READY = function () { return ready; };

  /* ★ 关于"在三盘资金过热板块每场后面加列"：
     资金板历史行（v21+）不带 tid/onclick，DOM 上无法可靠按场映射；强加会错配。
     按用户「宁可空着 / 别弄坏原板块」铁律：原板块 DOM 与逻辑一行不动，
     胜负指数字段统一在本独立板块内以「每场多列」表格呈现（含日切换/筛选/回测统计）。 */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
