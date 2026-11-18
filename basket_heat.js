/* 独立篮球观察板块；以外链 defer 加载，不调用足球引擎或改写足球筛选。 */
(function () {
  'use strict';
  if (window.__basketHeatLoaded) return;
  window.__basketHeatLoaded = true;

  const MARKETS = { mnl: '胜负 / 独赢', hdc: '让分胜负', hilo: '大小分' };
  const SOURCES = { jc: '竞彩篮球', eu: 'Bet365（公开转引）', bd: '北单胜负过关' };
  const STATES = { ok: '成功', partial: '部分成功', error: '失败', blocked: '停用 / 访问受限', pending: '等待', cached_sample: '已导入缓存快照（非实时采集成功）', not_connected: '未接入' };
  const IMPORT_NOTICE = '真实抓取快照导入·非实时·采集时刻未核，不计赛前意见';
  const state = { data: null, ledger: null, day: '', market: 'mnl', keyword: '', selling: false, loading: false, focus: null };
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
  function dirLedgerSummaryHTML() {
    const led = state.ledger, s = led && object(led.summary);
    if (!s || !num(s.total)) return '<p data-basket-dir-summary>方向账本尚未生成；当前无赛前冻结方向可展示，不用 0 代替未知。</p>';
    const a = object(s.all), settledN = num(s.settled) || 0, pendingN = num(s.pending) || 0;
    const cards = [
      '<div class="bh-dir-card"><div class="rl">冻结方向</div><div class="rr">' + s.total + ' 条 / ' +
        (num(s.pre) || 0) + ' 赛前</div></div>',
      '<div class="bh-dir-card"><div class="rl">已结算 / 待结算</div><div class="rr">' + settledN + ' / ' + pendingN + '</div></div>',
      '<div class="bh-dir-card"><div class="rl">方向命中率</div><div class="rr">' +
        (num(a.hit) !== null ? a.hit + '%（' + (num(a.win) || 0) + '/' + ((num(a.win) || 0) + (num(a.lose) || 0)) + '）' : '待结算') + '</div></div>',
      '<div class="bh-dir-card"><div class="rl">ROI / SE</div><div class="rr">' +
        (num(a.roi) !== null ? (a.roi > 0 ? '+' : '') + a.roi + '% / ±' + (num(a.se) !== null ? a.se : '—') + 'pt' : '待结算') + '</div></div>',
    ].join('');
    const note = settledN === 0 ?
      '当前全部待结算：无官方篮球赛果接口，方向只做赛前冻结；赛果到位后由账本回填，不会有事后造预测。' :
      (a.significant ? '样本显著。' : a.crossZero ? '|ROI|<SE 跨0，与零无差异。' : '样本偏小，不作结论。') +
      ' 命中率=方向命中（不含走水）；ROI 按冻结赔率逐注累计。';
    return '<div class="bh-dir-cards" data-basket-dir-summary>' + cards + '</div>' +
      '<p class="bh-muted">' + esc(note) + '</p>' +
      '<p class="bh-muted">账本更新 ' + moment(new Date((num(s.updatedAt) || 0) * 1000).toISOString()) +
      ' · 规则 ' + esc(s.ruleV || '—') + ' · ' + esc(s.srcUsed || '') + '</p>';
  }
  function dirLedgerTableHTML() {
    const led = state.ledger, items = object(led && led.items);
    const keys = Object.keys(items).filter(k => {
      const e = object(items[k]);
      return !state.day || text(e.day) === state.day;
    }).sort((a, b) => {
      const x = object(items[a]), y = object(items[b]);
      return (num(x.kickTs) || 0) - (num(y.kickTs) || 0) || a.localeCompare(b);
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
    return '<div class="bh-scroll" tabindex="0" aria-label="篮球方向账本横向滚动表"><table><thead><tr>' +
      '<th>日期 / 开赛</th><th>对阵</th><th>玩法</th><th>冻结方向（观察）</th><th>最终比分</th><th>结算</th><th>规则</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
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
    modal.addEventListener('click', event => { if (event.target === modal) window.closeBasketHeat(); });
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
