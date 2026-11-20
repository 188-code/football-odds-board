/* 独立篮球观察板块；以外链 defer 加载，不调用足球引擎或改写足球筛选。 */
(function () {
  'use strict';
  if (window.__basketHeatLoaded) return;
  window.__basketHeatLoaded = true;

  const MARKETS = { mnl: '胜负 / 独赢', hdc: '让分胜负', hilo: '大小分' };
  const SOURCES = { jc: '竞彩篮球', eu: 'Bet365（公开转引）', bd: '北单胜负过关' };
  const STATES = { ok: '成功', partial: '部分成功', error: '失败', blocked: '停用 / 访问受限', pending: '等待', cached_sample: '已导入缓存快照（非实时采集成功）', not_connected: '未接入' };
  const IMPORT_NOTICE = '真实抓取快照导入·非实时·采集时刻未核，不计赛前意见';
  const state = { data: null, ledger: null, preset: null, overheat: null, day: '', market: 'mnl', keyword: '', selling: false, loading: false, focus: null };
  let modal;
  let observer;
  const scriptURL = document.currentScript && document.currentScript.src;

  function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function list(v) { return Array.isArray(v) ? v : []; }
  function text(v) { return typeof v === 'string' || typeof v === 'number' && Number.isFinite(v) ? String(v) : ''; }
  function esc(v) {
    return text(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function num(v) {
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    if (typeof v === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim())) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function odd(v) { const n = num(v); return n !== null && n > 0 ? n : null; }
  function fmt(v, digits) { const n = num(v); return n === null ? '未取得' : n.toFixed(digits === undefined ? 2 : digits); }
  function timestamp(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  function moment(v) { return timestamp(v) === null ? '未取得 / 时点未核' : esc(v.replace('T', ' ')); }
  function keys(market) { return market === 'hilo' ? ['over', 'under'] : ['home', 'away']; }
  function labels(market) { return market === 'hilo' ? ['大分', '小分'] : ['主队', '客队']; }
  function quote(raw, market, rawWater) {
    const q = object(raw), ks = keys(market);
    const a = odd(q[ks[0]]), b = odd(q[ks[1]]), line = market === 'mnl' ? null : num(q.line);
    if (a === null || b === null || market === 'mnl' && (a <= 1 || b <= 1) || market !== 'mnl' && line === null) return null;
    return { a: a, b: b, line: line, decimal: !rawWater || market === 'mnl' };
  }
  function bdQuote(raw) {
    const q = quote(raw, 'mnl');
    return q && q.a >= 1.01 && q.b >= 1.01 ? q : null;
  }
  function imported(data) { return object(data).mode === 'imported_snapshot'; }
  function captureUnknown(row, endpoint) {
    return imported(state.data) || object(state.data).captureTimeVerified === false || row.captureTimeVerified === false || object(endpoint).captureTimeVerified === false;
  }
  function probabilities(q) {
    if (!q || q.decimal === false || q.a <= 1 || q.b <= 1) return null;
    const sum = 1 / q.a + 1 / q.b;
    if (!Number.isFinite(sum) || sum <= 0) return null;
    return { a: (1 / q.a) / sum, b: (1 / q.b) / sum, R: 1 / sum };
  }
  function lineText(q, market) {
    if (market === 'mnl') return '独赢（无让分线）';
    if (!q) return '盘口线未取得';
    return market === 'hilo' ? '总分线 ' + fmt(q.line) : '原始让分线 ' + fmt(q.line) + '（不擅自换向）';
  }
  function quoteHTML(raw, market, withProbability, rawWater) {
    const q = quote(raw, market, rawWater);
    if (!q) return '<p class="bh-missing">本玩法报价缺失或字段无效（空值不当作 0）</p>';
    const ls = labels(market), p = withProbability ? probabilities(q) : null;
    let html = '<p>' + esc(lineText(q, market)) + '</p><p class="bh-price">' +
      (q.decimal ? '十进制赔率：' : '原始水位：') + ls[0] + ' ' + fmt(q.a) + ' / ' + ls[1] + ' ' + fmt(q.b) + '</p>';
    if (!q.decimal) html += '<p class="bh-muted">原始水位制式未核，不标作十进制赔率；禁止概率、返还率与 Δpp 换算。</p>';
    if (withProbability && p) {
      html += '<p>去水隐含概率 q：' + ls[0] + ' ' + fmt(p.a * 100) + '% / ' + ls[1] + ' ' + fmt(p.b * 100) + '%</p>' +
        '<p class="bh-muted">隐含返还率 R ' + fmt(p.R * 100) + '%；这是赔率归一化，不是资金占比，也不是已验证的真实胜率。</p>';
    }
    return html;
  }
  function sameLine(a, b, market) { return !!a && !!b && (market === 'mnl' || a.line === b.line); }
  function delta(a, b, market) {
    if (!sameLine(a, b, market)) return '盘口线不同：不计算 Δpp';
    const pa = probabilities(a), pb = probabilities(b), ls = labels(market);
    if (!pa || !pb) return '归一化无效：不计算 Δpp';
    function signed(n) { return (n > 0 ? '+' : '') + n.toFixed(2); }
    return ls[0] + ' ' + signed((pb.a - pa.a) * 100) + ' pp / ' + ls[1] + ' ' + signed((pb.b - pa.b) * 100) + ' pp';
  }
  function sourceErrors(data, source) {
    return list(object(object(data.sourceStatus)[source]).errors).map(text).filter(Boolean).join('；');
  }
  function euIdentity(row) {
    const match = object(row.euMatch);
    return text(match.id) && text(match.home) && text(match.away) && num(match.kickTs) !== null ? match : null;
  }
  function euBlocked(row) {
    return object(object(state.data.sourceStatus).eu).state === 'blocked' || object(row.eu).blocked === true;
  }
  function euFailure(row) {
    const eu = object(row.eu), status = object(object(state.data.sourceStatus).eu);
    return euBlocked(row) ? '报价获取失败（源站访问受限；非无报价）' :
      status.state === 'error' || text(eu.sourceError) ? '报价获取失败（详见来源原因）' : '报价未接入（当前玩法未采得有效报价）';
  }
  function missingReason(row, source, market) {
    const endpoint = object(row[source]), data = object(state.data);
    const status = object(object(data.sourceStatus)[source]), evidence = object(data.evidence);
    const rejected = object(evidence[source === 'eu' ? 'euRejected' : 'bdRejected']);
    const linked = source === 'eu' && euIdentity(row);
    const blocked = source === 'eu' && euBlocked(row);
    const reasons = [text(status.reason), text(endpoint.sourceError),
      blocked ? text(object(status.blockEvidence).pageText) || text(object(endpoint.blockEvidence).pageText) || '源站访问受限，已停用，不绕过重试' : '',
      text(endpoint.reason), text(object(endpoint.marketErrors)[market]), sourceErrors(data, source),
      !linked && !blocked ? text(rejected[row.id]) : '', !linked && !blocked ? text(evidence.externalLinkBlocker) : ''];
    return Array.from(new Set(reasons.filter(Boolean))).join('；') || '采集结果未提供本场此端报价，不能推定已取得';
  }
  function flag(value, yes, no) { return value === true ? yes : value === false ? no : '未核实'; }
  function staleText(row, endpoint) {
    if (captureUnknown(row, endpoint)) return '采集时刻未核，不计赛前意见；导入时间不作为抓取时点';
    if (row.stale === true || object(endpoint).stale === true) return '旧快照保留，不当作本次新鲜数据';
    return timestamp(row.kickoff) !== null && timestamp(row.kickoff) <= Date.now() ? '已到开赛时点，仅保留快照观察' : '快照观察（非实时推送）';
  }
  function historyHTML(row, market) {
    const rawFrames = list(object(row.jcHistory)[market]);
    const observed = timestamp(row.observed_at), kick = timestamp(row.kickoff);
    const frames = rawFrames.map((raw, index) => {
      const f = object(raw), poll = f.kind === 'poll';
      const t = timestamp(poll ? f.observed_at : f.source_time);
      return { raw: f, q: quote(f.quote, market), t: t, index: index, poll: poll,
        eligible: !captureUnknown(row) && f.captureTimeVerified !== false && (!poll || f.captureTimeVerified === true) &&
          f.analysisEligible === true && f.pregame === true && t !== null && kick !== null && observed !== null && t < kick && t <= observed };
    }).sort((a, b) => (a.t === null ? Infinity : a.t) - (b.t === null ? Infinity : b.t) || a.index - b.index);
    const current = quote(object(row.markets)[market], market);
    const valid = frames.filter(f => f.eligible && f.q);
    const first = valid[0];
    const base = valid.find(f => sameLine(f.q, current, market));
    const currentEligible = !captureUnknown(row) && observed !== null && kick !== null && observed < kick && row.stale !== true;
    let headline = '<p>开→当前：' + (first ? '最早已取得赛前帧（' + (first.poll ? '轮询观察时点' : '真实源时点') + '）' + moment(first.poll ? first.raw.observed_at : first.raw.source_time) : '未取得可用赛前历史起点') +
      ' → 当前观察 ' + moment(row.observed_at) + '；历史 ' + rawFrames.length + ' 帧。</p>';
    headline += '<p class="bh-muted">最早取得帧不保证是真正开盘；缺历史不虚构开盘。poll 按已核观察时点排序和验赛前资格，历史回填仅用真实 source_time，不以观察或导入时间补造源时点。仅计算竞彩同玩法、同盘口线的去水隐含概率变化，不代表资金流速。</p>';
    headline += '<p data-basket-delta>' + (currentEligible && base ? '同盘口 Δpp（同线最早帧→当前）：' + delta(base.q, current, market) :
      '同盘口 Δpp：未计算（' + (!currentEligible ? '当前时点不具赛前新鲜资格' : !current ? '当前报价缺失' : '缺少同线合格历史帧') + '）') + '</p>';
    if (first && current && !sameLine(first.q, current, market)) headline += '<p>最早帧与当前换线：只展示原始线，不跨线相减。</p>';
    let previous = null;
    const table = frames.map(f => {
      const q = f.q;
      let change = '缺少相邻合格帧';
      if (!f.eligible || !q) change = '时点 / 赛前资格 / 报价未核，不参与 Δpp';
      else if (previous) change = delta(previous.q, q, market);
      previous = f.eligible && q ? f : null;
      return '<tr data-basket-frame="history" data-market="' + market + '"><td>源时点 ' + moment(f.raw.source_time) +
        '<br><small>' + (f.poll ? '轮询观察时点 ' : '采到 ') + moment(f.raw.observed_at) + '</small></td><td>' + esc(lineText(q, market)) + '</td><td>' +
        (q ? fmt(q.a) + ' / ' + fmt(q.b) : '无效 / 缺失') + '</td><td>' + esc(f.raw.kind || '未标记') +
        '；' + (f.eligible ? '赛前合格' : '仅原始展示') + '</td><td>' + esc(change) + '</td></tr>';
    }).join('');
    return '<details class="bh-history"><summary>开→当前历史帧与同盘口 Δpp</summary>' + headline +
      '<div class="bh-scroll" tabindex="0" aria-label="竞彩历史帧横向滚动表"><table><thead><tr><th>源时点 / 采集时点</th><th>原始线</th><th>' + labels(market).join(' / ') +
      '</th><th>类型与资格</th><th>相邻同线 Δpp</th></tr></thead><tbody>' + table +
      '<tr data-basket-frame="current" data-market="' + market + '"><td>当前观察 ' + moment(row.observed_at) + '</td><td>' + esc(lineText(current, market)) + '</td><td>' +
      (current ? fmt(current.a) + ' / ' + fmt(current.b) : '缺失') + '</td><td>当前快照</td><td>' +
      esc(currentEligible && previous ? delta(previous.q, current, market) : '缺少合格相邻历史 / 当前资格不足') +
      '</td></tr></tbody></table></div></details>';
  }
  function jcHTML(row, market) {
    const selling = object(row.poolSelling)[market];
    return '<section class="bh-source" data-source="jc" data-market="' + market + '"><h4>一盘 · 竞彩篮球</h4><p>玩法在售：' +
      flag(selling, '采集时在售', '采集时不在售') + '；比赛状态 ' + esc(row.status || '未核') + '</p>' +
      quoteHTML(object(row.markets)[market], market, true) + '<p class="bh-muted">采集 ' + moment(row.observed_at) +
      '；' + esc(staleText(row)) + '</p>' + (!quote(object(row.markets)[market], market) ? '<p class="bh-missing">缺端说明：本场竞彩该玩法未提供有效双边赔率或盘口线。' + esc(sourceErrors(state.data, 'jc')) + '</p>' : '') +
      historyHTML(row, market) + '</section>';
  }
  function euIdentityHTML(row) {
    const match = euIdentity(row);
    if (!match) return '<p data-basket-eu-identity>比赛身份尚未关联；不把候选赛程当作本场报价。</p>';
    const capture = object(match.capture), kick = new Date(num(match.kickTs) * 1000);
    return '<div data-basket-eu-identity><p>已匹配 tid：<strong>' + esc(match.id) + '</strong>；' + esc(match.away) +
      '（客队） vs ' + esc(match.home) + '（主队）</p><p>身份依据：' + esc(match.identityMethod || '后端已关联，方法未提供') +
      '；开赛时间差 ' + fmt(match.kickDeltaSeconds, 0) + ' 秒。</p><p class="bh-muted">来源：' +
      (match.cachedSchedule === true || match.staleSchedule === true ? '已存真实赛程缓存' : '后端赛程身份记录') +
      (capture.path ? '；' + esc(capture.path) + (num(capture.line) !== null ? ' · 第 ' + esc(capture.line) + ' 行' : '') : '') +
      '；赛程采集 ' + moment(match.observed_at) + '；源赛程开赛 ' + (Number.isFinite(kick.getTime()) ? moment(kick.toISOString()) : '未取得') +
      '（原始 kickTs ' + esc(match.kickTs) + '）。</p><p class="bh-muted">' +
      (match.staleSchedule === true ? '旧赛程缓存，当前赛程状态未重核；' : '') +
      '只作身份桥接，不是赔率采集时点，不计作已取得报价或赛前意见。</p></div>';
  }
  function euHTML(row, market) {
    const eu = object(row.eu), raw = object(eu.markets)[market], q = quote(raw, market, true);
    const opening = object(object(eu.opening)[market]), times = object(object(eu.sourceTimes)[market]);
    return '<section class="bh-source" data-source="eu" data-market="' + market + '"><h4>二盘 · Bet365</h4>' +
      '<p data-basket-eu-stages><strong>' + (euIdentity(row) ? '比赛身份已关联' : '比赛身份未关联') + ' → ' +
      (q ? '已取得有效原始报价' : euFailure(row)) + ' → 可比规则待核</strong></p>' + euIdentityHTML(row) +
      (q ? quoteHTML(raw, market, false, true) : '<p class="bh-missing">' + esc(euFailure(row)) + '。原因：' + esc(missingReason(row, 'eu', market)) + '</p>') +
      (q && euBlocked(row) ? '<p class="bh-missing">源站访问受限；仅保留已取得的原始报价，不代表本轮采集成功。原因：' + esc(missingReason(row, 'eu', market)) + '</p>' : '') +
      '<p>可比状态：' + (eu.comparable === true ? '源标记可比；本观察板仍未核验结算规则，不启用跨源差值' : 'comparable=false / 尚未核实，不启用跨源差值') +
      '；规则待核不妨碍原始报价展示。</p><p class="bh-muted">' + esc(eu.reason || '第三方公开转引；水位制式、让分符号、含加时和源时间均待核') + '</p>' +
      '<p class="bh-muted">报价采集 ' + moment(eu.observed_at) + '；赛前标记 ' + flag(eu.pregame, '是', '否') + '；' + esc(staleText(row, eu)) + '</p>' +
      '<p class="bh-muted">源变更时间（原样）：' + esc(times.display || '未取得') + '；核验 ' + flag(times.verified, '已标记核验', '未核验') + '</p>' +
      (quote(opening.quote, market, true) ? '<details><summary>网页标签“初盘”（非已验证开盘）</summary>' + quoteHTML(opening.quote, market, false, true) +
        '<p class="bh-muted">源标签时点 ' + esc(opening.source_time || '未取得') + '；不参与历史 Δpp 或赛前信号。当前 JSON 未提供 Bet365 连续历史帧。</p></details>' :
        '<p class="bh-muted">Bet365 初盘 / 连续历史未取得，不编造开→当前变化。</p>') + '</section>';
  }
  function bdHTML(row, market) {
    const bd = object(row.bd), raw = object(object(bd.markets).sfgg);
    const q = bdQuote(raw), p = probabilities(q);
    const handicap = text(bd.rawHandicap);
    return '<section class="bh-source" data-source="bd" data-market="' + market + '"><h4>三盘 · 北单胜负过关（sfgg）</h4>' +
      (q ? '<p class="bh-price">原始 SP：主胜 ' + fmt(q.a) + ' / 主负 ' + fmt(q.b) + '</p>' :
        '<p class="bh-missing">未取得有效双边原始 SP。缺端原因：' + esc(missingReason(row, 'bd', 'sfgg')) + '</p>') +
      '<p>原始让分：<strong>' + esc(handicap === '' ? '未取得（不补 0）' : handicap) + '</strong>；不推断让分方向。</p>' +
      (p ? '<p>池赔率归一份额：主 ' + fmt(p.a * 100) + '% / 客 ' + fmt(p.b * 100) + '%</p>' : '<p>池赔率归一份额：未取得</p>') +
      '<p class="bh-muted">未核返还 / 规则，不是真资金百分比；只按原始双边 SP 计算 q，不假定北单返还率为 100%。</p>' +
      '<p>可比状态：' + (bd.comparable === true ? '源标记可比，但本板未核规则，仍不执行跨源相减' : '不可比 / 待核') +
      '。' + (market === 'hilo' ? '北单 sfgg 不是大小分，不充当第三端同玩法。' : market === 'mnl' ? '北单带让分不等于独赢，永不将让分与独赢相减。' : '仅在同线、同方向、同结算均核实后才可能比较；目前未启用。') + '</p>' +
      '<p class="bh-muted">' + esc(bd.reason || '让分符号、结算规则未核实') + '</p><p class="bh-muted">采集 ' + moment(bd.observed_at) +
      '；停售 ' + moment(bd.endTime) + '（不是开赛时间）；' + esc(staleText(row, bd)) + '</p></section>';
  }
  function sale(row, market) {
    const kick = timestamp(row.kickoff);
    return !captureUnknown(row) && timestamp(row.observed_at) !== null && row.status === 'Selling' && object(row.poolSelling)[market] === true && row.stale !== true && kick !== null && kick > Date.now();
  }
  function rowHTML(row) {
    const market = state.market;
    const hasJC = !!quote(object(row.markets)[market], market);
    const hasEU = !!quote(object(object(row.eu).markets)[market], market, true);
    const hasBD = !!bdQuote(object(object(row.bd).markets).sfgg);
    const missing = [!hasJC ? '竞彩本玩法缺报价' : '', !hasEU ? 'Bet365：' + euFailure(row) + '；' + missingReason(row, 'eu', market) : '',
      !hasBD ? '北单缺SP：' + missingReason(row, 'bd', 'sfgg') : '北单sfgg与当前市场可比规则未核'].filter(Boolean);
    return '<article class="bh-match" data-basket-row="' + esc(row.id) + '" data-market="' + market + '">' +
      '<header><h3>' + esc(row.away) + ' <small>（客队）</small> vs ' + esc(row.home) + ' <small>（主队）</small></h3>' +
      '<p>' + esc(row.league) + ' · ' + esc(row.no) + ' · 竞彩篮球 ID ' + esc(row.id) + '</p><p>日期 ' + esc(row.day) +
      ' · 开赛 ' + moment(row.kickoff) + ' · ' + (sale(row, market) ? '当前所选玩法赛前在售快照' : '不满足当前所选玩法新鲜赛前在售条件') + '</p></header>' +
      '<div class="bh-three">' + jcHTML(row, market) + euHTML(row, market) + bdHTML(row, market) + '</div>' +
      '<footer data-basket-conclusion><strong>结论：仅观察 · 篮球留出标定尚未建立</strong><p>当前玩法竞彩 / Bet365 报价 ' + (Number(hasJC) + Number(hasEU)) +
      '/2 端；北单原始 SP ' + (hasBD ? '已取得（可比性未核）' : '缺失') + '。不输出强推，方向仅是竞彩赔率观察记录、非投注信号。</p>' +
      '<div data-basket-direction>' + directionHTML(row, market) + '</div><p>' +
      esc(missing.join('；')) + '</p><p class="bh-muted">源分析状态 ' + esc(object(row.analysis).state || '未提供') + '：' +
      esc(object(row.analysis).reason || '无合格篮球样本外证据') + '。跨源可比 / 资金流速均未建立。</p></footer></article>';
  }

  /* ★ 2026-11-17 方向观察账本（仿足球 dir_ledger）：赛前冻结方向 + 待结算/已结算复盘。
     方向来自竞彩真实报价的去水隐含概率倾向方 = 赔率观察方向，不是资金流向、不是有 edge 的下注建议。 */
  function ledgerEntries(row, market) {
    const items = object(state.ledger && state.ledger.items), out = [];
    for (const key in items) {
      const e = object(items[key]);
      if (text(e.id) === text(row.id) && text(e.market) === market) out.push(e);
    }
    return out;
  }
  function frozenTime(e) {
    const t = num(e.firstSeen);
    if (t === null) return '未取得';
    const d = new Date(t * 1000);
    return Number.isFinite(d.getTime()) ? esc(d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC') : '未取得';
  }
  /* ★ 2026-11-18 开盘→临盘逐帧轨迹（和足球三盘 dirTrail 口径一致）：
     每帧显示 方向/去水隐含/报价/线/Δpp；保留开盘首帧，开赛即冻结不再追加。 */
  function trailHTML(e) {
    const tr = Array.isArray(e.dirTrail) ? e.dirTrail : [];
    if (!tr.length) return '';
    const fm = (t) => { const d = new Date((num(t) || 0) * 1000); return Number.isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').slice(5, 16) : '—'; };
    const pct = (v) => num(v) !== null ? fmt(v * 100, 1) + '%' : '—';
    const rows = tr.map((f, i) => {
      const first = i === 0, last = i === tr.length - 1;
      const tag = (first ? '开盘' : (last ? '临盘' : '盘' + i));
      const dpp = num(f.dA) !== null ? ((f.dA > 0 ? '+' : '') + fmt(f.dA, 2) + 'pp') : '—';
      return '<tr><td>' + tag + ' · ' + esc(fm(f.t)) + '</td><td><b>' + esc(f.pick || '—') + '</b></td><td>' +
        pct(f.pa) + ' / ' + pct(f.pb) + '</td><td>' + esc(fmt(f.a, 2)) + '/' + esc(fmt(f.b, 2)) +
        (num(f.line) !== null ? ' · 线' + esc(f.line) : '') + '</td><td>' + esc(dpp) + '</td></tr>';
    }).join('');
    return '<details class="bh-trail" style="margin:4px 0 0"><summary style="cursor:pointer;color:var(--mut,#8b98a9);font-size:12px">' +
      '开盘→临盘轨迹 ' + tr.length + ' 帧（首登冻结方向不变， trace 仅记录变化）</summary>' +
      '<div class="bh-scroll"><table style="font-size:12px"><thead><tr><th>时点</th><th>方向</th><th>去水隐含(主/客)</th><th>报价/线</th><th>同线Δpp</th></tr></thead><tbody>' +
      rows + '</tbody></table></div></details>';
  }
  function directionHTML(row, market) {
    const list = ledgerEntries(row, market);
    if (!list.length) return '<p data-basket-dir-note>该玩法无赛前冻结方向（非赛前合格场或报价无效，不补造）</p>';
    return list.map(e => {
      const settled = e.result !== null && e.result !== undefined;
      const res = settled ? ({ win: '中', lose: '未中', push: '走水' }[e.result] || e.result) : '待结算';
      const resColor = settled ? (e.result === 'win' ? '#16a34a' : '#e54545') : 'var(--mut,#8b98a9)';
      const dp = object(e.deltaPP), dpTxt = dp && num(dp.dA) !== null ?
        ' · 同线Δpp ' + ((dp.dA > 0 ? '+' : '') + dp.dA.toFixed(2) + 'pp') : '';
      return '<div data-basket-dir-entry data-dir-key="' + esc(e.id + ':' + e.market) + '">' +
        '<p style="margin:0"><b>方向（观察·非投注建议）：' +
        esc(e.pick) + '</b> · 去水隐含 ' + (num(e.probA) !== null ? fmt(e.probA * 100, 1) + '%' : '—') + dpTxt +
        '<br><small>首登冻结 ' + frozenTime(e) + ' · 规则 ' + esc(e.ruleV || '—') +
        ' · 结算 <span style="color:' + resColor + '">' + res + '</span>' +
        (settled && text(e.finalScore) ? ' · 最终比分 ' + esc(e.finalScore) : '') +
        (settled && num(e.pl) !== null ? '（盈亏 ' + (e.pl > 0 ? '+' : '') + fmt(e.pl, 2) + '）' : '') + '</small></p>' +
        trailHTML(e) + '</div>';
    }).join('');
  }
  /* ★ 2026-11-20 统计随日期筛选联动（用户要求：点全部按全部、点哪天显示哪天的结算/命中率）。
     前端复算口径与服务端 _basket_dir_ledger.cjs finish()/feed() 完全一致：
     n=已结算数(含走水)；hit=win/(win+lose)不含走水；roi=Σpl/n；se=100/√n。 */
  function ledgerAgg(list) {
    let n = 0, win = 0, lose = 0, push = 0, pl = 0;
    for (const raw of list) {
      const e = object(raw);
      if (e.result === null || e.result === undefined) continue;
      n++;
      if (e.result === 'win') win++; else if (e.result === 'lose') lose++; else push++;
      pl += num(e.pl) || 0;
    }
    const dec = win + lose, r10 = v => Math.round(v * 10) / 10;
    const hit = dec ? r10(win / dec * 100) : null;
    const roi = n ? r10(pl / n * 100) : null;
    const se = n ? r10(100 / Math.sqrt(n)) : null;
    return { n, win, lose, push, pl, hit, roi, se,
      significant: !!(n >= 40 && roi !== null && Math.abs(roi) > se),
      crossZero: !!(roi !== null && se !== null && Math.abs(roi) < se) };
  }
  function dirLedgerSummaryHTML() {
    const led = state.ledger, items = object(led && led.items), s = led && object(led.summary);
    if (!s || !num(s.total)) return '<p data-basket-dir-summary>方向账本尚未生成；当前无赛前冻结方向可展示，不用 0 代替未知。</p>';
    const allEntries = Object.values(items).map(object);
    // ★按当前日期筛选复算（无筛选=全部，直接用服务端权威 summary）
    const entries = state.day ? allEntries.filter(e => text(e.day) === state.day) : allEntries;
    let settledN, pendingN, totalN, preN, a, scoped;
    if (state.day) {
      const agg = ledgerAgg(entries);
      settledN = agg.n; totalN = entries.length; pendingN = totalN - agg.n;
      preN = entries.filter(e => e.pre === true).length;
      a = agg; scoped = true;
    } else {
      settledN = num(s.settled) || 0; pendingN = num(s.pending) || 0;
      totalN = num(s.total) || 0; preN = num(s.pre) || 0;
      a = object(s.all); scoped = false;
    }
    const cards = [
      '<div class="bh-dir-card"><div class="rl">冻结方向' + (scoped ? ' · 📅 ' + esc(state.day) : '') + '</div><div class="rr">' + totalN + ' 条 / ' +
        preN + ' 赛前</div></div>',
      '<div class="bh-dir-card"><div class="rl">已结算 / 待结算</div><div class="rr">' + settledN + ' / ' + pendingN + '</div></div>',
      '<div class="bh-dir-card"><div class="rl">方向命中率</div><div class="rr">' +
        (num(a.hit) !== null ? a.hit + '%（' + (num(a.win) || 0) + '/' + ((num(a.win) || 0) + (num(a.lose) || 0)) + '）' : '待结算') + '</div></div>',
      '<div class="bh-dir-card"><div class="rl">ROI / SE</div><div class="rr">' +
        (num(a.roi) !== null ? (a.roi > 0 ? '+' : '') + a.roi + '% / ±' + (num(a.se) !== null ? a.se : '—') + 'pt' : '待结算') + '</div></div>',
    ].join('');
    const note = settledN === 0 ?
      '当前筛选下全部待结算：无官方篮球赛果接口，方向只做赛前冻结；赛果到位后由账本回填，不会有事后造预测。' :
      (a.significant ? '样本显著。' : a.crossZero ? '|ROI|<SE 跨0，与零无差异。' : '样本偏小，不作结论。') +
      ' 命中率=方向命中（不含走水）；ROI 按冻结赔率逐注累计。' +
      (scoped ? ' <b style="color:#93c5fd">📅 已按 ' + esc(state.day) + ' 筛选：以上为当日实时计算。</b>' : ' 当前显示全部日期汇总。');
    return '<div class="bh-dir-cards" data-basket-dir-summary>' + cards + '</div>' +
      quickDayBar(allEntries.map(e => text(e.day))) +
      '<p class="bh-muted">' + esc(note) + '</p>' +
      '<p class="bh-muted">账本更新 ' + moment(new Date((num(s.updatedAt) || 0) * 1000).toISOString()) +
      ' · 规则 ' + esc(s.ruleV || '—') + ' · ' + esc(s.srcUsed || '') + '</p>';
  }
  /* ★ 2026-11-20 快捷日期筛选条：一键切日，不用再从 18 号滑到 20 号。
     全局共享 state.day（主列表/账本/过热三处联动）；点选后 delegated listener 重渲染。 */
  function quickDayBar(daysSrc) {
    const days = Array.from(new Set((daysSrc || []).filter(Boolean))).sort().reverse();
    const cur = state.day || '';
    const btn = (v, label) => '<button type="button" data-bh-quickday="' + esc(v) + '" style="cursor:pointer;margin:0 4px 4px 0;padding:3px 11px;border-radius:11px;font-size:11.5px;border:1px solid ' +
      (v === cur ? '#2563eb;background:rgba(37,99,235,.20);color:#93c5fd;font-weight:700' : 'var(--line,#334155);background:transparent;color:var(--mut,#8b98a9)') +
      '">' + esc(label) + '</button>';
    return '<div data-basket-daybar style="margin:6px 0 2px;display:flex;flex-wrap:wrap;align-items:center">' +
      '<span style="font-size:11px;color:var(--mut,#8b98a9);margin-right:4px">📅 日期</span>' +
      btn('', '全部') + days.map(d => btn(d, d.slice(5))).join('') + '</div>';
  }
  function dirLedgerTableHTML() {
    const led = state.ledger, items = object(led && led.items);
    const keys = Object.keys(items).filter(k => {
      const e = object(items[k]);
      return !state.day || text(e.day) === state.day;
    }).sort((a, b) => {
      const x = object(items[a]), y = object(items[b]);
      const kx = num(x.kickTs) || 0, ky = num(y.kickTs) || 0;
      // ★2026-11-20 默认最新日期优先（不用从最早一天滑下来）；选定某日后按当日时间正序
      return (state.day ? kx - ky : ky - kx) || a.localeCompare(b);
    });
    if (!keys.length) return '<p class="bh-muted">当前筛选下无冻结方向条目。</p>';
    const rows = keys.map(k => {
      const e = object(items[k]), settled = e.result !== null && e.result !== undefined;
      const res = settled ? ({ win: '中', lose: '未中', push: '走水' }[e.result] || e.result) : '待结算';
      return '<tr data-basket-dir-row><td>' + esc(e.day) + ' ' + esc(e.kickoff || '') + '</td><td>' +
        esc(e.home) + ' vs ' + esc(e.away) + '</td><td>' + esc(MARKETS[e.market] || e.market) + '</td><td>' +
        '<b>' + esc(e.pick) + '</b><br><small>' + esc(e.recDirText || '') + '</small></td><td>' +
        (settled && text(e.finalScore) ? '<b>' + esc(e.finalScore) + '</b>' : '—') +
        '</td><td>' +
        (settled ? res + (num(e.pl) !== null ? '（' + (e.pl > 0 ? '+' : '') + fmt(e.pl, 2) + '）' : '') : res) +
        '</td><td>' + esc(e.ruleV || '—') + '</td></tr>';
    }).join('');
    return quickDayBar(Object.values(items).map(e => text(object(e).day))) +
      '<div class="bh-scroll" tabindex="0" aria-label="篮球方向账本横向滚动表"><table><thead><tr>' +
      '<th>日期 / 开赛</th><th>对阵</th><th>玩法</th><th>冻结方向（观察）</th><th>最终比分</th><th>结算</th><th>规则</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  /* ★★ 2026-11-19 框架重构：洋哥三盘=顺序链，一盘竞彩独赢资金趋势就能给方向。
     旧版错用让分盘hdc+sfgg+要求让分线一致→大量不可比；北单缺失就跳过→丢方向。
     新版：一盘竞彩独赢(mnl)定方向(站大热门对面)，二盘365缺位标注，三盘北单共振确认。 */
  function overheatHTML() {
    const o = state.overheat;
    if (!o) return '<details class="bh-reference" id="basketHeatOverheat"><summary>三盘资金过热核对（洋哥顺序链·观察档）· 尚未生成</summary>' +
      '<p class="bh-muted">basket_overheat.json 尚未生成；不虚构判定与命中率。</p></details>';
    const s = o.summary || {};
    const allItems = o.items || [];
    // ★2026-11-20 过热表接入全局日期筛选（与主列表/账本联动）
    const items = allItems.filter(x => !state.day || text(x.day) === state.day);
    // ★2026-11-20 统计条随日期联动：按筛选后 items 前端复算，口径与服务端 summarize() 一致
    const fJudged = items.filter(x => x.hotFlag);
    const fSettled = fJudged.filter(x => x.settle);
    const fN = fSettled.length, fHit = fSettled.filter(x => x.settle === 'hit').length;
    const fHitRate = fN ? +(100 * fHit / fN).toFixed(1) : null;
    const fSe = fN ? +(Math.sqrt(fHitRate * (100 - fHitRate) / fN).toFixed(1)) : null;
    const fWithNorth = items.filter(x => x.bd).length;
    const fNoNorth = items.length - fWithNorth;
    const fReson = items.filter(x => (x.metrics || {}).resonance === '三盘共振·确认').length;
    // ★2026-11-20 二盘补位统计（前端复算，口径与服务端 summarize 一致）
    const fB365 = items.filter(x => x.b365 && x.b365.mnl).length;
    const fStrong = items.filter(x => x.strongTier).length;
    const fStrongSet = items.filter(x => x.strongTier && x.settle);
    const fSN = fStrongSet.length, fSHit = fStrongSet.filter(x => x.settle === 'hit').length;
    const fStrongRate = fSN ? +(100 * fSHit / fSN).toFixed(1) : null;
    const head = '<details class="bh-reference" id="basketHeatOverheat"><summary>三盘资金过热核对（洋哥顺序链口径·观察档）· ' +
      items.length + ' 场' + (state.day ? '（📅 ' + esc(state.day) + ' 当日）' : '') + '</summary>' +
      '<p class="bh-missing">观察档，非投注信号，不计入方向账本/引擎/仓位。<strong>洋哥三盘是顺序链：一盘竞彩独赢资金趋势→二盘365操盘→三盘北单资金分布</strong>。' +
      '本板块一盘用竞彩独赢（篮球完全可得，站大热门对面给方向）；<strong>二盘365自2026-11-20起用球探滚动帧补位</strong>（此前被567封死长期缺位，历史场无365=真实缺不回补）；' +
      '三盘北单270让分胜负两项作近似共振确认。<strong>强置信口径=三端合流：竞彩+365+北单同侧（heatScore=3/3）</strong>；北单缺失不吞一盘方向，只降档标"仅一盘"。第4步「临场盘水印证」篮球无连续序列做不到。</p>';
    // 快捷日期条（统计条上方：点哪天→下面数字立即变哪天）
    const daybar = quickDayBar(allItems.map(x => text(x.day)));
    // 统计条（★2026-11-20 足球板视觉语言：绿=命中、红=未中、橙=中热、灰=正常；数字随日期筛选联动）
    let stat = '<div style="margin:6px 0;padding:7px 9px;border-radius:7px;background:rgba(147,197,253,.08);border:1px solid rgba(147,197,253,.35);font-size:11.5px;line-height:1.7;color:#cfe3f7">';
    stat += (state.day ? '<b style="color:#93c5fd">📅 ' + esc(state.day) + ' 当日</b>' : '全部日期') +
      ' · 有方向场次 <b>' + items.length + '</b> · 二盘365有帧 <b style="color:#38bdf8">' + fB365 +
      '</b> · 北单三盘确认 <b style="color:#16a34a">' + fWithNorth +
      '</b> · 仅一盘 <b style="color:#f97316">' + fNoNorth +
      '</b> · <b style="color:#eab308">三端合流(强置信) ' + fStrong + '</b> 场' +
      (fSN > 0 ? '（已结 ' + fSHit + '/' + fSN + '=' + fStrongRate + '%）' : '') +
      ' · 明确大热门方向 <b style="color:#e54545">' + fJudged.length + '</b> 场<br>';
    if (fN > 0) {
      stat += '站对面核对：命中 <b style="color:#16a34a;font-size:13px">' + fHit + '/' + fN + '</b>' +
        ' = <b style="color:' + (fHitRate >= 50 ? '#16a34a' : '#e54545') + ';font-size:13px">' + fHitRate + '% ± ' + fSe + 'pt</b>' +
        (fN >= 40 ? '（n≥40）' : '（n&lt;40样本不足）') + '</div>';
    } else {
      stat += '<b>暂无可核对场次</b>：当前筛选下方向未触及结算或从缺赛果 → 命中率留空，不用 0% 冒充战绩。</div>';
    }
    // 逐场表：日期/对阵 | 竞彩独赢隐含(主/客) | 二盘365 | 方向(站对面) | 北单三盘 | 判定 | 赛果·结算
    let table = '<div class="bh-scroll" tabindex="0"><table style="font-size:11.5px"><thead><tr><th>日期/对阵</th><th>竞彩独赢(主/客)</th>' +
      '<th>隐含(主/客)·热度</th><th>二盘365</th><th>方向(站对面)</th><th>北单三盘(份额/共振)</th><th>判定</th><th>赛果·结算</th></tr></thead><tbody>';
    for (const x of items) {
      const m = x.metrics || {};
      // ★热度分档徽章（仿足球资金热度列：红=极端大热、橙=明确倾向、灰=趋势弱）
      const hp = num(m.hotPct);
      let heatC = '#64748b', heatBg = 'rgba(100,116,139,.12)', heatTag = '趋势弱';
      if (hp !== null && hp >= 75) { heatC = '#dc2626'; heatBg = 'rgba(220,38,38,.16)'; heatTag = '🔥极端大热'; }
      else if (hp !== null && hp >= 65) { heatC = '#e54545'; heatBg = 'rgba(229,69,69,.13)'; heatTag = '🔥大热'; }
      else if (hp !== null && hp >= 55) { heatC = '#ea580c'; heatBg = 'rgba(234,88,12,.13)'; heatTag = '明确倾向'; }
      // ★二盘365徽章：同侧绿✓ / 异侧橙⚠ / 缺灰（滚动帧·真实缺不编造）
      let b365Cell = '<span style="color:var(--mut,#8b98a9)">缺·365未动盘</span>';
      if (x.b365 && x.b365.mnl) {
        const agree = m.b365Agree;
        const p = m.p365H !== null && m.p365A !== null ? fmt(m.p365H, 0) + '/' + fmt(m.p365A, 0) + '%' : '';
        b365Cell = esc(x.b365.mnl.home) + '/' + esc(x.b365.mnl.away) + '<br>' + p +
          ' <span style="font-weight:700;color:' + (agree === true ? '#16a34a' : agree === false ? '#ea580c' : '#8b98a9') + '">' +
          (agree === true ? '✓同侧' : agree === false ? '⚠异侧' : '') + '</span>' +
          (x.b365 && x.b365.crown && x.b365.crown.hdc ? '<br><span style="color:#8b98a9">冠' + esc(x.b365.crown.hdc.line) + '</span>' : '');
      }
      // ★方向徽章（仿足球推荐方向 pill：🎯 站对面）
      const sideTxt = x.fadeSide === 'home' ? '主·' + esc(x.home) : '客·' + esc(x.away);
      const dirCell = '<span style="font-weight:800;color:' + (x.strongTier ? '#eab308' : '#60a5fa') + ';background:' +
        (x.strongTier ? 'rgba(234,179,8,.15)' : 'rgba(37,99,235,.16)') + ';border:1px solid ' +
        (x.strongTier ? '#eab308' : '#2563eb') + ';border-radius:6px;padding:2px 7px;display:inline-block;white-space:nowrap">🎯 ' + sideTxt + '</span>';
      // ★北单三盘徽章：共振绿✓ / 分歧橙⚠ / 缺灰
      let bdTxt = '缺·仅一盘', bdCell = '<span style="color:var(--mut,#8b98a9)">' + bdTxt + '</span>';
      if (x.bd && m.shareHome !== null) {
        const isReso = text(m.resonance).indexOf('共振') >= 0;
        bdTxt = fmt(m.shareHome, 0) + '/' + fmt(m.shareAway, 0) + '%';
        bdCell = bdTxt + ' <span style="font-weight:700;color:' + (isReso ? '#16a34a' : '#ea580c') + '">' + (isReso ? '✓共振确认' : '⚠分歧降档') + '</span>';
      }
      const verdictCls = x.hotFlag ? 'color:' + heatC + ';font-weight:700' : 'color:var(--mut,#8b98a9)';
      // ★三端合流(强置信)判定高亮 + 合流分
      const verdictCell = (x.strongTier ? '<span style="font-weight:800;color:#eab308;background:rgba(234,179,8,.14);border:1px solid #eab308;border-radius:6px;padding:1px 6px;display:inline-block">⭐' : '') +
        esc(x.verdict) + (x.strongTier ? '</span>' : '') +
        (m.heatScore ? '<br><span style="color:#8b98a9">合流 ' + m.heatScore + '/3</span>' : '');
      // ★结算格：绿✅中（按冻结独赢赔率给单位盈亏）/ 红❌未中 −1.00 / 灰⏳
      let setCell;
      if (x.hotFlag && x.settle === 'hit') {
        const odds = x.mnl ? num(object(x.mnl)[x.fadeSide]) : null;
        const pl = odds !== null ? odds - 1 : null;
        setCell = '<span style="color:#16a34a;font-weight:800">✅ 中' + (pl !== null ? ' +' + fmt(pl, 2) : '') + '</span>';
      } else if (x.hotFlag && x.settle === 'miss') {
        setCell = '<span style="color:#e54545;font-weight:800">❌ 未中 −1.00</span>';
      } else if (x.hotFlag) {
        setCell = '<span style="color:var(--mut,#8b98a9)">⏳ 待结算</span>';
      } else {
        setCell = '<span style="color:var(--mut,#8b98a9)">— 趋势弱·不进统计</span>';
      }
      const resCell = x.result
        ? '<b style="color:' + (x.result === 'home' ? '#e54545' : '#2563eb') + '">' + (x.result === 'home' ? '主胜' : '客胜') + '</b>' +
          (x.resultScore ? ' <b>' + esc(x.resultScore) + '</b>' : '')
        : '<span style="color:var(--mut,#8b98a9)">未完赛</span>';
      table += '<tr><td>' + esc(x.day) + '<br>' + esc(x.away) + '@' + esc(x.home) + '</td>' +
        '<td>' + esc(x.mnl ? x.mnl.home : '—') + ' / ' + esc(x.mnl ? x.mnl.away : '—') + '</td>' +
        '<td>' + fmt(m.pH, 1) + '% / ' + fmt(m.pA, 1) + '%' +
        (hp !== null ? '<br><span style="font-weight:800;color:' + heatC + ';background:' + heatBg + ';border-radius:6px;padding:1px 7px;display:inline-block;margin-top:2px">' + heatTag + ' ' + fmt(hp, 1) + '%</span>' : '') + '</td>' +
        '<td>' + b365Cell + '</td>' +
        '<td>' + dirCell + '</td>' +
        '<td>' + bdCell + '</td>' +
        '<td style="' + verdictCls + '">' + verdictCell + '</td>' +
        '<td>' + resCell + '<br>' + setCell + '</td></tr>';
    }
    table += '</tbody></table></div>';
    const foot = '<p class="bh-muted">账本 ' + esc(o.version || '') + ' · 更新 ' + moment(o.updated) + '。' +
      esc(s.caveat || '') + '</p>' +
      '<p class="bh-muted">逻辑（洋哥原文L184-201/L228-256）：三盘顺序链，切勿从三盘倒推。一盘竞彩独赢：隐含概率高方=大热门→站其对面给方向（竞彩独赢去水 pH=(1/H)/(1/H+1/A)）。' +
      '<strong>二盘365：2026-11-20起用球探(titan007)滚动帧补位（365滚动变更表 ch_nbaGoal8，含独赢/让分/总分/半场；皇冠为sbOdds第3组参考列）——t7_bb.py每5分钟只为白名单场落帧、开赛后0帧；历史场无365=真实缺，不回补。</strong>' +
      '三盘北单：100%返还池份额=1/SP归一，与一盘同侧=共振确认、异侧=分歧降档。' +
      '<strong>强置信⭐=三端合流 heatScore 3/3（竞彩+365+北单同侧）——前瞻口径：365篮球无历史源无法回测，历史战绩不含强置信档，n&lt;40不进引擎、不下注信号。</strong>' +
      '绝对大热门阈55%为观察档经验值，非洋哥原文硬阈。</p>';
    return head + daybar + stat + table + foot + '</details>';
  }
  function presetHTML() {
    const p = state.preset;
    if (!p) return '<details class="bh-reference" id="basketHeatPreset"><summary>预设盘地基（洋哥 L85）· 尚未生成</summary>' +
      '<p class="bh-muted">basket_preset.json 尚未生成；不能用 0 代替未知，也不虚构预设线。</p></details>';
    const nba = p.nba || [], unavail = p.unavailable || [];
    const head = '<details class="bh-reference" id="basketHeatPreset"><summary>预设盘地基（洋哥 L85 · 三盘地基）· ' + nba.length + ' 场 NBA 估计 + ' + unavail.length + ' 场不可用</summary>' +
      '<p class="bh-missing">观察档，非投注信号。洋哥 L85 算例推导有缺口（119+107=226 却给 215.5），本预设线为可复刻标准法估计，<strong>不是洋哥原公式</strong>；未经篮球样本外验证。样本不足（n=5&lt;40），不得宣称有效。</p>' +
      '<p class="bh-muted">方法：预设让分 = -(两队赛前滚动净胜分之差 + 主场优势3分)，力量差限幅±14（事前稳健约束）；预设总分 = 双方攻防合成。严格只用开赛前完赛场算场均，杜绝前视。主场3分源自 L85 原文假设，非拟合常量。</p>';
    let table = '<div class="bh-scroll" tabindex="0"><table><thead><tr><th>对阵</th><th>样本(主/客)</th><th>预设线</th><th>竞彩实际线</th><th>偏差</th><th>预设总</th><th>实际总</th><th>总偏差</th><th>观察</th></tr></thead><tbody>';
    for (const x of nba) {
      const pr = x.preset || {};
      const dev = x.dev || {};
      const dl = dev.line;
      const devTxt = dl === null || dl === undefined ? '—' : (dl > 0 ? '+' : '') + dl;
      const obs = !pr.ok ? '样本不足' : (pr.meetsYangGe ? '达标·观察' : '低于15场·观察') + (pr.strengthClamped ? ' ·力量差限幅' : '');
      table += '<tr><td>' + esc(x.home) + ' vs ' + esc(x.away) + '</td>' +
        '<td>' + fmt(pr.nHome, 0) + '/' + fmt(pr.nAway, 0) + '</td>' +
        '<td class="bh-price">' + fmt(pr.presetLine, 1) + '</td>' +
        '<td class="bh-price">' + fmt(x.actual && x.actual.line, 1) + '</td>' +
        '<td class="bh-price">' + devTxt + '</td>' +
        '<td class="bh-price">' + fmt(pr.presetTotal, 1) + '</td>' +
        '<td class="bh-price">' + fmt(x.actual && x.actual.total, 1) + '</td>' +
        '<td class="bh-price">' + (dev.total === null || dev.total === undefined ? '—' : (dev.total > 0 ? '+' : '') + dev.total) + '</td>' +
        '<td>' + esc(obs) + '</td></tr>';
    }
    table += '</tbody></table></div>';
    let ua = '';
    if (unavail.length) {
      ua = '<p class="bh-muted">不可用（不编造预设线）：' + unavail.map(x => esc(x.home) + ' vs ' + esc(x.away)).join('、') + '。原因：ESPN 无该联赛逐场比分/统计端点。</p>';
    }
    const verify = '<p class="bh-missing">验证结论（n=5，仅诊断）：预设线方向 3/5=60%±44.7pt、市场实际盘方向 3/5=60%±44.7pt（完全持平）、按偏差反向 2/4=50%±50pt（跨0）。<strong>样本远不足，预设盘地基暂未显示超越市场的价值，禁止进入下注引擎或宣称有效。</strong></p>';
    return head + table + ua + verify + '</details>';
  }
  function referenceHTML() {
    return '<details class="bh-reference" id="basketHeatReference"><summary>洋哥篮球原文摘录与迁移边界</summary>' +
      '<p>“5资料”参考范围：本地“洋哥资料”四份 TXT 已全文读取；以下仅短摘录、概述与出处，不打包私有教程全文。作者方法论声称与统计实证严格分开；四份 TXT 没有可直接上线的独立篮球过热阈值。</p>' +
      '<ul><li>《职业操盘手自传之盘赔我见.txt》L23：作者讨论 NBA 等大赛事受注容量与小比赛失衡风险；L145、L171 提醒“小比赛慎用”。这不是本板已经取得成交资金或完成样本容量检验的证据。</li>' +
      '<li>同文 L27：篮球“绝杀，压哨”体现偶然性；L39：比赛结果具有不确定性。L31 的 NBA 个人数据段仅概述为体育诚信与异常数据风控风险，不提供任何违规方法，也不据此指控具体比赛。</li>' +
      '<li>同文 L85 完整篮球算例（概述）：要求至少 15–20 场样本；国王场均得分 116、主场 119，篮网场均 110、客场 107；作者给出大小分 215.5–216.5。共同对手湖人：篮网客让 4.5、国王客让 3.5；作者称实力差 1 分、主场优势 3 分，给出国王主让 1.5。</li>' +
      '<li><strong>算例不能当生产公式：</strong>119 + 107 = 226，不能直接推导 215.5–216.5，原文缺少这一步推导。实力差与主场相加到主让 1.5，也缺少比较场地、主客转换和盘口方向的完整细节；不自行补公式。主场 3 分是例中假设，不是固定常量；15–20 场也不是已验证的充分样本门槛。</li>' +
      '<li>同文 L217 提到另有篮球开初值文章，当前参考附件未附；《洋哥自传.doc》对应段 81 与 188 为本次需求提供的已核定位，不表示本脚本从 DOC 推导了新规则。</li>' +
      '<li>《关于资金流速详解.txt》L2–6 与主文 L193–199：阅读顺序是一盘→二盘→三盘，不从三盘倒推；作者以赔率解释“流速”，但只有赔率与时间戳，无法测量绝对资金进入速度或真实资金百分比。本板只展示报价与同线概率 Δpp。</li>' +
      '<li>《关于盘级换算详解.txt》L3–10 为足球盘口区间；《北单赔率池赔率查询网址.txt》L3–11 的资金、返还与偏差阈值是作者声称，不是篮球实证。足球 0.25 球、4.7pt、heatScore&gt;=3 均不套篮球；亦不迁移其 15% 等足球示例阈值。</li></ul>' +
      '<p><strong>数学口径：</strong>对有效完整同玩法报价 O，R = 1 / sum(1/O)，q = (1/O) / sum(1/O)。换返还 O* = O × Rref / Rsrc。只有同玩法、同盘口线、同选项方向、同结算口径且报价制式与时间核实后才可比；当前不启用跨源换算差值，更不把北单让分对独赢相减。北单 q 仅称“池赔率归一份额”（未核返还 / 规则，不是真资金百分比）。</p>' +
      '<p><strong>证据与迁移边界：</strong>不采纳“庄家永不亏”“100%真实资金”等无统计验证的断言；没有经过篮球按时间留出 / 前向验证，不输出强推或下注信号。胜率：尚未建立 / 待前向样本；ROI：尚未建立 / 待前向样本，不用 0% 冒充战绩。</p>' +
      '<p>数据白名单：basket-observe-1.1 的竞彩 basketball 接口比赛 ID；仅读取同源 basket_heat.json，不混入足球 MATCHES、足球热度分或其他赛程候选。独立采集流水目录 D:/北单竞彩数据/篮球（原始响应 / 快照流水）；本前端不访问本机目录，也不把 Bet365 候选赛程数当作已关联场数。</p></details>';
  }
  function statusHTML(data) {
    return Object.keys(SOURCES).map(source => {
      const s = object(object(data.sourceStatus)[source]);
      return '<div class="bh-status" data-basket-source-status="' + source + '"><strong>' + SOURCES[source] + ' · ' +
        esc(STATES[s.state] || s.state || '未知') + '</strong>' + (s.state === 'cached_sample' ? '<p>导入时间 ' + moment(s.imported_at) +
        '<br>原始采集时刻 ' + moment(s.observed_at) + '；采集时刻核验 ' + flag(s.captureTimeVerified, '已核', '未核') + '</p>' :
        '<p>尝试 ' + moment(s.attempted_at) + '<br>最近成功 ' + moment(s.lastSuccess) + '</p>') +
        '<p>源返回计数 ' + fmt(s.count, 0) + '（' + (source === 'eu' ? '候选赛程，不是已取报价' : source === 'bd' ? '源侧记录，不是已关联数' : '源侧有效名单') + '）</p>' +
        '<p class="bh-missing">' + esc(sourceErrors(data, source)) + (s.reason ? '；' + esc(s.reason) : '') + (s.stopped === true ? '；此源已停用，不绕过重试' : '') + '</p></div>';
    }).join('');
  }
  function render() {
    if (!state.data) return;
    const data = state.data, rows = data.rows, totals = object(data.totals), market = state.market;
    const banner = modal.querySelector('#basketHeatModeNotice');
    banner.hidden = !imported(data);
    banner.textContent = imported(data) ? IMPORT_NOTICE : '';
    const days = Array.from(new Set(rows.map(r => r.day))).sort();
    const select = modal.querySelector('#basketHeatDay');
    select.innerHTML = '<option value="">全部日期</option>' + days.map(d => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('');
    if (state.day && !days.includes(state.day)) select.insertAdjacentHTML('beforeend', '<option value="' + esc(state.day) + '">' + esc(state.day) + '（本次无场）</option>');
    select.value = state.day;
    const needle = state.keyword.trim().toLocaleLowerCase();
    const filtered = rows.filter(row => (!state.day || row.day === state.day) && (!state.selling || sale(row, market)) &&
      (!needle || [row.home, row.away, row.league, row.id, row.no, row.day].map(text).join(' ').toLocaleLowerCase().includes(needle)))
      .slice().sort((a, b) => timestamp(a.kickoff) - timestamp(b.kickoff) || a.id.localeCompare(b.id));
    const jcCount = rows.filter(r => quote(object(r.markets)[market], market)).length;
    const euCount = rows.filter(r => quote(object(object(r.eu).markets)[market], market)).length;
    const bdCount = rows.filter(r => bdQuote(object(object(r.bd).markets).sfgg)).length;
    modal.querySelector('#basketHeatSummary').innerHTML = '<p><strong data-basket-total="' + rows.length + '">' + rows.length +
      ' 场竞彩篮球白名单比赛</strong> · 本次筛选 ' + filtered.length + ' 场 · ' + MARKETS[market] + '</p><p>' +
      (imported(data) ? '导入 / 结果生成时间 ' : '结果生成时间 ') + moment(data.updated) +
      '（不是抓取时点） · ' + (imported(data) ? '快照导入结果，非本轮实时采集成功' : data.collectionOk === true ? '采集器报告本轮完整成功' : '采集不完整 / 有源失败或部分成功') + '</p>' +
      '<p>所选玩法原始报价覆盖：竞彩 ' + jcCount + ' 场 / Bet365 ' + euCount + ' 场；北单 sfgg 原始 SP ' + bdCount +
      ' 场（不代表同玩法可比）。<strong>已核跨源三盘可比：尚未建立。</strong></p><p class="bh-muted">采集器总量：新鲜竞彩 ' + fmt(totals.freshJC, 0) +
      '；北单关联 ' + fmt(totals.bdLinked, 0) + '；Bet365 候选赛程 ' + fmt(totals.euSchedule, 0) + '；Bet365 关联 ' + fmt(totals.euLinked, 0) +
      '。保留旧行：' + flag(object(data.evidence).retainedPreviousRows, '是', '否') + '。</p>' +
      (text(object(data.evidence).externalLinkBlocker) ? '<p class="bh-missing">外源关联阻断：' + esc(data.evidence.externalLinkBlocker) + '</p>' : '') +
      '<p class="bh-muted">胜率 / ROI：见下方「方向观察账本」；未结算前不给数字。</p>';
    modal.querySelector('#basketHeatSourceStatus').innerHTML = statusHTML(data);
    modal.querySelector('#basketHeatDirSummary').innerHTML = dirLedgerSummaryHTML();
    modal.querySelector('#basketHeatDirTable').innerHTML = dirLedgerTableHTML();
    const presetSlot = modal.querySelector('#basketHeatPresetSlot');
    if (presetSlot) presetSlot.innerHTML = presetHTML();
    const overheatSlot = modal.querySelector('#basketHeatOverheatSlot');
    if (overheatSlot) overheatSlot.innerHTML = overheatHTML();
    modal.querySelector('#basketHeatRows').innerHTML = filtered.length ? filtered.map(rowHTML).join('') :
      '<div class="bh-empty" data-basket-empty><strong>' + (rows.length ? '当前独立筛选下 0 场' : '0 场：没有可信竞彩篮球名单，不能构造三盘齐全画面') +
      '</strong><p>' + (rows.length ? '请调整日期、关键词或在售条件；不会修改足球筛选。' : 'Bet365 候选赛程不等于已取得本场报价；缺竞彩身份时不补造比赛。请查看上方逐源错误。') + '</p></div>';
  }
  function validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 'basket-observe-1.1' || !Array.isArray(data.rows))
      throw new Error('篮球 JSON 契约不符：需要 basket-observe-1.1 与 rows 数组');
    if (imported(data) && (data.observed_at !== null || data.captureTimeVerified !== false))
      throw new Error('导入快照契约不符：原始采集时刻必须为 null 且 captureTimeVerified=false');
    // 离线导入结果没有 evidence.jc；仍限定版本、导入模式与下方篮球比赛身份。
    if (!imported(data) || object(data.evidence).jc !== undefined) {
      let url;
      try { url = new URL(object(data.evidence).jc); } catch (_) { throw new Error('缺少已核篮球来源证据，拒绝混入足球数据'); }
      if (url.protocol !== 'https:' || url.hostname !== 'webapi.sporttery.cn' || !url.pathname.startsWith('/gateway/uniform/basketball/'))
        throw new Error('来源不在竞彩 basketball 白名单内');
    }
    const seen = new Set();
    data.rows.forEach(raw => {
      const row = object(raw), id = text(row.id);
      if (!/^\d+$/.test(id) || seen.has(id) || !text(row.home).trim() || !text(row.away).trim() ||
          !/^\d{4}-\d{2}-\d{2}$/.test(text(row.day)) || timestamp(row.kickoff) === null)
        throw new Error('篮球 rows 含无效身份、主客、日期、开赛时间或重复 ID；保留上次成功画面');
      seen.add(id);
    });
    return Object.assign({}, data, { rows: data.rows.map(row => Object.assign({}, row, { id: text(row.id) })) });
  }
  async function loadLedger(baseURL) {
    try {
      const url = new URL('basket_dir_ledger.json', baseURL);
      if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) return;
      const response = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
      if (!response.ok) return;
      const d = await response.json();
      if (d && typeof d === 'object' && d.items && typeof d.items === 'object' && d.summary && typeof d.summary === 'object') state.ledger = d;
    } catch (_) { /* 账本缺失不影响观察板主画面 */ }
  }
  async function loadPreset(baseURL) {
    try {
      const url = new URL('basket_preset.json', baseURL);
      if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) return;
      const response = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
      if (!response.ok) return;
      const d = await response.json();
      if (d && typeof d === 'object' && Array.isArray(d.nba)) state.preset = d;
    } catch (_) { /* 预设盘地基缺失不影响观察板主画面 */ }
  }
  async function loadOverheat(baseURL) {
    try {
      const url = new URL('basket_overheat.json', baseURL);
      if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) return;
      const response = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
      if (!response.ok) return;
      const d = await response.json();
      if (d && typeof d === 'object' && Array.isArray(d.items) && d.summary && typeof d.summary === 'object') state.overheat = d;
    } catch (_) { /* 过热核对账本缺失不影响观察板主画面 */ }
  }
  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    const refreshButton = modal.querySelector('#basketHeatRefresh');
    const notice = modal.querySelector('#basketHeatNotice');
    refreshButton.disabled = true;
    notice.className = 'bh-notice';
    notice.textContent = '正在读取同源篮球 JSON；只刷新本板块，不重载全站。';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = new URL('basket_heat.json', scriptURL || window.location.href);
      if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) throw new Error('必须以 HTTP(S) 同源加载 basket_heat.json');
      const response = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const next = validate(await response.json());
      const previous = state.data;
      state.data = next;
      await loadLedger(scriptURL || window.location.href);
      await loadPreset(scriptURL || window.location.href);
      await loadOverheat(scriptURL || window.location.href);
      try { render(); } catch (error) { state.data = previous; if (previous) render(); throw error; }
      notice.className = 'bh-notice';
      notice.textContent = (imported(next) ? IMPORT_NOTICE + '。updated 仅为导入 / 结果生成时间。' : '已读取本次采集结果；报价可能为历史快照，以各端观察时点和逐源状态为准。') + '只手动刷新，无自动定时。';
    } catch (error) {
      notice.className = 'bh-notice bh-error';
      notice.textContent = '篮球数据读取失败：' + (error && error.name === 'AbortError' ? '请求超过 15 秒' : text(error && error.message) || '未知错误') +
        (state.data ? '。已保留上次成功画面、原时点标识和筛选，旧画面不代表本次成功。' : '。尚无成功快照，不展示虚构比赛；可点击“刷新篮球数据”重试。');
    } finally {
      clearTimeout(timeout);
      state.loading = false;
      refreshButton.disabled = false;
    }
  }
  function styles() {
    if (document.getElementById('basketHeatStyle')) return;
    const style = document.createElement('style');
    style.id = 'basketHeatStyle';
    style.textContent = `
#basketHeatModal{position:fixed;inset:0;z-index:70;display:none;overflow:auto;background:rgba(0,0,0,.72);color:var(--fg,var(--txt,#e6edf3));font-size:13px;line-height:1.65;overscroll-behavior:contain}
#basketHeatModal.show{display:block}
#basketHeatModal *{box-sizing:border-box}
#basketHeatModal .mbox{max-width:1440px;margin:14px auto;padding:16px;border:1px solid var(--line,#2c3848);border-radius:14px;background:var(--card,#1a2230);color:inherit}
#basketHeatModal h2,#basketHeatModal h3,#basketHeatModal h4{color:inherit;margin:0 0 8px}
#basketHeatModal h2{font-size:18px}#basketHeatModal h3{font-size:16px;overflow-wrap:anywhere}#basketHeatModal h4{font-size:14px}
#basketHeatModal p{margin:6px 0;overflow-wrap:anywhere}#basketHeatModal small{font-size:12px;font-weight:400;color:var(--mut,#8b98a9)}
#basketHeatModal .bh-head,#basketHeatModal .bh-filters{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between}
#basketHeatModal .bh-head{margin-bottom:8px}#basketHeatModal .bh-filters{justify-content:flex-start;padding:12px 0}
#basketHeatModal label{display:flex;align-items:center;gap:6px}#basketHeatModal input,#basketHeatModal select,#basketHeatModal button{font:inherit;color:inherit;background:var(--bg,#0f1419);border:1px solid var(--line,#2c3848);border-radius:8px;padding:7px 9px}
#basketHeatModal button{cursor:pointer}#basketHeatModal button:disabled{opacity:.6;cursor:wait}#basketHeatModal :focus-visible{outline:2px solid var(--mut,#8b98a9);outline-offset:3px}
#basketHeatModal .bh-notice,#basketHeatModal .bh-empty,#basketHeatModal .bh-reference,#basketHeatModal .bh-summary{padding:12px;border:1px solid var(--line,#2c3848);border-radius:10px;margin:10px 0;background:var(--bg,#0f1419)}
#basketHeatModal .bh-mode-warning{padding:14px;margin:10px 0;border:3px solid currentColor;border-radius:10px;font-size:16px;font-weight:800;background:var(--bg,#0f1419);color:var(--fg,var(--txt,#e6edf3))}
#basketHeatModal .bh-error{border:2px solid currentColor;font-weight:700}#basketHeatModal .bh-muted,#basketHeatModal .bh-missing{color:var(--mut,#8b98a9)}
#basketHeatModal .bh-missing{overflow-wrap:anywhere}#basketHeatModal .bh-statuses,#basketHeatModal .bh-three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
#basketHeatModal .bh-status,#basketHeatModal .bh-source{padding:12px;border:1px solid var(--line,#2c3848);border-radius:10px;min-width:0;background:var(--bg,#0f1419)}
#basketHeatModal .bh-match{margin:16px 0;border:1px solid var(--line,#2c3848);border-radius:12px;padding:14px;background:var(--card,#1a2230)}
#basketHeatModal .bh-match header{padding-bottom:8px}#basketHeatModal .bh-match footer{margin-top:12px;border-top:1px solid var(--line,#2c3848);padding-top:10px}
#basketHeatModal .bh-price{font-variant-numeric:tabular-nums;font-weight:700}#basketHeatModal details{margin:10px 0}#basketHeatModal summary{cursor:pointer;font-weight:700;white-space:normal}
#basketHeatModal .bh-dir{padding:12px;border:1px solid var(--line,#2c3848);border-radius:10px;margin:12px 0;background:var(--card,#1a2230)}
#basketHeatModal .bh-dir-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:10px 0}
#basketHeatModal .bh-dir-card{padding:10px;border:1px solid var(--line,#2c3848);border-radius:8px;background:var(--bg,#0f1419);text-align:center}
#basketHeatModal .bh-dir-card .rl{font-size:12px;color:var(--mut,#8b98a9)}
#basketHeatModal .bh-dir-card .rr{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:4px}
#basketHeatModal [data-basket-direction]{margin:8px 0;padding:8px;border-left:3px solid #b45309;background:var(--bg,#0f1419);border-radius:0 6px 6px 0}
#basketHeatModal [data-basket-dir-entry]{margin:4px 0}
@media(max-width:900px){#basketHeatModal .bh-dir-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
#basketHeatModal .bh-scroll{max-width:100%;overflow-x:auto;border:1px solid var(--line,#2c3848);border-radius:6px}#basketHeatModal table{width:100%;min-width:660px;border-collapse:collapse;font-size:12px;color:inherit}
#basketHeatModal th,#basketHeatModal td{text-align:left;padding:8px;border-bottom:1px solid var(--line,#2c3848);vertical-align:top}#basketHeatModal ul{padding-left:22px}#basketHeatModal li{margin:8px 0}
#btnBasketHeat{color:var(--fg,var(--txt,#e6edf3));border-color:var(--line,#2c3848)}
@media(max-width:900px){#basketHeatModal .bh-three,#basketHeatModal .bh-statuses{grid-template-columns:1fr}#basketHeatModal .mbox{margin:8px;padding:12px}#basketHeatModal .bh-match{padding:10px}#basketHeatModal .bh-filters label{flex-wrap:wrap}#basketHeatModal #basketHeatKeyword{max-width:100%;width:190px}}
`;
    document.head.appendChild(style);
  }
  function mountButton() {
    const bar = document.querySelector('.tbr');
    let button = document.getElementById('btnBasketHeat');
    if (!button) {
      button = document.createElement('button');
      button.id = 'btnBasketHeat';
      button.type = 'button';
      button.className = 'sec';
      button.textContent = '篮球版三盘资金过热';
      button.setAttribute('aria-controls', 'basketHeatModal');
      button.setAttribute('aria-haspopup', 'dialog');
      (bar || document.body).appendChild(button);
    } else if (bar && button.parentNode !== bar) bar.appendChild(button);
    button.onclick = window.openBasketHeat;
    if (bar && observer) { observer.disconnect(); observer = null; }
    return !!bar;
  }
  function init() {
    if (modal) return;
    styles();
    modal = document.getElementById('basketHeatModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'basketHeatModal';
      document.body.appendChild(modal);
    }
    modal.classList.add('modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'basketHeatTitle');
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = '<div class="mbox"><div class="bh-head"><h2 id="basketHeatTitle">篮球版三盘资金过热板块 · 仅观察</h2>' +
      '<div><button type="button" id="basketHeatRefresh">刷新篮球数据</button> <button type="button" id="basketHeatClose" aria-label="关闭篮球观察板块">关闭</button></div></div>' +
      '<div id="basketHeatModeNotice" class="bh-mode-warning" data-basket-mode-notice role="status" hidden></div>' +
      '<p>独立于足球；一盘→二盘→三盘仅作数据观察。尚无经篮球留出标定的强推 / 下注信号，报价不等于真实资金。</p>' +
      '<div id="basketHeatNotice" class="bh-notice" role="status" aria-live="polite">尚未读取；首次打开时读取同源 basket_heat.json，无自动定时。</div>' +
      '<div id="basketHeatSummary" class="bh-summary"><p>总场数 / 结果生成时间：尚未读取，不用 0 代替未知。</p><p>胜率、ROI：尚未建立 / 待前向样本。</p></div>' +
      '<div id="basketHeatSourceStatus" class="bh-statuses"></div>' +
      '<details class="bh-dir" id="basketHeatDir" open><summary>方向观察账本 · 赛前冻结 + 逐场复盘（观察档，非投注建议）</summary>' +
      '<p class="bh-muted">方向=竞彩真实报价去水隐含概率倾向方（赔率观察，不是资金流向 / 非有 edge 的下注建议）；首登冻结、后续算法改版不回写；结算只认已核验的外部赛果，当前待结算。足球方向账本规则与业绩不可混入。</p>' +
      '<div id="basketHeatDirSummary" class="bh-summary"></div>' +
      '<div id="basketHeatDirTable"></div></details>' +
      '<div id="basketHeatPresetSlot"></div>' +
      '<div id="basketHeatOverheatSlot"></div>' +
      '<div class="bh-filters"><label>独立日期 <select id="basketHeatDay" data-basket-filter="day"><option value="">全部日期</option></select></label>' +
      '<label>市场 <select id="basketHeatMarket" data-basket-filter="market"><option value="mnl">mnl · 胜负 / 独赢</option><option value="hdc">hdc · 让分胜负</option><option value="hilo">hilo · 大小分</option></select></label>' +
      '<label>关键词 <input type="search" id="basketHeatKeyword" data-basket-filter="keyword" placeholder="队名 / 联赛 / 篮球 ID"></label>' +
      '<label><input type="checkbox" id="basketHeatSelling" data-basket-filter="selling">只看所选玩法赛前在售（排除旧行）</label></div>' +
      '<div id="basketHeatRows"></div>' + referenceHTML() + '</div>';
    modal.querySelector('#basketHeatRefresh').addEventListener('click', refresh);
    modal.querySelector('#basketHeatClose').addEventListener('click', window.closeBasketHeat);
    modal.querySelector('#basketHeatDay').addEventListener('change', event => { state.day = event.target.value; render(); });
    modal.querySelector('#basketHeatMarket').addEventListener('change', event => {
      if (Object.prototype.hasOwnProperty.call(MARKETS, event.target.value)) { state.market = event.target.value; render(); }
    });
    modal.querySelector('#basketHeatKeyword').addEventListener('input', event => { state.keyword = event.target.value; render(); });
    modal.querySelector('#basketHeatSelling').addEventListener('change', event => { state.selling = event.target.checked; render(); });
    modal.addEventListener('click', event => {
      // ★快捷日期条（主列表/账本/过热三表联动）：点 pill 即切日
      const qb = event.target.closest('[data-bh-quickday]');
      if (qb) { state.day = qb.getAttribute('data-bh-quickday') || ''; render(); return; }
      if (event.target === modal) window.closeBasketHeat();
    });
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); window.closeBasketHeat(); }
      if (event.key === 'Tab') {
        const focusables = Array.from(modal.querySelectorAll('button:not(:disabled),select,input,summary,[tabindex="0"]')).filter(el => el.getClientRects().length);
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    if (!mountButton()) {
      observer = new MutationObserver(mountButton);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }
  window.openBasketHeat = function () {
    init();
    if (!modal.classList.contains('show')) state.focus = document.activeElement;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    modal.querySelector('#basketHeatClose').focus();
    if (!state.data && !state.loading) refresh();
  };
  window.closeBasketHeat = function () {
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    if (state.focus && state.focus.isConnected) state.focus.focus();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
