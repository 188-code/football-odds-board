


















/* engine.js — 庄家视角信号引擎（前端移植自 engine.py，纯函数，可单测）
 * 同时兼容浏览器(<script src>)与 Node(module.exports)。
 * 字段语义（gqj2.tv oddshistorypc，二十八修 2026-10-08 裁定，推翻旧"d/e/f=垃圾"误判）：
 *   每条记录 = 一家公司单条快照；a/b/c = 该时刻即时盘；d/e/f = 该公司本场初盘（开盘价）。
 *   asia: a=即时让球 b=即时上水 c=即时下水 | d=初盘让球 e=初盘上水 f=初盘下水
 *   eu  : a=即时平   b=即时主   c=即时客   | d=初盘平   e=初盘主   f=初盘客
 *   bs  : a=即时盘口 b=即时大球水 c=即时小球水 | d=初盘盘口 e=初盘大球水 f=初盘小球水
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { for (const k in (root.__ENGINE = factory())) root[k] = root.__ENGINE[k]; }
})(typeof self !== 'undefined' ? self : this, function () {

/* 引擎版本戳 ★ 改动任何影响结论的算法（λ/μ 拆分、OU 门槛、半全场透传…）都必须 +1。
   用途：离线快照 bake_pack.json 的 packs[tid].an 会带上 _ev；合并时若版本不一致就自动重算，
   否则「只补不覆盖」会把旧引擎的结论永久锁死在首屏（2026-10-03 踩过：引擎改了三代，
   754 条离线结论还停在 10-02，用户首屏看到旧口径、批量分析完才变新口径）。 */
/* ⚠ 版本戳是「离线快照 an 是否要重算」的唯一依据，参数门改了也必须 bump！
   2026-10-04 踩坑：五修把 t1 门 0.70→0.80、六修给深盘绕过加 _mkTier==='主胜/客胜' 两个条件，
   但 ENGINE_V 没动 ⇒ bake_pack 里那 930 条 an 全打的是旧戳，_recalc_bake_an.cjs / _merge_analysis.cjs
   的版本门认不出它们陈旧，CDP 一查线上 t1 仍有 44 场 mk<0.80（全是 snapshot:true 的旧结论在说话）。
   ⇒ 以后凡是动到「结论口径」的改动（含门槛数值、门控条件），都要顺手改这个戳，再跑 _recalc_bake_an.cjs。 */
const ENGINE_V = '2026-11-06-vote-engine-v1';  // 🔴 2026-11-05 修 TDZ 根因：判档段4852引用 lvlDiff，但它 yg构造5067才定义→ReferenceError被外层catch吞→an.yg恒null(19场受害)。改用 lvlDiffVsReal/table/bdLvlDiff/lvlFlip 重建等价判定。
                                            //     2026-10-12b：#305 扩展——强档剔除不再只看联赛名，联赛名"国际友谊"等主流名下藏 U19/女足/青年队也被一并降权（用户曾投诉 U21/U19 错标强档），故 _leagueHtFlag 同时扫描 home/away 队名。
                                            //     正确判据下逐格受让覆盖 44~57%，全线低于 54.1% 盈亏线，无 alpha → 回到「无方向」；
                                            //     十三修市场认同门 / 十四修小球线区 [2.5,3.0] 保留；见 ou_stable 下方 ASIA_PICK 块）
                                            //     十五修后续（2026-10-05）：另发现旧 `_gate_validate.cjs` 判据符号笔误（net+hcap），此处数字不再引用。
                                              //         十三修：tier1 叠加市场认同门 p_mkt>=0.65（60.4%→75.9%）
                                              //         十四修：小球线区收窄到 [2.5,3.0]；十修的整数线禁判保留

/* ===== 最终出手门门槛（2026-10-05 九修→十九修，工厂顶层作用域；analyze 与 auto_pick 共用同一套）=====
 * 声明在顶层而非 analyze 内部，是为了让 auto_pick.cjs（require('./engine.js')）能读到同一份数值，
 * 避免「引擎用 0.72、选场脚本还在判 0.70」这种两边不同步的老毛病。
 *
 * 🔴 十九修（2026-10-05h）：T1_H 0.72→0.80、T1_A 0.75→0.80（**与上面 _mkTier 的 0.80 市场闸门对齐**）。
 *   依据：`_eval/_hslice12.cjs`——用**当前引擎**在 14 天真赔率缓存上重跑 6656 场（干净口径，
 *   不是 live_log 那种跨版本混合账本），t1 池 n=350 命中 91.1%，按市场最大概率 mk 分带：
 *     mk 0.70~0.75 →  25 场 84.0%（前段 76.5 / 后段 100.0）  ← 场次太薄
 *     mk 0.75~0.80 →  76 场 78.9%（前段 78.0 / 后段 80.0）   ← 🔴 两段都差，是「温吞陷阱带」
 *     mk 0.80~0.85 → 118 场 94.9%（前段 94.0 / 后段 96.1）
 *     mk 0.85~0.90 → 128 场 96.1%（前段 95.9 / 后段 96.3）
 *   ⇒ mk≥0.80 共 249 场命中 **95.6%**（前段 95.1 n=143 / 后段 96.2 n=106，两段同向且都过 n=120）。
 *   根因：八修把下注门设成 0.72/0.75，比 _mkTier 的 0.80 松，于是一批 mk 0.72~0.80 的场被
 *   放进 t1（101 场、命中仅 80.2%）——它们不是"模型看错"，是**市场自己也没定准的温吞盘**。
 *   改善：t1 350 场/91.1% → 249 场/95.6%（+4.5pp），代价是下注池 -29%。
 *   ⚠ 未测：ROI（fund_log/live_log 都不含赔率快照，硬算就是造假）。命中率口径已由留出验证背书。
 *
 * 🔴 二十修（2026-10-05i）：T2_H 0.65→0.72、T2_A 0.68→0.72（同步收紧观察档，依据同一次干净重跑）。
 *   t2 的旧门同样立在**不可信口径**上（八修用 live_log 2677 场标定，而 live_log 3973 条全是跨版本
 *   污染的 legacy 记录）。用 `_eval/_hs13_t2.cjs` 在同一份干净重跑（ev=h-pick80）上分带：
 *     mk 0.65~0.68 →  79 场 命中 49.4% alpha **−17.2pp**（前 42.9 / 后 56.8）← 灾难带
 *     mk 0.68~0.70 →  56 场 命中 57.1% alpha **−11.8pp**（前 51.9 / 后 62.1）
 *     mk 0.70~0.72 →  27 场 命中 55.6% alpha **−15.5pp**（前 64.3 / 后 46.2，两段翻转）
 *     mk 0.72~0.75 →  39 场 命中 82.1% alpha **+8.6pp**（前 71.4 / 后 94.4）
 *     mk 0.75~0.80 →  76 场 命中 78.9% alpha  +1.2pp（前 78.0 / 后 80.0）
 *   ⇒ **分界线极干净：mk<0.72 全负 alpha（−11.8~−17.2pp）、mk≥0.72 转正（+1.2~+8.6pp）**。
 *   t2 池：278 场/命中 64.4%/显示概率 71.5%（**alpha −7.1pp，即模型显示概率系统性高估 7pp**）
 *         → 116 场/命中 80.2%/alpha **+3.9pp**（前段 76.2 n=58 / 后段 84.9 n=58，两段同向）。
 *   含义：t2 那 162 场不是"低置信参考"，是**显示概率高估**——用户看到 71% 实际只有 52%，属误导。
 *   门值取 0.72 而非 0.70：0.70~0.72 带 alpha −15.5pp 且两段翻转，留在池内会污染。 */
const PICK_GATE = { T1_H: 0.72, T1_A: 0.72, T2_H: 0.72, T2_A: 0.72 };  // 🔴 二十七修（2026-10-07o）：t1 终局门 0.80→0.72。初盘真实化(26修)后 _pPick(押向市场概率)被真实化——0.80 只收极端场(每天0-2场)=判 t1 死刑；0.72 收真实强队场(仍是高命中池)。与 _mkTier 闸门(2932)同步。用户批准"降到 0.72 恢复 t1"。

/* 十三修：tier1 的「市场认同门」下限 —— 市场对本方向概率低于此值即降级为 tier2。
   取值依据见 analyze() 末尾同名的十三修块（live_log 分层实测 60.4% → 75.9%）。 */
const MARKET_ALIGN_MIN = 0.65;
let mktAlign = null;      // 仅在因市场认同不足被降级时才有值

const KB = {
  meta: "足彩技法知识库（整合自 zip 文库：今何在/孤行/田伟/秦俑/米客/黄埔/盘子）。",
  tiers: ["超强","人强","普强","准强","中强","中上","中游","中下","下游"],
  strength_handicap: {
    note: "广实差(主客档位差)→预期亚盘让球(以主队视角)。公式: expected=0.25+2.5*(主胜概率-客胜概率)。",
    table: [
      {"gap":"同档","diff_desc":"0档","home_hcap":0.25,"away_hcap":0.0},
      {"gap":"主高半档","diff_desc":"0.5档","home_hcap":0.5,"away_hcap":-0.25},
      {"gap":"主高一档","diff_desc":"1档","home_hcap":0.75,"away_hcap":-0.5},
      {"gap":"主高1.5档","diff_desc":"1.5档","home_hcap":1.0,"away_hcap":-0.75},
      {"gap":"主高两档","diff_desc":"2档","home_hcap":1.25,"away_hcap":-1.0},
      {"gap":"主高2.5档","diff_desc":"2.5档","home_hcap":1.5,"away_hcap":-1.25},
      {"gap":"主高三档","diff_desc":"3档","home_hcap":1.75,"away_hcap":-1.5},
      {"gap":"主高三档半","diff_desc":"3.5档","home_hcap":2.0,"away_hcap":-1.75}
    ]
  },
  water_bands: {
    note: "亚盘上盘水位分层(孤行/米客)。",
    bands: [
      {"name":"超低水","min":0.0,"max":0.75},
      {"name":"低水","min":0.75,"max":0.85},
      {"name":"中低水","min":0.86,"max":0.90},
      {"name":"中水","min":0.91,"max":0.95},
      {"name":"中高水","min":0.96,"max":1.00},
      {"name":"高水","min":1.00,"max":1.08},
      {"name":"超高水","min":1.08,"max":9.9}
    ]
  },
  pan_types: {
    note: "秦俑十大盘型量化表。盘分差=实际初盘让球-实力预期让球。",
    rules: [
      {"type":"阻挡盘","cond":"盘分差>=0.5 且 初盘高水","logic":"高开给高水阻挡上盘; 临场维持/升盘→上盘; 升盘+持续降水→下盘","default":"上盘"},
      {"type":"妥协盘","cond":"盘分差<=-0.5 且 初盘高水","logic":"低开给高水示弱; 临场退盘+低水→上盘; 退盘+升水→下盘","default":"下盘"},
      {"type":"示弱盘","cond":"盘分差<=-1 且 初盘低水","logic":"低开低水造热下盘; 降水→下盘; 升水→上盘","default":"上盘"},
      {"type":"浅盘","cond":"盘分差<=-0.5 且 初盘低/中水","logic":"低开低水诱上; 升水/维持→下盘","default":"下盘"},
      {"type":"深盘","cond":"盘分差>=1 且 初盘低/中水","logic":"高开低水真实看好; 升水→下盘; 降水/维持→上盘","default":"上盘"},
      {"type":"浅诱盘","cond":"盘分差<=-0.5 且 临场升盘","logic":"浅盘再升盘造热; 升盘维持高水→下盘","default":"下盘"},
      {"type":"深诱盘","cond":"盘分差>=1 且 临场退盘","logic":"深盘退盘; 退盘+降水→下盘; 退盘+维持→上盘","default":"下盘"},
      {"type":"超深盘","cond":"盘分差>=2","logic":"高开两盘低水=假热真出→上盘; 高开两盘高水→下盘","default":"上盘"},
      {"type":"超浅盘","cond":"盘分差<=-2","logic":"低开两盘=下盘真热→下盘; 维持高水→上盘","default":"下盘"},
      {"type":"中庸盘","cond":"盘分差在[-0.5,0.5]","logic":"盘口与实力吻合; 看水位与临场变动,无明确偏向→观望","default":"观望"}
    ]
  },
  euro_rules: { note:"米客《赔率会说话》欧赔招式 + 孤行平赔思维。", rules:[
    "赔面左偏(胜低平负高): 注码流向胜平, 主胜难出; 右偏反之。",
    "平赔位置>3.50: 强阻平, 平局可出; 平赔≈3.20-3.50且胜负分散足: 利诱平不出。",
    "初→终变动: 拉胜+顶平+负韬 → 主胜打出信号; 顶平+拉负 → 客胜; 顶平+拉胜 → 主不胜。",
    "营造方向不打出: 庄家把注码引向的方向原则上不出。",
    "平赔增压→分胜负; 平赔减压/不作为→平局候选。先判让方成立否, 再判平。",
    "心理关口: 2.0/2.5/3.0/3.5/4.0/5.0; 降一超大区=增信心=诱。"
  ]},
  size_ball: { note:"大小球(进球数)方法。", rules:[
    "近6场双方均大球→大球概率高; 均小球→小球。",
    "初盘大球低水临场再降=真实看好大; 临场反升=诱小。",
    "进攻型+主场龙→上半大可追。",
    "临场剧烈震荡结合藏球/绝杀谨慎追大。",
    "建联赛场均进球基准库对照盘口。"
  ]},
  score_scales: { note:"四大基本面维度评分刻度。",
    "实力差":{"auto":true,"scale":"档位差 -4~+4, 超强+1"},
    "状态差":{"auto":"partial","scale":"-5~+5","input":"主客近6场"},
    "往绩差":{"auto":"partial","scale":"-3~+3 (带时间衰减)","input":"主客交锋"},
    "平局权重":{"auto":"partial","scale":"0~10","input":"场景定性"}
  },
  combo: { note:"投注组合与资金管理。仓位 1:3:5:10。",
    weights:[1,3,5,10],
    principles:[
      "只对'有优解信号'场次下单, 判定不清不下单。",
      "触发浅上加浅/示弱豪门/易胜博逆势超低水 → 升重注。",
      "触发高水诱上/低水吸纳/缺口盘 → 禁上盘或放弃。",
      "仓位上限由基本面把握度定, 禁均注盲推; 见好就收。"
    ]
  }
};

const MINMOVE = 3.0, HOTW = 0.85, COLDP = 1.00, CONFBASE = 45;

function med(xs){
  xs = (xs||[]).filter(x => x !== null && x !== undefined && !isNaN(x));
  if (!xs.length) return null;
  const s = [...xs].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}
/* 让球/盘口解析：支持 "-0/0.5" 半盘 → -0.25 中点
   ⚠ 2026-09-24 修复方向性 bug（双源背离榜跑出来才暴露）：
     分离式盘口写法是 "-1/1.5"，第二段的负号是**承前省略**的 ——
     旧代码直接 Number("1.5") 得 +1.5，算出 (-1 + 1.5)/2 = **+0.25**，
     即"主队受让一球/球半"被读成"主队让 0.25 球"，**主客让球方向完全颠倒**。
     实测全量 23484 个盘口字段里有 237 处中招（占 1.01%），
     且集中在 "-1/1.5"、"-3.5/4" 这类最常见的受让盘上 ——
     它们全部会落在一个虚假的 +0.25 上，把 median 整体拽偏，
     表现就是"背离榜里 gqj2 侧一堆 0.25 的假盘口"。
     修法：第一段为负、第二段为正时，第二段补回负号。 */
function parseHcap(s){
  if (s === null || s === undefined || s === '') return null;
  s = String(s).trim();
  if (s.indexOf('/') >= 0){
    const parts = s.split('/');
    const p = parts.map(Number);
    if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])){
      // ⚠ 必须用「字符串是否带负号」判断，不能用 p[0] < 0：
      //   Number("-0") 得到 -0，而 JS 里 (-0 < 0) === false，
      //   导致 "-0/0.5"（受让平半）被算成 +0.25，方向反了。
      const isNeg = /^\s*-/.test(parts[0]);
      const second = (isNeg && p[1] > 0) ? -p[1] : p[1];   // 承前省略的负号补回
      return (p[0] + second) / 2;
    }
    return null;
  }
  const v = Number(s);
  return isNaN(v) ? null : v;
}
function num(s){ const v = Number(s); return isNaN(v) ? null : v; }

/* 🔴 字段语义（2026-10-08 实测裁定，以本条为准，推翻 2026-10-07 误判）：
     gqj2 亚盘/欧赔/大小球三类数据的每条历史记录 = **一家公司的一条快照**（同 company_id 每场仅 1 条）：
       a/b/c = **该公司该时刻的即时盘口/水位/赔率**（2026-09-24 用球探 vip 对撞≈1080 场证实 a/b/c=即时盘，成立）。
       d/e/f = **该公司本场的初盘（开盘价）**，非垃圾字段。
     确凿证据（2026-10-08 真抓）：
       ① 同一场返回的是**多家公司混排**的快照（每公司 1 条），不是"同一家的时间序列"——
          旧版把"最早一条 a/b/c"当初盘、'最晚一条 a/b/c'当临盘，等于拿 A 公司即时盘当开盘、B 公司即时盘当临盘，初盘从未抓对。
       ② Interwette(cid=19) 亚盘 a/b/c 有效(-0.5/0.90/0.80)、d/e/f="封"/""/""（开盘被封）→ 能"封"的是 d/e/f，证明 d/e/f=初盘。
       ③ 2026-10-07 所谓"d/e/f=76/314/1.01 垃圾"是误读：实测 d/e/f 全是合理初盘值，仅偶发"封"/空/亚盘四分之一球写法("-0.5/1")。
     结论：初盘 = 核心公司（Bet365→威廉希尔→…）的 d/e/f；临盘 = 同公司的 a/b/c。
       当核心公司 d/e/f 为"封"/空/非法时，初盘退回**全公司 d/e/f 中位数**，再不行才退回 a/b/c（退化但有效）。
       此前（含 2026-09-24~10-07 全部版本）把初盘取 earliest/latest a/b/c 甚至直接丢 d/e/f，是用户投诉"初盘抓不准确"的真正根因。 */
function validAsia(x, finished){
  if (!x) return [false,false];
  const a = parseHcap(x.a), b = num(x.b), c = num(x.c);   // a/b/c = 即时盘(盘口,上水,下水)
  if ([a,b,c].some(v => v === null)) return [false,false];
  /* 2026-09-24：上限 3 → 4.5，保留。水位校验 (b+c)∈[1.55,2.10] 把关异常高价垃圾盘。 */
  let cur = Math.abs(a) <= 4.5 && b >= 0.5 && b <= 1.5 && c >= 0.5 && c <= 1.5 && (b+c) >= 1.55 && (b+c) <= 2.10;
  if (finished) cur = cur && (a !== 0);
  return [cur, cur];   // init 与 cur 同取 a/b/c 有效性（即时盘）；初盘由 validAsiaOpen 校验 d/e/f
}
/* 🔴 欧赔字段顺序（2026-09-11 实测修正，仍有效）：a/b/c 顺序为 (平, 主, 客)；d/e/f = 初盘(平,主,客)。
   2026-10-08 修正：初盘取 d/e/f（validEuOpen），临盘取 a/b/c（此处）。两者不再混用。 */
function validEu(x, finished){
  if (!x) return [false,false];
  const a = num(x.a), b = num(x.b), c = num(x.c);   // a/b/c = 即时赔率(平,主,客)
  if ([a,b,c].some(v => v === null)) return [false,false];
  let cur = a >= 1.5 && a <= 12 && b >= 1.02 && b <= 60 && c >= 1.02 && c <= 60;
  if (finished) cur = cur && Math.min(a,b,c) >= 1.3;
  return [cur, cur];   // init 与 cur 同取 a/b/c 有效性（即时盘）；初盘由 validEuOpen 校验 d/e/f
}
function aggregate(asia, eu, finished){
  asia = asia || []; eu = eu || [];
  // 初盘=全公司 d/e/f 中位数（真·开盘）；临盘=全公司 a/b/c 中位数（即时）。
  // d/e/f 为"封"/空/非法的记录不参与初盘，仅当无有效 d/e/f 时退回 a/b/c 中位数。
  // （核心公司优先覆盖见下方 CORE_ID 段；此处是共识兜底，避免"跨公司混取 a/b/c"旧病。）
  const _med = (vs) => { if(!vs.length) return null; const s=vs.slice().sort((a,b)=>a-b); const m=(s.length/2)|0; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
  let n_asia_ok=0, n_eu_ok=0; const _euCts = new Set();
  const asC=[], asO=[], euC=[], euO=[];
  for (const x of asia){
    if (validAsia(x, finished)[0]){ n_asia_ok++; asC.push({ hcap: parseHcap(x.a), uw: num(x.b), lw: num(x.c) }); }
    if (validAsiaOpen(x, finished)){ asO.push({ hcap: parseHcap(x.d), uw: num(x.e), lw: num(x.f) }); }
  }
  for (const x of eu){
    if (validEu(x, finished)[0]){ n_eu_ok++; const t=String(x.change_time||''); if(t)_euCts.add(t); euC.push({ d: num(x.a), h: num(x.b), a: num(x.c) }); }
    if (validEuOpen(x, finished)){ euO.push({ d: num(x.d), h: num(x.e), a: num(x.f) }); }
  }
  const oAsia = asO.length ? { hcap:_med(asO.map(v=>v.hcap)), uw:_med(asO.map(v=>v.uw)), lw:_med(asO.map(v=>v.lw)), t:null }
                         : (asC.length ? { hcap:_med(asC.map(v=>v.hcap)), uw:_med(asC.map(v=>v.uw)), lw:_med(asC.map(v=>v.lw)), t:null } : null);
  const cAsia = asC.length ? { hcap:_med(asC.map(v=>v.hcap)), uw:_med(asC.map(v=>v.uw)), lw:_med(asC.map(v=>v.lw)), t:null } : null;
  const oEu   = euO.length ? { d:_med(euO.map(v=>v.d)), h:_med(euO.map(v=>v.h)), a:_med(euO.map(v=>v.a)), t:null }
                         : (euC.length ? { d:_med(euC.map(v=>v.d)), h:_med(euC.map(v=>v.h)), a:_med(euC.map(v=>v.a)), t:null } : null);
  const cEu   = euC.length ? { d:_med(euC.map(v=>v.d)), h:_med(euC.map(v=>v.h)), a:_med(euC.map(v=>v.a)), t:null } : null;
  const o_asia_t=null, c_asia_t=null, o_eu_t=null, c_eu_t=null;
  const out = {
    o_hcap: oAsia?oAsia.hcap:null, o_uw: oAsia?oAsia.uw:null, o_lw: oAsia?oAsia.lw:null,
    c_hcap: cAsia?cAsia.hcap:null, c_uw: cAsia?cAsia.uw:null, c_lw: cAsia?cAsia.lw:null, c_valid: n_asia_ok,
    o_h: oEu?oEu.h:null, o_d: oEu?oEu.d:null, o_a: oEu?oEu.a:null,
    c_h: cEu?cEu.h:null, c_d: cEu?cEu.d:null, c_a: cEu?cEu.a:null, eu_valid: n_eu_ok,
    n_asia: asia.length, n_eu: eu.length,
    o_eu_t, c_eu_t, o_asia_t, c_asia_t,
    euCtN: _euCts.size,      // 欧赔历史里「不同盘口时刻」的个数（1 = 该场只有 1 个时刻，无走势可比）
    euRows: eu.length,
    euSrc: eu && eu.length ? 'seq' : 'none'      // 见下方核心公司覆盖
  };
  /* ====== 核心公司优先（2026-09-24 修正，用户质疑"是不是随便抓的"）======
     同一场比赛不同机构开价差异明显（实测样例：5 家平局 4.2/4.9/4.8/5/4.85），
     而取"全公司中位数"得到的是**任何一家都没开过的合成盘**，失去可比性。
     洋哥自传的"亚洲标准指数"明确是 **Bet365**（他全部案例：美国vs伊朗 1.91/3.4/4.2、
     拜仁/巴萨等均引 365），因为 365 受注量最大、代表**大众资金流向**——
     而这正是要和北单真实资金占比做对比的那一侧。
     故：主盘口优先取核心公司实际开价；该公司缺席时才逐级回退，仍以中位数兜底。
     回退链 Bet365 → 威廉希尔 → 立博 → 平博 → 澳门（前两者=最权威，平博=最 sharp）。
     ★ 2026-10-01 用户明确要求「核心公司以 365 为主」——见下方 CORE_ID，Bet365 绝对优先。 */
  /* ★ 2026-10-01 修（关键）：此前只按 company_name 匹配，而 compact.cjs 为压体积
     把 company_name **裁掉了**（只留 a~f+change_time+sort）→ 核心公司链**从未命中**，
     一直静默回退"全公司中位数"（=任何一家都没开过的合成盘），coreCo 恒为 undefined。
     现改为**按 company_id 整数精确匹配**（源站 20 家固定 id，见 CO_ID2NAME），
     名称匹配仅作回退；同时 compact.cjs 已把 company_id 保留进内联包。 */
  const CO_ID2NAME = { "1":"澳门","3":"ＳＢ/皇冠","4":"立博","7":"SNAI","8":"Bet365","9":"威廉希尔","12":"易胜博","14":"韦德","17":"明陞","19":"Interwette","22":"10BET","23":"金宝博","24":"12bet/沙巴","31":"利记","35":"盈禾","42":"18bet","47":"平博","48":"香港马会","49":"BWin","50":"1xbet" };
  // 核心公司链（按 id）：Bet365(8) 绝对第一 → 威廉希尔(9) → 立博(4) → 平博(47) → 澳门(1) → 韦德(14)
  const CORE_ID = [8, 9, 4, 47, 1, 14];
  const CORE_CO = ['Bet365','威廉希尔','立博','平博','澳门','韦德'];
  const coName = (s) => String(s||'').replace(/\s|ＳＢ|SB/g, x => x==='ＳＢ'||x==='SB' ? 'SB' : '').trim();
  // 一家公司可能有多种写法：Bet365 / bet365 / BET365 / 365
  const _isCo = (x, co) => {
    const id = Number(x.company_id);
    const nm = CO_ID2NAME[String(id)];
    if (nm) return nm === co;
    const n = String(x.company_name || '').replace(/\s+/g, '').toLowerCase();
    if (!n) return false;
    const c = co.toLowerCase();
    return n === c || n.indexOf(c) === 0 || (co === 'Bet365' && n.indexOf('365') >= 0);
  };
  for (const co of CORE_CO){
    const rows = eu.filter(x => _isCo(x, co));
    if (!rows.length) continue;
    // 同一公司可能有多条（不同 change_time）→ 取最早作初盘、最晚作临盘
    const byT = rows.slice().sort((p,q)=> String(p.change_time||'').localeCompare(String(q.change_time||'')));
    const first = byT[0], last = byT[byT.length-1];
    const fi = validEu(first, finished), la = validEu(last, finished);
    if (!fi[0] && !la[1]) continue;
    /* 初盘=核心公司 d/e/f（真·开盘）；d/e/f 为"封"/空/非法时退回该公司 a/b/c（退化但有效）。
       临盘=核心公司 a/b/c（即时）。单条记录(first===last)时，d/e/f 与 a/b/c 本就不同，
       故即便只有 1 条记录也能给出真实的开局/临局区分（不再"初盘=临盘"糊弄）。 */
    const _single = (first === last);
    const _oOpenOk = validEuOpen(first, finished);
    if (_oOpenOk){ out.o_d = num(first.d); out.o_h = num(first.e); out.o_a = num(first.f); if(!_single) out.o_eu_t = String(first.change_time||''); }
    // d/e/f 非法时不清覆盖：保留上方全公司共识 d/e/f 中位数（避免退回 a/b/c 导致初盘=临盘退化）
    if (la[1]){ out.c_d = num(last.a);  out.c_h = num(last.b);  out.c_a = num(last.c);  if(!_single) out.c_eu_t = String(last.change_time||''); }
    out.euSingle = _single;
    out.euSrc = co;
    out.coreCo = co;
    break;
  }
  // 亚盘同理由核心公司优先（同样按 company_id 精确匹配，见上方欧赔段说明）
  for (const co of CORE_CO){
    const rows = asia.filter(x => _isCo(x, co));
    if (!rows.length) continue;
    const byT = rows.slice().sort((p,q)=> String(p.change_time||'').localeCompare(String(q.change_time||'')));
    const first = byT[0], last = byT[byT.length-1];
    const fi = validAsia(first, finished), la = validAsia(last, finished);
    if (!fi[0] && !la[1]) continue;
    const _s1 = (first === last);
    // 初盘=核心公司 d/e/f（真·开盘）；d/e/f 为"封"/空时退回上方全公司共识 d/e/f 中位数（不退化成 a/b/c）
    const _oAOpenOk = validAsiaOpen(first, finished);
    if (_oAOpenOk){ out.o_hcap = parseHcap(first.d); out.o_uw = num(first.e); out.o_lw = num(first.f); if(!_s1) out.o_asia_t = String(first.change_time||''); }
    if (la[1]){ out.c_hcap = parseHcap(last.a);  out.c_uw = num(last.b);  out.c_lw = num(last.c);  if(!_s1) out.c_asia_t = String(last.change_time||''); }
    out.asiaSrc = co;
    break;
  }
  /* ★ 2026-10-21 洋哥「三盘共振」数据层（独立于核心公司链，无论主盘口取到哪家都算）：
     ① mktMv = 全市场各公司 欧赔(临−初) 同侧变动中位数 → 洋哥"一盘水位流速"（某方单边降0.13~0.20=大热）。
        初盘只认 d/e/f（真·开盘）；d/e/f 为"封"/非法的公司整场剔除（不退回 a/b/c，否则 Δ≡0 稀释中位数）。
     ② b365  = Bet365(cid=8) 自己的 初盘(d/e/f)→临盘(a/b/c) → "二盘设防"判定基准（365跟随=设防/反向升水=不设防）。
     原始行字段序：a/d=平 b/e=主 c/f=客（见 validEu 注释）。 */
  const _coGroups = {};
  for (const x of eu){
    const cid = String(x.company_id != null ? x.company_id : '');
    if (!cid) continue;
    (_coGroups[cid] = _coGroups[cid] || []).push(x);
  }
  const _coEuMv = (rows) => {
    const byT = rows.slice().sort((p,q)=> String(p.change_time||'').localeCompare(String(q.change_time||'')));
    let oD=null,oH=null,oA=null, cD=null,cH=null,cA=null;
    for (const r of byT){ if (validEuOpen(r, finished)){ oD=num(r.d); oH=num(r.e); oA=num(r.f); break; } }
    for (let i=byT.length-1;i>=0;i--){ const r=byT[i]; if (validEu(r, finished)[1]){ cD=num(r.a); cH=num(r.b); cA=num(r.c); break; } }
    /* ★ 2026-10-30：4家实时欧赔只需临盘 a/b/c 有效即可输出（用户要的是"实时"，非初盘）。
       初盘 d/e/f 常见垃圾（如 19/1.02/67）→ 允许置 null 而不再整体弃掉该家。
       b365 也复用此逻辑（此前 d/e/f 垃圾导致 b365 恒 undefined，二盘设防失去基准）。 */
    if (cD==null) return null;
    return { o:(oD==null?null:{d:oD,h:oH,a:oA}), c:{d:cD,h:cH,a:cA} };
  };
  const _mvs = [];
  for (const cid in _coGroups){ const mv = _coEuMv(_coGroups[cid]); if (mv && mv.o) _mvs.push(mv); }   // ★ 2026-10-30：初盘 o 为 null 的公司不参与流速中位数（d/e/f 垃圾）
  if (_mvs.length >= 3){
    out.mktMv = {
      d: +(_med(_mvs.map(m=>+(m.c.d-m.o.d).toFixed(3)))).toFixed(3),
      h: +(_med(_mvs.map(m=>+(m.c.h-m.o.h).toFixed(3)))).toFixed(3),
      a: +(_med(_mvs.map(m=>+(m.c.a-m.o.a).toFixed(3)))).toFixed(3),
      n: _mvs.length
    };
  }
  const _b365mv = (function(){ const rows = eu.filter(x=>_isCo(x,'Bet365')); return rows.length ? _coEuMv(rows) : null; })();
  if (_b365mv) out.b365 = { o_h:_b365mv.o?_b365mv.o.h:null, o_d:_b365mv.o?_b365mv.o.d:null, o_a:_b365mv.o?_b365mv.o.a:null, c_h:_b365mv.c.h, c_d:_b365mv.c.d, c_a:_b365mv.c.a };
  /* ★ 2026-10-30 用户要求：「最主要参考 365、立博、威廉、英特 这4家公司，实时欧赔更新」
     4家实时值独立输出（初盘 d/e/f 可用则取、不可用置 null；临盘 a/b/c 必须有效）。
     键名 co365/coLad/coWill/coInt，结构 {o:{d,h,a}|null, c:{d,h,a}}。 */
  const _co4 = [
    ['co365', 'Bet365'], ['coLad', '立博'], ['coWill', '威廉希尔'], ['coInt', 'Interwette']
  ];
  for (const [k, co] of _co4){
    const rows = eu.filter(x=>_isCo(x, co));
    if (!rows.length) continue;
    const mv = _coEuMv(rows);
    if (mv) out[k] = { o:(mv.o?{h:mv.o.h,d:mv.o.d,a:mv.o.a}:null), c:{h:mv.c.h,d:mv.c.d,a:mv.c.a} };
  }
  return out;
}
// 大小球（Over/Under）校验：a/d=盘口(如 4 / 4/4.5)，b/e=大球水，c/f=小球水
function validOU(x, finished){
  if (!x) return [false,false];
  const a = parseHcap(x.a), b = num(x.b), c = num(x.c);   // a/b/c = 即时大小球盘口(该时刻)
  if ([a,b,c].some(v => v === null)) return [false,false];
  let cur = a>=1.5 && a<=8 && b>=0.5 && b<=1.5 && c>=0.5 && c<=1.5 && (b+c)>=1.55 && (b+c)<=2.10;
  if (finished) cur = cur && (a!==0);
  return [cur, cur];
}
/* 🔴 初盘校验（d/e/f）：2026-10-08 实测裁定，推翻 2026-10-07 "d/e/f 是垃圾" 的误判。
   源站 oddshistorypc 每条记录 = 一家公司的**单条快照**（同 company_id 每场仅 1 条），
   其中 a/b/c = 该公司该时刻**即时盘**，d/e/f = 该公司本场**初盘（开盘价）**。
   确凿证据：Interwette(cid=19) 亚盘 a/b/c 有效(-0.5/0.90/0.80)、d/e/f="封"/""/""（开盘被封）——
   能"封"的是 d/e/f、a/b/c 仍有值 → d/e/f 才是初盘。
   故：初盘必须取 d/e/f；d/e/f 为"封"/空/非法的记录不参与初盘，退回 a/b/c 中位数兜底。 */
function validEuOpen(x, finished){
  if (!x) return false;
  const d=num(x.d), e=num(x.e), f=num(x.f);   // d/e/f = 初盘(平,主,客)
  if ([d,e,f].some(v=>v==null||!isFinite(v))) return false;
  return d>=1.5 && d<=12 && e>=1.02 && e<=60 && f>=1.02 && f<=60;
}
function validAsiaOpen(x, finished){
  if (!x) return false;
  const h=parseHcap(x.d), u=num(x.e), w=num(x.f);   // d/e/f = 初盘(盘口,上水,下水)
  if (h==null || !isFinite(u) || !isFinite(w)) return false;
  return Math.abs(h)<=4.5 && u>=0.5 && u<=1.5 && w>=0.5 && w<=1.5 && (u+w)>=1.55 && (u+w)<=2.10;
}
function validOUOpen(x, finished){
  if (!x) return false;
  const ln=parseHcap(x.d), ow=num(x.e), uw=num(x.f);   // d/e/f = 初盘(线,大球水,小球水)
  if (ln==null || !isFinite(ow) || !isFinite(uw)) return false;
  return ln>=1.5 && ln<=8 && ow>=0.5 && ow<=1.5 && uw>=0.5 && uw<=1.5 && (ow+uw)>=1.55 && (ow+uw)<=2.10;
}
function aggregateBs(bs, finished){
  bs = (bs||[]).filter(x=>x && x.a!==undefined);
  if (!bs.length) return {o_line:null,o_ow:null,o_uw:null,c_line:null,c_ow:null,c_uw:null,c_valid:0,n_bs:0};
  // 🔴 2026-10-08 修正：初盘=共识 d/e/f 中位数（真·开盘），临盘=共识 a/b/c 中位数（即时）。
  //   旧版取"最早/最晚 a/b/c"等于跨公司混取即时盘，初盘从未抓对。d/e/f 非法时退回 a/b/c 中位数。
  const _med = (vs)=>{ if(!vs.length) return null; const s=vs.slice().sort((a,b)=>a-b); const m=(s.length/2)|0; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
  const cur=[], open=[];
  for (const x of bs){
    if (validOU(x,finished)[0]) cur.push({ line:parseHcap(x.a), ow:num(x.b), uw:num(x.c) });
    if (validOUOpen(x,finished)) open.push({ line:parseHcap(x.d), ow:num(x.e), uw:num(x.f) });
  }
  if (!cur.length) return {o_line:null,o_ow:null,o_uw:null,c_line:null,c_ow:null,c_uw:null,c_valid:0,n_bs:bs.length};
  const oSrc = open.length ? open : cur;
  const o_line=_med(oSrc.map(v=>v.line)), o_ow=_med(oSrc.map(v=>v.ow)), o_uw=_med(oSrc.map(v=>v.uw));
  const c_line=_med(cur.map(v=>v.line)), c_ow=_med(cur.map(v=>v.ow)), c_uw=_med(cur.map(v=>v.uw));
  return {
    o_line, o_ow, o_uw, c_line, c_ow, c_uw,
    o_t: null, c_t: null,   // 共识中位数无单一时刻
    c_valid: cur.length, n_bs: bs.length
  };
}
// 大小球冷热判定：升盘(门槛提高) + 大球水降(便宜=受热)
function classifyOU(o_line, o_ow, o_uw, c_line, c_ow, c_uw){
  if (c_line===null || o_line===null) return ['—','—','大小球无临场'];
  const d_line = c_line - o_line;            // >0 升盘
  const d_ow   = (c_ow||0) - (o_ow||0);     // <0 大球水降=受热
  const EPS_L = 0.05, EPS_W = 0.04;
  if (d_line >  EPS_L && d_ow < -EPS_W) return ['D','大球','升盘+大球降水·大球热'];
  if (d_line < -EPS_L && d_ow >  EPS_W) return ['X','小球','降盘+大球升水·小球热'];
  if (d_ow < -EPS_W) return ['D','大球','大球降水·略热'];
  if (d_ow >  EPS_W) return ['X','小球','大球升水·略冷'];
  return ['—','—','大小球水位平稳'];
}
function _prob(oh,od,oa){
  const inv = 1/oh + 1/od + 1/oa;
  const pay = 1/inv;
  return [ (1/oh)/inv, (1/od)/inv, (1/oa)/inv, pay ];
}
// 盘路分析：早盘(初盘) → 中盘(变盘窗口) → 临盘(即时) 三线对比
//  数据口径（2026-10-08 修正）：源站每条历史记录 = 一家公司单条快照；a/b/c = 即时盘，d/e/f = 初盘。
//  初盘 = 核心公司 d/e/f（真·开盘，共识中位数兜底）；临盘 = 同组 a/b/c 中位数（即时）。
//  本工具以「初盘=早盘」「即时=临盘」呈现盘口/水位/赔率三段走势。
function analyzePanlu(agg, aggBs){
  const f2 = v => (v==null||isNaN(v)) ? null : (+v).toFixed(2);
  const f1 = v => (v==null||isNaN(v)) ? null : (+v).toFixed(1);
  const arrow = (from, to, unit) => {
    if (from==null||to==null) return null;
    const d = +to - +from;
    if (Math.abs(d) < 0.01) return { dir:'→', d:0, txt:'持平' };
    if (d > 0) return { dir:'↑', d:+d.toFixed(2), txt:'升'+(unit||'')+' '+d.toFixed(2) };
    return { dir:'↓', d:+d.toFixed(2), txt:'降'+(unit||'')+' '+d.toFixed(2) };
  };
  // —— 欧赔 ——
  const eu = {
    early:{ h:agg.o_h, d:agg.o_d, a:agg.o_a }, late:{ h:agg.c_h, d:agg.c_d, a:agg.c_a },
    earlyT: agg.o_eu_t, lateT: agg.c_eu_t,
    ctN: agg.euCtN == null ? null : agg.euCtN,      // 该场欧赔有几个不同盘口时刻
    rows: agg.euRows == null ? null : agg.euRows,
    singleCo: !!agg.euSingle,                        // 核心公司只有 1 条记录（无该公司的初/临场之分）
    coreCo: agg.coreCo || null,                      // ★ 实际取哪家公司的开价（'Bet365' 等）；null=回退全公司中位数
    ctSame: (agg.o_eu_t != null && agg.c_eu_t != null && agg.o_eu_t === agg.c_eu_t),
    h: arrow(agg.o_h, agg.c_h), d: arrow(agg.o_d, agg.c_d), a: arrow(agg.o_a, agg.c_a)
  };
  // 欧赔：哪一方赔率降幅最大 = 庄家最看好（降水=降赔付=真看好）
  const euMove = [
    { k:'W', from:agg.o_h, to:agg.c_h, name:'主胜' },
    { k:'D', from:agg.o_d, to:agg.c_d, name:'平' },
    { k:'L', from:agg.o_a, to:agg.c_a, name:'客胜' }
  ].filter(x=>x.from!=null&&x.to!=null);
  euMove.forEach(x=> x.d = +x.to - +x.from);
  euMove.sort((a,b)=>a.d-b.d);   // 降最多(最小负值)在前
  eu.favDrop = euMove.length ? euMove[0] : null;   // 降幅最大=最被看好
  // —— 亚盘 ——
  const asia = {
    earlyHcap: agg.o_hcap, lateHcap: agg.c_hcap, hcap: arrow(agg.o_hcap, agg.c_hcap),
    earlyUW: agg.o_uw, lateUW: agg.c_uw, uw: arrow(agg.o_uw, agg.c_uw),
    earlyLW: agg.o_lw, lateLW: agg.c_lw, lw: arrow(agg.o_lw, agg.c_lw),
    earlyT: agg.o_asia_t, lateT: agg.c_asia_t
  };
  // —— 大小球 ——
  let ou = null;
  if (aggBs && (aggBs.c_valid||0) >= 3){
    const [so, od, ot] = classifyOU(aggBs.o_line, aggBs.o_ow, aggBs.o_uw, aggBs.c_line, aggBs.c_ow, aggBs.c_uw);
    ou = {
      earlyLine: aggBs.o_line, lateLine: aggBs.c_line, line: arrow(aggBs.o_line, aggBs.c_line),
      earlyOW: aggBs.o_ow, lateOW: aggBs.c_ow, ow: arrow(aggBs.o_ow, aggBs.c_ow),
      earlyUW: aggBs.o_uw, lateUW: aggBs.c_uw, uw: arrow(aggBs.o_uw, aggBs.c_uw),
      earlyT: aggBs.o_t, lateT: aggBs.c_t,
      verdict: ot, dir: od, sig: so
    };
  }
  // —— 中盘变盘点 —— 取三条线中"临盘时间戳"的较早者作为中盘窗口起点；若都有，取最早临盘时间
  const times = [eu.lateT, asia.lateT, ou&&ou.lateT].filter(Boolean);
  const midTime = times.length ? times.reduce((a,b)=> a<b?a:b) : null;
  // —— 综合盘路结论 ——
  let summary = [];
  if (eu.favDrop && eu.favDrop.d < -0.05) summary.push(`欧赔${eu.favDrop.name}赔率${eu.favDrop.from.toFixed(2)}→${eu.favDrop.to.toFixed(2)}（${eu.favDrop.d.toFixed(2)}），庄家主动降水=真看好`);
  if (asia.hcap){
    if (asia.hcap.d>0) summary.push(`亚盘升盘（${f2(asia.earlyHcap)}→${f2(asia.lateHcap)}），上盘信心增强`);
    else if (asia.hcap.d<0) summary.push(`亚盘降盘（${f2(asia.earlyHcap)}→${f2(asia.lateHcap)}），上盘无力/诱下`);
  }
  if (ou && ou.verdict && ou.verdict.indexOf('无')<0) summary.push(`大小球热度：${ou.verdict}`);
  const anyData = (agg.eu_valid||0) >= 3 || (agg.c_valid||0) >= 3 || (aggBs&&aggBs.c_valid>=3);
  return { eu, asia, ou, midTime, earlyT: eu.earlyT||asia.earlyT||(ou&&ou.earlyT), lateT: eu.lateT||asia.lateT||(ou&&ou.lateT), summary, has: !!anyData };
}
/* ---------- 早盘/中盘/临盘 三段加权融合（权重 0.20 / 0.25 / 0.55）----------
 * 数据口径：源站每家公司欧/亚/大球均给出 初盘(a/b/c) 与 即时(d/e/f)；
 *   capture_slice.py 在早盘/中盘/临盘三个时点各抓一次快照 → 三个时点各自的
 *   "即时(d/e/f)" 即为该时点的市场真实态度。本函数把三段隐含概率按权重融合，
 *   还原出一份"跨时段加权"的赔率 agg，供 analyze() 使用（比单一时点更稳、更贴庄家轨迹）。
 *   stages: [{ agg, aggBs, label:'early'|'mid'|'late', ts, w }]  仅含已捕获段。
 *   早段用 o_*（初盘恒为真实开赔），中/临段用 c_*（即时=该时点市场）。
 *   缺失某段时，自动按已捕获段权重重新归一化（绝不崩溃）。 */
function fusePanlu3(stages){
  if (!stages || !stages.length) return null;
  const wsum = stages.reduce((a,s)=>a + (s.w||0), 0);
  if (!wsum) return null;
  /* 三段抓取的是各时点的**即时盘**：早段=12:00 的 c_*，中段=15:20 的 c_*，临段=赛前的 c_*。
     （2026-09-24 更正旧注释：记录的即时盘是 **a/b/c**，d/e/f 才是初盘 —— 旧注释写反了。）
     初盘在各次抓取里恒定不变，仅作展示参考，不参与加权。 */
  const cur = s => s.agg;                         // c_* 即该时点市场
  // —— 欧赔：加权隐含概率 → 还原融合赔率 ——
  let H=0, D=0, A=0; const margins=[];
  let euN=0;
  for (const s of stages){
    const g = cur(s);
    const h = g.c_h, d = g.c_d, a = g.c_a;
    if (!h || !d || !a) continue;
    const inv = 1/h + 1/d + 1/a;
    const p = [ (1/h)/inv, (1/d)/inv, (1/a)/inv ];
    H += (s.w)*p[0]; D += (s.w)*p[1]; A += (s.w)*p[2];
    margins.push((s.w)*(inv-1)); euN++;
  }
  if (!euN) return null;
  H/=wsum; D/=wsum; A/=wsum;
  const avgMargin = margins.reduce((a,b)=>a+b,0) / Math.max(1, margins.length);
  const toO = p => (p && p>0) ? +((1+avgMargin)/p).toFixed(3) : null;
  const c_h = toO(H), c_d = toO(D), c_a = toO(A);
  const e0 = stages.find(s => s.agg.o_h) || stages[0];       // 初盘取自首个有效段
  /* ⚠ 2026-09-24：初盘字段加回退。
     改为按真实语义取 d/e/f 后，历史切片（尤其中断/补抓的批次）里该字段常为 null，
     fusePanlu3 直接产出 undefined → 被 JSON.stringify 整键丢弃，
     结果 fused.agg 只剩 c_* 六个键，下游 a0=undefined、dp=null，
     **所有三段融合场次的盘口走势信号全部消失**（这是修复带来的退化，必须堵住）。
     回退到「最早阶段的即时盘」是合理的：早场快照本就是最接近开盘的时点。 */
  const _fb = (v, alt) => (v != null ? v : alt);
  const o_h = _fb(e0.agg.o_h, e0.agg.c_h), o_d = _fb(e0.agg.o_d, e0.agg.c_d), o_a = _fb(e0.agg.o_a, e0.agg.c_a);
  // —— 亚盘 / 大小球：水位加权均值，盘口加权均值后 snap 到 0.25 ——
  const wmean = (key) => {
    let n=0, dd=0;
    for (const s of stages){
      const v = s.agg['c_'+key];
      if (v!=null && isFinite(v)) { n += v*(s.w); dd += (s.w); }
    }
    return dd ? n/dd : null;
  };
  const wHcap = (key) => { const v = wmean(key); return v==null ? null : Math.round(v*4)/4; };
  const c_hcap = wHcap('hcap'), c_uw = wmean('uw'), c_lw = wmean('lw');
  const o_hcap = _fb(e0.agg.o_hcap, e0.agg.c_hcap), o_uw = _fb(e0.agg.o_uw, e0.agg.c_uw), o_lw = _fb(e0.agg.o_lw, e0.agg.c_lw);
  // 大小球（aggBs）
  const wmean2 = (key) => {
    let n=0, dd=0;
    for (const s of stages){
      const v = s.aggBs['c_'+key];
      if (v!=null && isFinite(v)) { n += v*(s.w); dd += (s.w); }
    }
    return dd ? n/dd : null;
  };
  const wHcap2 = (key) => { const v = wmean2(key); return v==null ? null : Math.round(v*4)/4; };
  const c_line = wHcap2('line'), c_ow = wmean2('ow'), c_uw_bs = wmean2('uw');
  const o_line = _fb(e0.aggBs.o_line, e0.aggBs.c_line), o_ow = _fb(e0.aggBs.o_ow, e0.aggBs.c_ow), o_uw_bs = _fb(e0.aggBs.o_uw, e0.aggBs.c_uw);
  const minT = arr => { const f = arr.filter(Boolean).sort(); return f.length ? f[0] : null; };
  const maxT = arr => { const f = arr.filter(Boolean).sort(); return f.length ? f[f.length-1] : null; };
  /* ⚠ 2026-09-24 修复（键被覆写，教训来自双源校验）：旧版这里重复写了 o_uw / c_uw ——
     第 450 行给的是「亚盘上盘水」，第 451 行紧跟的 `o_uw:o_uw_bs, c_uw:c_uw_bs`（大小球小球水）
     把它整个覆盖掉（对象字面量里同名键后者胜）。后果：fused.agg.c_uw 实际是大小球小球水，
     而 analyze() 的 a0/h0（初/临场上水）和 analyzePanlu 都当它是**亚盘水位**在用 ——
     「水位升/降」这类核心信号建立在错误的数字上。两者数值区间重叠（0.8~1.1），
     肉眼永远看不出来，只能靠去掉重复键杜绝。
     大小球口径的大小球水在 aggBs 里本来就有（下游也只读 aggBs / a.ou），故这里不再重复放进 agg。 */
  const agg = {
    o_h, o_d, o_a, c_h, c_d, c_a,
    o_hcap, o_uw, o_lw, c_hcap, c_uw, c_lw,
    o_eu_t: minT(stages.map(s=>s.agg.o_eu_t)), c_eu_t: maxT(stages.map(s=>s.agg.c_eu_t)),
    o_asia_t: minT(stages.map(s=>s.agg.o_asia_t)), c_asia_t: maxT(stages.map(s=>s.agg.c_asia_t)),
    n_eu: stages.reduce((a,s)=>a+(s.agg.n_eu||0),0),
    n_asia: stages.reduce((a,s)=>a+(s.agg.n_asia||0),0),
    n_bs: e0.aggBs.n_bs||0,
    eu_valid: stages.reduce((a,s)=>a+(s.agg.eu_valid||0),0),
    c_valid: stages.reduce((a,s)=>a+(s.agg.c_valid||0),0)
  };
  /* ★ 2026-10-21：透传洋哥三盘共振数据（aggregate 产出，融合后 analyze 仍可用）。
     b365 = Bet365 自家初/临盘：初盘取最早有效阶段，临盘取最晚有效阶段（跨时段才是真走势）。
     mktMv = 全市场流速中位数：取最晚持有该字段的阶段（最接近临场的市场状态）。 */
  const _sB365o = stages.find(s => s.agg && s.agg.b365 && s.agg.b365.o_h != null);
  const _sB365c = stages.slice().reverse().find(s => s.agg && s.agg.b365 && s.agg.b365.c_h != null);
  if (_sB365o || _sB365c){
    agg.b365 = {
      o_h: _sB365o ? _sB365o.agg.b365.o_h : null, o_d: _sB365o ? _sB365o.agg.b365.o_d : null, o_a: _sB365o ? _sB365o.agg.b365.o_a : null,
      c_h: _sB365c ? _sB365c.agg.b365.c_h : null, c_d: _sB365c ? _sB365c.agg.b365.c_d : null, c_a: _sB365c ? _sB365c.agg.b365.c_a : null
    };
  }
  const _sMv = stages.slice().reverse().find(s => s.agg && s.agg.mktMv);
  if (_sMv) agg.mktMv = _sMv.agg.mktMv;
  /* ★ 2026-10-30 用户要求：主要参考 365/立博/威廉/英特 4家实时欧赔。
     与 b365 同法跨阶段合并（初盘取最早有效、临盘取最晚有效），输出到 agg.coLive。 */
  const _co4 = [['co365','Bet365'],['coLad','立博'],['coWill','威廉希尔'],['coInt','Interwette']];
  agg.coLive = {};
  for (const [k, co] of _co4){
    const _so = stages.find(s => s.agg && s.agg[k] && s.agg[k].o);
    const _sc = stages.slice().reverse().find(s => s.agg && s.agg[k] && s.agg[k].c);
    if (_sc){
      agg.coLive[co] = {
        o: _so ? _so.agg[k].o : null,
        c: _sc.agg[k].c
      };
    }
  }
  const aggBs = {
    o_line, o_ow, o_uw:o_uw_bs, c_line, c_ow, c_uw:c_uw_bs,
    o_t: minT(stages.map(s=>s.aggBs.o_t)), c_t: maxT(stages.map(s=>s.aggBs.c_t)),
    c_valid: stages.reduce((a,s)=>a+(s.aggBs.c_valid||0),0), n_bs: e0.aggBs.n_bs||0
  };
  const prob = { H:+H.toFixed(4), D:+D.toFixed(4), A:+A.toFixed(4), avgMargin:+avgMargin.toFixed(4) };
  const present = stages.map(s=>s.label);
  return { agg, aggBs, prob, present };
}
function expectedHcap(o0h,o0d,o0a){
  const p = _prob(o0h,o0d,o0a);   // [主胜概率, 平概率, 客胜概率, 赔付率]
  return 0.25 + 2.5 * (p[0] - p[2]);  // 主胜概率 - 客胜概率
}
/* ===== ★ 2026-10-29 洋哥《盘级换算详解》离散水位查表法（工程化）=====
 * 原文（无让球盘，按「上盘胜赔」分档；竞彩/北单须先 ×(R365/R源) 换算到 365 返还率再查）：
 *   上盘胜赔 ≥2.35 → 平手；2.25~2.35 平半高水；2.10~2.25 平半中低水；
 *   2.00~2.09 半球高水；1.90~2.00 半球中水；1.80~1.90 半球低水；<1.80 每降 0.30 升 1 级。
 * 让球盘（−1 上盘赔率）：≥2.99 一球高水 | 2.75~2.99 中水 | 2.50~2.75 低水（2.5=升盘线）
 *   | 2.36~2.49 1.25球高水 | 2.23~2.36 中水 | 2.10~2.23 低水 | <2.10 升盘（2.09 起 1.5球高水）。
 * 等级 = 盘口/0.25（平半=1、半球=2、半一=3、一球=4、1.25球=5、1.5球=6 …）。
 * 与 expectedHcap（连续线性 0.25+2.5×(pH−pA)）并列使用：查表=洋哥原法（离散），线性=本系统原法。
 * 原文末句："数据是冰冷的，盘也无定式，读懂原理，而不是死记硬背"——故两法并列展示，不单独采信任一法。 */
const _YG_HCAP_NAMES = ['平手','平半','半球','半一','一球','一又四分之一','一球半','一又四分之三','两球','两又四分之一','两球半'];
function yanggeHcapLevel(o, isRq){
  if (o == null || !isFinite(o) || o <= 1) return null;
  let lvl = null, water = null;
  if (isRq){
    // 让球盘（-1 上盘赔率）：赔率越低 → 盘口越深
    if (o >= 2.99)      { lvl = 4; water = '高水'; }
    else if (o >= 2.75) { lvl = 4; water = '中水'; }
    else if (o >= 2.50) { lvl = 4; water = '低水'; }
    else if (o >= 2.36) { lvl = 5; water = '高水'; }
    else if (o >= 2.23) { lvl = 5; water = '中水'; }
    else if (o >= 2.10) { lvl = 5; water = '低水'; }
    else {
      const step = Math.floor((2.10 - o) / 0.30);
      const inStep = (2.10 - o) - step * 0.30;
      water = inStep < 0.10 ? '高水' : (inStep < 0.20 ? '中水' : '低水');
      lvl = 6 + step;
    }
  } else {
    if (o >= 2.35)      { lvl = 0; water = '平手'; }
    else if (o >= 2.25) { lvl = 1; water = '高水'; }
    else if (o >= 2.10) { lvl = 1; water = '中低水'; }
    else if (o >= 2.00) { lvl = 2; water = '高水'; }
    else if (o >= 1.90) { lvl = 2; water = '中水'; }
    else if (o >= 1.80) { lvl = 2; water = '低水'; }
    else {
      const step = Math.floor((1.80 - o) / 0.30);
      const inStep = (1.80 - o) - step * 0.30;
      water = inStep < 0.10 ? '高水' : (inStep < 0.20 ? '中水' : '低水');
      lvl = 3 + step;
    }
  }
  const name = _YG_HCAP_NAMES[lvl] || (lvl + '级盘');
  return { lvl, hcap: +(lvl * 0.25).toFixed(2), water,
           tag: (lvl === 0 ? '平手' : (name + water)),
           name };
}
/* ===== 无盘口场「理论档位」评估（2026-09-23 新增，对应 #200）=====
 * 痛点：低级别/友谊/青年/女足/小国联赛庄家不开盘 → 卡片只剩「无盘口·庄家未开盘」死路。
 * 但这些队大多仍在 team_ratings（Dixon-Coles 赛季强度 + 近期战绩）里，
 * 故用「实力先验」反推一个**理论**让球盘与方向，作为无盘口场的实力代估——
 * 明确标注「非真实盘口·仅供参考」，绝不伪造庄家盘口或投注结论。
 * 复用链：strengthPriorOpts（λ/μ，season+form 融合）→ dcMatchProb（Poisson W/D/L）
 *        → expectedHcap 同款映射（公平赔→概率→盘口）→ gradeIndex 得理论档位号。
 * 与有盘口场的理论档位同源（expectedHcap），故两者口径一致、可直接对照。 */
const _THEO_FACT = [1,1,2,6,24,120,720,5040,40320,362880];
function dcMatchProb(lambda, mu, maxN){
  maxN = maxN || 8;
  let pH=0,pD=0,pA=0;
  const pL=new Array(maxN+1), pM=new Array(maxN+1);
  for (let i=0;i<=maxN;i++) pL[i]=Math.exp(-lambda)*Math.pow(lambda,i)/_THEO_FACT[i];
  for (let j=0;j<=maxN;j++) pM[j]=Math.exp(-mu)*Math.pow(mu,j)/_THEO_FACT[j];
  for (let i=0;i<=maxN;i++) for (let j=0;j<=maxN;j++){
    const p=pL[i]*pM[j];
    if (i>j) pH+=p; else if (i===j) pD+=p; else pA+=p;
  }
  return { H:pH, D:pD, A:pA };
}
function theoreticalAssess(home, away){
  const pr = strengthPriorOpts(home, away);
  if (!pr || !pr.lambda || !pr.mu) return null;          // 两队不全在强度库 → 不造假
  const { H, D, A } = dcMatchProb(pr.lambda, pr.mu, 8);
  // exp_hcap = 0.25 + 2.5*(H-A) 与 expectedHcap(公平赔) 数值等价（公平赔→概率再映射）
  const exp_hcap = 0.25 + 2.5*(H - A);
  const g_t = gradeIndex(exp_hcap, GRADE_W_BASE);          // 理论档位号（中水基准）
  // 方向：取最大概率方；conf = 该方理论概率%
  let dirCode='D', maxP=D;
  if (H >= maxP){ maxP=H; dirCode='W'; }
  if (A >  maxP){ maxP=A; dirCode='L'; }
  const conf = Math.round(maxP*100);
  const total = +(pr.lambda + pr.mu).toFixed(2);
  // 最可能比分（mode）
  let bi=0,bj=0,bp=-1;
  for (let i=0;i<=6;i++) for (let j=0;j<=6;j++){
    const p = Math.exp(-pr.lambda)*Math.pow(pr.lambda,i)/_THEO_FACT[i]
            * Math.exp(-pr.mu)*Math.pow(pr.mu,j)/_THEO_FACT[j];
    if (p>bp){ bp=p; bi=i; bj=j; }
  }
  return {
    lambda:+pr.lambda.toFixed(2), mu:+pr.mu.toFixed(2),
    pH:+H.toFixed(3), pD:+D.toFixed(3), pA:+A.toFixed(3),
    exp_hcap:+exp_hcap.toFixed(2), grade_t:g_t,
    dirCode, dirText:({W:'主胜',D:'平局',L:'客胜'})[dirCode],
    conf, total,
    score: bi+'-'+bj, scoreP:+(bp*100).toFixed(1),
    src: pr.src || 'season'
  };
}
function waterBand(w){
  for (const b of (KB.water_bands.bands||[])){
    if (w >= b.min && w < b.max) return b.name;
  }
  return (w !== null && w >= 1.08) ? '高水' : '超低水';
}

/* ===== 盘口档位体系（2026-09-23 新增）=====
 * 目的：把「亚盘盘口 + 上盘水位」这两维连续量压缩成**一个整数档位号**，
 *      从而能回答「庄家实开盘口比欧赔理论公允盘口 偏热/偏冷 几档」，并**按档位分层统计命中率**。
 * 符号约定（与引擎一致）：盘口 hcap 正值 = 主队让球 = 更看好主队；水位为**上盘水位**，
 *      水位越低(≤0.85 低水) = 上盘越热(市场越买主队)；水位越高(>0.95 高水) = 上盘越冷。
 * 档位定义：档位号 = round(hcap/0.25) + 水位档，其中
 *      水位档：低水 +2 / 中水 +1 / 高水 +0  —— 即**档位越高 = 越看好主队**（盘更深 或 上水更低）。
 *      每 1/4 球 = 1 档，每个水位台阶 = 1 档（实测：同一盘口下 低水→高水 = 净变化 ±2 档，与参考站量级一致）。
 * 理论档位：欧赔换算的预期盘 exp_hcap + 中水基准(0.90) = 市场公允档位。
 * 实际档位：临场盘 p1 + 临场上水 h1（缺则退回初盘 a0/h0）。
 * 净变化 = 实际 − 理论：>0 实开更偏主队(偏热) / <0 实开示弱(偏冷) / 0 吻合。
 * ⚠ 量纲教训(2026-09-23 真机踩坑)：初版写成 round(hcap/0.25)*3，1/4 球 = 3 档 → 盘口量纲压死水位，
 *   一场「欧赔期望 0.9 球 / 亚盘开平手」的场次算出净变化 −12 的垃圾值；水位信号(±2)被完全淹没。
 *   改为 1/4 球 = 1 档后，盘口与水位同量纲、可比。 */
const GRADE_W_LOW = 0.85, GRADE_W_HIGH = 0.95, GRADE_W_BASE = 0.90;
function waterStep(w){
  const h = +w;
  if (!isFinite(h) || h <= 0) return 1;        // 水位缺失 → 按中水处理，不制造伪信号
  if (h <= GRADE_W_LOW) return 2;              // 低水：上盘热 → 加 2 档
  if (h <= GRADE_W_HIGH) return 1;             // 中水 → 加 1 档
  return 0;                                     // 高水：上盘冷 → 不加档
}
function gradeIndex(hcap, water){
  if (hcap == null || !isFinite(+hcap)) return null;
  return Math.round(+hcap / 0.25) + waterStep(water);
}
/* 净变化 → 热度判定。正=偏热(实开更看好主队)，负=偏冷(示弱)。 */
function gradeTierOf(net){
  if (net == null) return { key:'NA', label:'—', tone:'mut', hot:null };
  const a = Math.abs(net), hot = net > 0;
  if (a >= 4) return { key: hot?'H4':'C4', label: hot?'正式过热':'正式偏冷', tone: hot?'red':'grn', hot:hot };
  if (a === 3) return { key: hot?'H3':'C3', label: hot?'中热':'中冷', tone: hot?'red':'grn', hot:hot };
  if (a === 2) return { key: hot?'H2':'C2', label: hot?'小热':'小冷', tone: hot?'yel':'grn', hot:hot };
  if (a === 1) return { key: hot?'H1':'C1', label: hot?'微热':'微冷', tone:'mut', hot:hot };
  return { key:'N', label:'正常盘', tone:'mut', hot:null };
}
function classifyPan(pan_gap, init_water, dp, dh, up_home){
  const high = init_water !== null && init_water !== undefined && init_water >= 1.00;
  const low  = init_water !== null && init_water !== undefined && init_water < 0.85;
  let typ, defaultDir;
  if (pan_gap >= 2){ typ='超深盘'; defaultDir='上盘'; }
  else if (pan_gap <= -2){ typ='超浅盘'; defaultDir='下盘'; }
  else if (pan_gap >= 1){ typ='深盘'; defaultDir='上盘'; }
  else if (pan_gap <= -1){ typ = low ? '示弱盘' : '浅盘'; defaultDir = low ? '上盘' : '下盘'; }
  else if (pan_gap >= 0.5){ typ='阻挡盘'; defaultDir='上盘'; }
  else if (pan_gap <= -0.5){ typ='妥协盘'; defaultDir='下盘'; }
  else { typ='中庸盘'; defaultDir='观望'; }
  let predict;
  if (dp === null && dh === null) predict = defaultDir;
  else {
    if (typ==='深盘') predict = (dh !== null && dh <= 0) ? '上盘' : '下盘';
    /* ★ 2026-10-30 让球短板终修（v4 深挖 2586 场）：浅盘打"上盘"(让球方/热门方) = 65.2% / +26.5%
       CI[58.4,72.1]，是全场最硬一档；而浅盘打"下盘"(受让方) = 32.1% / −31.6% 是最差坑。
       根因：浅盘=实际盘口比欧赔预期浅（少让≥1球），但强队实力仍在，让球方赢盘容易；
       散户却机械押受让方（以为浅=弱），被强队打穿。→ 浅盘统一判"上盘"(让球方)。
       注：此前临时改"观望"是保守，v4 证明浅盘上盘有真实 edge，故升级为上盘。 */
    else if (typ==='浅盘') predict = '上盘';
    else if (typ==='阻挡盘') predict = (dh !== null && dh < 0) ? '下盘' : '上盘';
    else if (typ==='妥协盘') predict = (dh !== null && dh < 0) ? '上盘' : '下盘';
    else if (typ==='示弱盘') predict = (dh !== null && dh <= 0) ? '下盘' : '上盘';
    else if (typ==='超深盘' || typ==='超浅盘') predict = defaultDir;
    else predict = defaultDir;
  }
  /* ★ 2026-10-30：水位变化微调（回测可打组合：深盘·上盘+dh降 +22%、上盘+dh升 +21~28%）。
     上盘方向且临场水位升（庄家防赔）→ 升一档"强化"标记；上盘+dh降 本已默认上盘，不变。
     仅作 pan_hint 展示，不翻方向（翻方向样本不足，深盘上盘63.1%已足够）。 */
  let s;
  if (predict==='上盘') s = up_home ? 'W' : 'L';
  else if (predict==='下盘') s = up_home ? 'L' : 'W';
  else s = '—';
  return [typ, predict, s];
}
/* ---------- 队名清洗（剔除 PUA 混淆 span，保留可读汉字） ---------- */
function cleanName(s){
  if (!s) return '';
  // 去掉 <span class="review">...</span> 及其内部实体
  let t = String(s).replace(/<span[^>]*>.*?<\/span>/g, '').replace(/<[^>]*>/g, '');
  t = t.replace(/&#x?[0-9a-fA-F]+;/g, ''); // 去掉残留实体
  return t.replace(/\s+/g, '').trim();
}

/* ---------- PUA 字体反混淆（完整还原真实队名） ----------
   gqj2.tv 列表接口把个别汉字替换为私用区码点（如 &#xe941;），
   本表由 /api/get_football_analysis 的精确队名作标准答案批量对齐反解得到，
   实测 6063 个队名 100% 还原。 */
const PUA_MAP = {
    'e900':'中',
    'e901':'亚',
    'e905':'伊',
    'e906':'伯',
    'e907':'俄',
    'e908':'威',
    'e909':'学',
    'e90b':'安',
    'e90c':'尼',
    'e90d':'尔',
    'e90e':'巴',
    'e90f':'希',
    'e910':'布',
    'e911':'帕',
    'e912':'年',
    'e914':'弗',
    'e915':'德',
    'e916':'欧',
    'e917':'比',
    'e918':'沃',
    'e919':'沙',
    'e91a':'法',
    'e91b':'波',
    'e91c':'泰',
    'e91d':'洛',
    'e91e':'海',
    'e91f':'澳',
    'e922':'米',
    'e924':'索',
    'e926':'纳',
    'e927':'维',
    'e928':'美',
    'e929':'罗',
    'e92c':'诺',
    'e92e':'赛',
    'e92f':'赫',
    'e930':'超',
    'e931':'足',
    'e932':'达',
    'e933':'迪',
    'e934':'马',
    'e935':'高',
    'e936':'鲁',
    'e937':'加',
    'e938':'勒',
    'e939':'古',
    'e93a':'哈',
    'e93b':'哥',
    'e93c':'埃',
    'e93d':'城',
    'e93e':'基',
    'e93f':'士',
    'e940':'姆',
    'e941':'拉',
    'e942':'拿',
    'e943':'斯',
    'e944':'日',
    'e945':'曼',
    'e946':'森',
    'e947':'瓦',
    'e948':'科',
    'e949':'育',
    'e94a':'英',
    'e94b':'莫',
    'e94d':'里',
    'e94e':'雷',
    'e94f':'韩',
    'e951':'克',
    'e952':'后',
    'e953':'塞',
    'e954':'多',
    'e955':'夫',
    'e956':'意',
    'e957':'普',
    'e958':'格',
    'e95a':'瑞',
    'e95c':'艾',
    'e95e':'西',
    'e95f':'队',
    'e960':'阿',
    'e963':'兰',
    'e964':'内',
    'e965':'利',
    'e966':'南',
    'e967':'卡',
    'e968':'吉',
    'e969':'圣',
    'e96a':'堡',
    'e96b':'塔',
    'e96c':'备',
    'e96d':'大',
    'e96e':'奥',
    'e970':'女',
    'e971':'恩',
    'e972':'托',
    'e973':'林',
    'e974':'梅',
    'e975':'特',
    'e976':'球',
    'e977':'甲',
    'e978':'联',
    'e979':'萨',
    'e97a':'葡',
    'e97c':'青'
  };

/* 把混淆队名还原为真实队名：可识字保留，PUA 码点查表还原 */
function decodePua(s){
  if (!s) return '';
  let t = String(s).replace(/<[^>]*>/g, '');           // 去 span 标签，保留实体与汉字
  t = t.replace(/&#x([eE][0-9a-fA-F]{2,4});/g, (m, code)=>{
    return PUA_MAP[code.toLowerCase()] || '';
  });
  t = t.replace(/&#x?[0-9a-fA-F]+;/g, '');             // 未收录码点：不留问号
  return t.replace(/\s+/g, '').trim();
}

/* 取队名的最优结果：优先 PUA 还原（长度更完整），否则退回清洗结果 */
function decodeName(s){
  const full = decodePua(s);
  if (full.length >= 2) return full;
  return cleanName(s);
}

/* ---------- 队名规范化（同 team_id 多字段 / 跨源异名统一） ----------
   问题：okooo 同一 team_id 常有 zh/zht/sb 多套写法（甲府风林/甲府風林），
         跨源（澳客/7m）还有 妙瓦底↔米瓦迪 这类同队不同译名。
   解法：按 team_id 缓存唯一规范名（优先 okooo 主字段 zh），任何面板渲染队名都走本函数，
         保证主列表/精选/档位板显示完全一致；已知跨源异名用 TEAM_ALIAS 收口。 */
const TEAM_CANON = Object.create(null);          // team_id -> 规范名（首次解析后缓存，全局稳定）
const TEAM_ALIAS = {
    '米瓦迪U20':'妙瓦底U20',
    '莫亨巴根':'ATK莫亨巴根',
    '法国(U20)':'法国U20',
    '英格兰(U20)':'英格兰U20',
    '印度女足(U17)':'印度女足U17',
    '菲律宾女足(U17)':'菲律宾女足U17',
    '葡萄牙(U20)':'葡萄牙U20',
    '名古屋鲸鱼':'名古屋鲸八',
    '土耳其(U18)':'土耳其U18',
    '美国(U19)':'美国U19',
    '威尔士(U19)':'威尔士U19',
    '比利时(U17)':'比利时U17',
    '乌克兰(U17)':'乌克兰U17',
    '土耳其(U17)':'土耳其U17',
    '克罗地亚(U18)':'克罗地亚U18',
    '阿尔及利亚(U17)':'阿尔及利亚U17',
    '意大利(U18)':'意大利U18',
    '丹麦(U18)':'丹麦U18',
    '荷兰(U17)':'荷兰U17',
    '美国(U17)':'美国U17',
    '辽宁盛京新鋭':'辽宁盛京新锐',
    '维冈竞技(U21)':'维冈竞技U21',
    '塞浦路斯(U19)':'塞浦路斯U19',
    '卡塔尔(U18)':'卡塔尔U18',
    '匈牙利(U18)':'匈牙利U18',
    '北马其顿(U17)':'北马其顿U17',
    '卢森堡(U17)':'卢森堡U17',
    '意大利(U17)':'意大利U17',
    '韩国(U17)':'韩国U17',
    '挪威(U19)':'挪威U19',
    '英格兰(U19)':'英格兰U19',
    '智利(U17)':'智利U17',
    '沙特阿拉伯(U17)':'沙特阿拉伯U17',
    '拉马德里德备队':'拉马德里后备队',
    '阿联酋(U17)':'阿联酋U17',
    '德国(U20)':'德国U20',
    '意大利(U20)':'意大利U20',
    '乌兰巴托':'乌兰巴托FC',
    '哥伦比亚(U18)':'哥伦比亚U18',
    '埃及(U18)':'埃及U18',
    '韩国(U18)':'韩国U18',
    '英格兰(U18)':'英格兰U18',
    '捷克(U19)':'捷克U19',
    '美国(U18)':'美国U18',
    '爱尔兰(U18)':'爱尔兰U18',
    '葡萄牙(U16)':'葡萄牙U16',
    '丹麦(U16)':'丹麦U16',
    '丹麦(U17)':'丹麦U17',
    '卡塔尔(U17)':'卡塔尔U17',
    '克罗地亚(U17)':'克罗地亚U17',
    '匈牙利(U17)':'匈牙利U17',
    '丹麦(U19)':'丹麦U19',
    '奥地利(U19)':'奥地利U19',
    '阿尔及利亚(U20)':'阿尔及利亚U20',
    '阿尔巴尼亚(U19)':'阿尔巴尼亚U19',
    '立陶宛(U19)':'立陶宛U19',
    '也门(U17)':'也门U17',
    '博尔戈塞':'博尔戈塞西亚',
    '捷克(U18)':'捷克U18',
    '斯洛伐克(U18)':'斯洛伐克U18',
    '摩尔多瓦(U20)':'摩尔多瓦U20',
    '瑞士(U18)':'瑞士U18',
    '希腊(U18)':'希腊U18',
    '葡萄牙(U17)':'葡萄牙U17',
    '沙特阿拉伯(U16)':'沙特阿拉伯U16',
    '夏普尔布内慕斯':'夏普尔布内慕斯慕斯',
    '埃努古流浪':'埃努古流浪者',
    '伊科罗杜城':'伊科罗杜城FC',
    '土耳其(U16)':'土耳其U16',
    '罗马尼亚(U16)':'罗马尼亚U16',
    '加拿大(U18)':'加拿大U18',
    '西班牙(U18)':'西班牙U18',
    '挪威(U16)':'挪威U16',
    '瑞典(U16)':'瑞典U16',
    '巴西(U18)':'巴西U18',
    '科特迪瓦(U18)':'科特迪瓦U18',
    '德国(U16)':'德国U16',
    '希腊(U16)':'希腊U16',
    '英格兰(U17)':'英格兰U17',
    '委内瑞拉(U16)':'委内瑞拉U16',
    '科索沃女足(U17)':'科索沃女足U17',
    '阿塞拜疆女足(U17)':'阿塞拜疆女足U17',
    'ASC中心':'ASC中心FC',
    '土耳其(U19)':'土耳其U19',
    '爱尔兰女足(U17)':'爱尔兰女足U17',
    '阿尔巴尼亚女足(U17)':'阿尔巴尼亚女足U17',
    '波兰(U16)':'波兰U16',
    '奥地利(U16)':'奥地利U16',
    '克罗地亚(U19)':'克罗地亚U19',
    '德国(U17)':'德国U17',
    '以色列(U17)':'以色列U17',
    '斯洛文尼亚(U19)':'斯洛文尼亚U19',
    '法罗群岛(U19)':'法罗群岛U19',
    '瑞典(U18)':'瑞典U18',
    '乌拉圭(U18)':'乌拉圭U18',
    '卡塔尔(U19)':'卡塔尔U19',
    '爱尔兰(U19)':'爱尔兰U19',
    '塞尔维亚女足(U17)':'塞尔维亚女足U17',
    '斯洛文尼亚女足(U17)':'斯洛文尼亚女足U17',
    '墨西哥(U20)':'墨西哥U20',
    '孟加拉警察':'孟加拉国警察',
    '俄罗斯(U19)':'俄罗斯U19',
    '沙特阿拉伯(U20)':'沙特阿拉伯U20',
    '乌斯诺维贝尔格莱德(U19)':'乌斯诺维贝尔格莱德U19',
    'SC班加鲁鲁':'SC班加罗尔',
    '哈萨克斯坦(U17)':'哈萨克斯坦U17',
    '俄罗斯(U16)':'俄罗斯U16',
    '查亚普拉':'查亚普拉佩西普拉',
    '亚美尼亚(U19)':'亚美尼亚U19',
    '爱沙尼亚(U19)':'爱沙尼亚U19',
    '乌兹别克斯坦(U20)':'乌兹别克斯坦U20',
    '亚美尼亚(U20)':'亚美尼亚U20',
    '保加利亚(U17)':'保加利亚U17',
    '马耳他(U17)':'马耳他U17',
    '比利时(U19)':'比利时U19',
    '北爱尔兰(U19)':'北爱尔兰U19',
    '巴特纳':'CA巴特纳',
    '格鲁吉亚(U19)':'格鲁吉亚U19',
    '拉脱维亚(U19)':'拉脱维亚U19',
    '法国(U18)':'法国U18',
    '塞内加尔(U18)':'塞内加尔U18',
    '黑山(U19)':'黑山U19',
    '以色列(U19)':'以色列U19',
    '赫塔威尔斯':'WSC赫塔威尔斯',
    '登比察':'W.登比察',
    '高知联':'高知联合',
    '北那空湄索联':'北那空美索联',
    '伯斯古杜斯':'伯斯古古杜斯',
    '迪欧斯捷尔B队':'迪欧斯捷尔二队',
    '格洛斯卓普':'格洛斯楚普',
    '芬兰(U18)':'芬兰U18',
    '威尔士(U18)':'威尔士U18',
    '法国(U17)':'法国U17',
    '挪威(U18)':'挪威U18',
    '格罗姆诺维斯塔':'格罗姆新斯塔夫',
    '奥地利(U17)':'奥地利U17',
    '桑丹斯基':'韦伦桑丹斯基',
    '别尔斯科':'瑞科德别尔斯科',
    '埃斯佩盖尔德':'埃斯佩尔盖德',
    '卓尼特斯(U19)':'卓尼特斯U19',
    '斯托尔':'斯托尔桑',
    '桑德维肯斯':'桑德维根斯',
    '温特图尔(U19)':'温特图尔U19',
    '科尔多瓦(室内)':'科尔多瓦室内足球队',
    '欧兹德绍约谷地':'欧兹德绍约沃什杰',
    '费雷登斯伯格':'费雷登斯堡',
    '索夫拉迪略(U19)':'索夫拉迪略U19',
    '菲尔特B队':'菲尔特青年队',
    '纽伦堡B队':'纽伦堡青年队',
    '施泰因巴赫':'TSV施泰因巴赫',
    '维多利科隆(U19)':'维多利科隆U19',
    '雷根斯堡B队':'雷根斯堡II队',
    '纳兹兰':'安古斯特纳兹兰',
    '博高(U19)':'博高U19',
    '努尔米耶尔维':'努尔米耶尔维NJS',
    'EBK':'EBK埃斯波',
    '斯洛瓦茨科B队':'斯洛瓦科B队',
    '荷兰(U19)':'荷兰U19',
    '马耳他(U19)':'马耳他U19',
    '巴诺维奇':'FK巴诺维奇',
    '拉克塔奇':'拉克塔斯',
    '恩戈齐市':'恩戈齐城俱乐部',
    '汉诺威业余队':'汉诺威96业余队',
    '圣洛(U19)':'圣洛U19',
    '乌赫尔布罗德':'乌赫尔斯基',
    '波德科尼斯':'FK波德科尼斯',
    '加兰塔':'斯洛云加兰塔',
    '波兰(U18)':'波兰U18',
    '特雷托马斯':'特雷托马斯蓝鸟',
    '穆尔西亚(U19)':'穆尔西亚U19',
    'CD罗达(U19)':'CD罗达U19',
    '挪威(U17)':'挪威U17',
    '科洛亚':'ESM科洛亚',
    '多恩比恩':'多恩比纳',
    '巴利米纳':'巴利米纳联队',
    '卢加诺(U21)':'卢加诺U21',
    '艾尔德里':'艾尔德里联',
    '艾比安士特宁':'艾比安斯特宁',
    '曼撒肯':'CS曼撒肯',
    '马纳科':'马纳科尔',
    '阿雷纳尔':'UD阿雷纳尔',
    '瑞欧马加达宏达(U19)':'瑞欧马加达宏达U19',
    '沃灵顿莱兰兹':'沃灵顿瑞兰',
    '哈伯勒城':'哈伯勒镇',
    '达特福德':'达特福德队',
    '布烈治':'Ux布烈治',
    '荷兰(U18)':'荷兰U18',
    '梅里达(U19)':'梅里达UDU19',
    '比利时(U18)':'比利时U18',
    '陕西联合(U21)':'陕西联合U21',
    '克莱蒙(U19)':'克莱蒙特U19',
    '特鲁瓦(U19)':'特鲁瓦U19',
    '托瑞琼恩':'托瑞琼恩CF',
    '穆尔西亚B队':'穆尔西亚城B队',
    '巴尔瑙尔戴拿模':'巴尔瑙尔迪纳摩',
    '巴奇卡托波拉(U19)':'托波拉U19',
    '安卡拉德米士邦':'安卡拉德米斯堡',
    '托里霍斯':'CD托里霍斯',
    '阿维莱斯':'阿维莱斯体育场',
    '尤尼恩斯塔斯B队':'尤尼恩斯塔斯CFB',
    '卡韦萨德尔武埃':'卡韦萨德尔布埃',
    '布拉茨拉夫文尼齐亚':'布拉茨拉夫文尼察',
    '北马其顿(U18)':'北马其顿U18',
    '黑山(U18)':'黑山U18',
    '山东泰山(U21)':'山东泰山U21',
    '沃洛格达戴拿模':'沃洛格达迪纳摩',
    'GBK':'GBK科科拉',
    'UNA':'UNA泽尔斯特',
    '梅塔拉':'FK梅塔拉卡',
    '宾高尔':'宾高尔斯波',
    '塞格德B队':'塞格德II',
    '霍德梅泽瓦':'霍德梅泽瓦沙海伊',
    '卡扬扎联':'卡扬扎',
    '卡尔斯鲁厄业余队':'卡尔斯鲁厄青年队',
    '布伦瑞克B队':'布伦瑞克II队',
    '里尔(U19)':'里尔U19',
    '里昂(U19)':'里昂U19',
    '巴黎FC(U19)':'巴黎FCU19',
    '蓬塔利耶(U19)':'蓬塔利耶U19',
    '昂热(U19)':'昂热U19',
    '巴尔马(U19)':'巴尔马U19',
    '凯维加(U19)':'凯维加U19',
    '埃斯特':'AC埃斯特',
    '塞斯托':'普罗塞斯托',
    '彼得拉隆加':'彼得拉伦盖塞综合体育俱乐部',
    '阿拉诺瓦':'ASD阿拉诺瓦',
    '朴茨茅斯女足':'朴茨茅夫女足',
    '中国(U17)':'中国U17',
    '森博格04':'森博格SV',
    '弗雷兴':'SpVg弗雷兴20',
    '维查尔':'VFL维查尔',
    '梅尔布施':'TSV梅尔布施',
    '弗兰卡维拉':'维鲁斯弗兰卡维拉',
    '波夫塔维':'波夫塔夫斯克',
    '圣加伦(U21)':'圣加伦U21',
    '加夫萨':'EGS加夫萨',
    '斯韦德鲁全黑队':'斯韦德鲁全黑',
    '阿科本达(U19)':'阿科本达U19',
    '皇家马德里(U19)':'皇家马德里U19',
    'RC卡焦戈':'RC卡迪奥戈',
    '斯特拉':'斯特拉加美俱乐部',
    '弗兰德纳塔治':'弗兰德诺维',
    '黎巴嫩女足(U17)':'黎巴嫩女足U17',
    '中国澳门女足(U17)':'中国澳门女足U17',
    '吉尔吉斯斯坦女足(U17)':'吉尔吉斯坦女足U17',
    '北马里亚纳群岛女足(U17)':'北马里亚纳群岛女足U17',
    '印度尼西亚女足(U17)':'印度尼西亚女足U17',
    '巴林女足(U17)':'巴林女足U17',
    '深圳新鹏城(U21)':'深圳新鹏城U21',
    '天津津门虎(U21)':'天津津门虎U21',
    '乌兹别克女足(U17)':'乌兹别克女足U17',
    '越南女足(U17)':'越南女足U17',
    '巴勒斯坦女足(U17)':'巴勒斯坦女足U17',
    '泰国女足(U17)':'泰国女足U17',
    '不丹女足(U17)':'不丹女足U17',
    '新加坡女足(U17)':'新加坡女足U17',
    '沙特阿拉伯女足(U17)':'沙特阿拉伯女足U17',
    '罗马尼亚女足(U19)':'罗马尼亚女足U19',
    '哈萨克斯坦女足(U19)':'哈萨克斯坦女足U19',
    '黑山女足(U19)':'黑山女足U19',
    '塞浦路斯女足(U19)':'塞浦路斯女足U19',
    '人民公安':'PVF人民公安',
    '马耳他女足(U19)':'马耳他女足U19',
    '捷克女足(U19)':'捷克女足U19',
    '鲁森比洛克(U19)':'鲁森比洛克U19',
    '扑雷索夫(U19)':'扑雷索夫U19',
    '塔特拉(U19)':'塔特拉U19',
    '格鲁吉亚女足(U19)':'格鲁吉亚女足U19',
    '保加利亚女足(U19)':'保加利亚女足U19',
    '芬兰女足(U17)':'芬兰女足U17',
    '乌克兰女足(U17)':'乌克兰女足U17',
    '拉脱维亚女足(U17)':'拉脱维亚女足U17',
    '立陶宛女足(U17)':'立陶宛女足U17',
    '爱沙尼亚女足(U17)':'爱沙尼亚女足U17',
    '法罗群岛女足(U17)':'法罗群岛女足U17',
    '瑞士女足(U19)':'瑞士女足U19',
    '波黑女足(U19)':'波黑女足U19',
    '英格兰女足(U19)':'英格兰女足U19',
    '丹麦女足(U19)':'丹麦女足U19',
    '挪威女足(U17)':'挪威女足U17',
    '爱尔兰女足(U19)':'爱尔兰女足U19',
    '亚美尼亚女足(U19)':'亚美尼亚女足U19',
    '罗马尼亚女足(U17)':'罗马尼亚女足U17',
    '苏格兰女足(U17)':'苏格兰女足U17',
    '尼加拉瓜(U16)':'尼加拉瓜U16',
    '斯洛文尼亚女足(U19)':'斯洛文尼亚女足U19',
    '塞尔维亚女足(U19)':'塞尔维亚女足U19',
    '孟加拉女足(U17)':'孟加拉女足U17',
    '芬兰女足(U19)':'芬兰女足U19',
    '比利时女足(U19)':'比利时女足U19',
    '苏格兰女足(U19)':'苏格兰女足U19',
    '克罗地亚女足(U19)':'克罗地亚女足U19',
    '法国女足(U23)':'法国女足U23',
    '比利时女足(U23)':'比利时女足U23',
    '意大利女足(U23)':'意大利女足U23',
    '德国女足(U17)':'德国女足U17',
    '哈萨克斯坦女足(U17)':'哈萨克斯坦女足U17',
    '白俄罗斯女足(U19)':'白俄罗斯女足U19',
    '俄罗斯女足(U19)':'俄罗斯女足U19',
    '斯洛伐克女足(U19)':'斯洛伐克女足U19',
    '土耳其女足(U19)':'土耳其女足U19',
    '威尔士女足(U19)':'威尔士女足U19',
    '希腊女足(U19)':'希腊女足U19',
    '冰岛女足(U17)':'冰岛女足U17',
    '捷克女足(U17)':'捷克女足U17',
    '布隆迪(U17)':'布隆迪U17',
    '爱沙尼亚女足(U19)':'爱沙尼亚女足U19',
    '拉脱维亚女足(U19)':'拉脱维亚女足U19',
  };   // 跨源/异译对：非常规写法 -> 规范名。
     // ★ 2026-10-21：由 _edit_tmp/mine_alias_v2.cjs 跨源挖掘产出 307 组
     //   （okooo bake+gqj2_cache 与 7m/澳客 _7m_db 按「开赛日+HHMM」对齐 8945 场，
     //     取可靠对齐对里两源队名的共现，要求 n≥2 且跨≥2 个比赛日；规范名=更完整译名）。
function normTeamName(id, zh, zht, sb){
  if (id != null && id !== '' && TEAM_CANON[id] != null) return TEAM_CANON[id];
  const cands = [zh, zht, sb].map(function(s){ return decodeName(s); });
  let pick = '';
  for (const c of cands){ if (c && c.length >= 2){ pick = c; break; } }
  if (!pick) pick = String(zh || zht || sb || '');
  if (TEAM_ALIAS[pick]) pick = TEAM_ALIAS[pick];
  if (id != null && id !== '') TEAM_CANON[id] = pick;
  return pick;
}

/* ---------- 联赛名（league_id -> 简体中文名） ----------
   来源：/api/football_league（干净中文名，无需 PUA 解码），实测 100% 覆盖赛事列表。 */
const LEAGUE_MAP = {
    '1':'爱超',
    '2':'阿甲',
    '3':'奥甲',
    '4':'巴西甲',
    '5':'比甲',
    '6':'波兰超',
    '7':'丹麦超',
    '8':'德甲',
    '9':'德乙',
    '10':'俄超',
    '11':'法甲',
    '12':'法乙',
    '13':'芬超',
    '15':'韩K联',
    '16':'荷甲',
    '17':'荷乙',
    '21':'美职业',
    '22':'挪超',
    '23':'葡超',
    '25':'日职联',
    '26':'瑞典超',
    '29':'苏超',
    '30':'土超',
    '31':'西甲',
    '32':'希腊超',
    '33':'西乙',
    '34':'意甲',
    '35':'英乙',
    '36':'英超',
    '37':'英冠',
    '39':'英甲',
    '40':'意乙',
    '50':'丹麦杯',
    '60':'中超',
    '61':'中甲',
    '62':'克亚杯',
    '70':'葡杯',
    '74':'瑞士杯',
    '89':'解放者杯',
    '90':'英足总杯',
    '103':'欧冠杯',
    '108':'比利时杯',
    '113':'欧罗巴杯',
    '118':'以超',
    '119':'乌克超',
    '120':'斯亚',
    '121':'瑞士甲',
    '122':'瑞典甲',
    '123':'挪甲',
    '124':'罗甲',
    '127':'丹麦甲',
    '128':'奥甲',
    '129':'塞尔超',
    '130':'土甲',
    '131':'保甲',
    '132':'斯伐超',
    '133':'克亚甲',
    '135':'威超',
    '136':'匈甲',
    '137':'捷甲',
    '138':'比乙',
    '140':'墨西联',
    '142':'意丙',
    '143':'斯伐杯',
    '146':'英议联',
    '150':'苏冠',
    '157':'葡甲',
    '159':'塞浦甲',
    '160':'以甲',
    '165':'北爱超',
    '166':'冰岛超',
    '168':'塞浦杯',
    '170':'希腊甲',
    '190':'威杯',
    '193':'阿尔甲',
    '194':'新加坡联',
    '196':'保杯',
    '208':'斯尼杯',
    '210':'欧青U17',
    '212':'芬甲',
    '214':'拉脱超',
    '217':'立陶甲',
    '218':'瑞典',
    '221':'波兰甲',
    '230':'白俄超',
    '235':'俄甲',
    '239':'非冠杯',
    '240':'乌拉甲',
    '242':'秘鲁甲',
    '247':'斯亚甲',
    '250':'哥伦甲',
    '262':'非联杯',
    '263':'南美杯',
    '271':'丹麦',
    '273':'澳超',
    '279':'伊朗超',
    '284':'日职',
    '290':'捷甲',
    '292':'沙特联',
    '298':'英议南',
    '301':'阿联酋超',
    '303':'埃及超',
    '308':'南非超',
    '309':'约超联',
    '311':'香港超',
    '313':'卡塔尔联',
    '314':'叙利亚甲',
    '315':'阿尔巴超',
    '316':'马来超',
    '318':'巴林超',
    '321':'摩洛超',
    '322':'科威特联',
    '324':'利比亚甲',
    '325':'黎巴联',
    '326':'突尼甲',
    '332':'阿曼联',
    '336':'英南超',
    '341':'新西兰联',
    '342':'英依联甲',
    '348':'阿尔巴甲',
    '351':'斯伐甲',
    '352':'波斯甲',
    '353':'爱沙甲',
    '354':'巴拉甲',
    '358':'巴西',
    '365':'北爱联杯',
    '389':'摩尔甲',
    '391':'委内超',
    '392':'北马其甲',
    '415':'智利甲',
    '423':'阿甲',
    '431':'斯伐',
    '440':'法女甲',
    '441':'德女联',
    '443':'瑞典女超',
    '448':'美冠联',
    '455':'日职女',
    '459':'日职女甲',
    '466':'哈萨克超',
    '469':'阿美超',
    '473':'挪女超',
    '475':'芬女超',
    '476':'俄青联',
    '483':'美公开赛',
    '500':'波青联',
    '504':'哥斯甲',
    '508':'女挪威杯',
    '511':'萨尔超',
    '514':'卢森甲',
    '526':'女欧U17',
    '533':'马耳甲',
    '540':'丹女杯',
    '559':'科王杯',
    '562':'黑山甲',
    '563':'格鲁甲',
    '566':'英依超',
    '573':'荷女甲',
    '575':'比女甲',
    '576':'法罗甲',
    '577':'洪都甲',
    '579':'危地甲',
    '593':'玻利甲',
    '596':'厄瓜甲',
    '611':'智利',
    '613':'阿塞超',
    '628':'挪威U19',
    '635':'哥伦杯',
    '645':'中女超',
    '646':'爱沙杯',
    '664':'加拿冠',
    '677':'意青联',
    '686':'中甲',
    '693':'德丙',
    '699':'海湾U17',
    '700':'泰超',
    '703':'匈甲',
    '706':'捷丙',
    '713':'英北超',
    '714':'智利杯',
    '720':'丹女超',
    '729':'澳女联',
    '730':'女世杯U17',
    '733':'阿联杯',
    '740':'阿联酋甲',
    '745':'沙地甲',
    '748':'北爱冠',
    '749':'沙地青',
    '750':'土女甲',
    '766':'越南联',
    '771':'马统杯',
    '772':'乌兹超',
    '780':'日足联',
    '781':'非青U17',
    '783':'以甲',
    '802':'美女职',
    '816':'丹麦U19',
    '823':'乌兹杯',
    '847':'墨西甲',
    '861':'英女南',
    '863':'阿尔',
    '872':'乌克甲',
    '880':'安道超',
    '882':'泰足总',
    '889':'女解放者杯',
    '896':'巴林甲',
    '897':'立陶',
    '898':'伊朗甲',
    '907':'南非甲',
    '915':'塞浦',
    '927':'乌克U21',
    '947':'以女甲',
    '949':'尼日超',
    '950':'沙地',
    '951':'西丁',
    '952':'以U19',
    '953':'摩洛',
    '963':'巴伯联',
    '969':'比U21',
    '984':'以女杯',
    '994':'马耳女甲',
    '1000':'马耳',
    '1014':'摩尔',
    '1016':'英女北',
    '1032':'德戊',
    '1042':'斯伐U19',
    '1043':'爱沙',
    '1046':'白俄甲',
    '1047':'冰女超',
    '1048':'泰甲',
    '1049':'俄女超',
    '1054':'伊拉联',
    '1056':'匈女甲',
    '1061':'塞尔甲',
    '1062':'阿美甲',
    '1070':'拉脱甲',
    '1076':'巴拉',
    '1077':'哈萨克甲',
    '1078':'约旦甲',
    '1085':'丹后备',
    '1086':'白俄女超',
    '1092':'苏女超',
    '1106':'土U19联',
    '1107':'斯亚U19',
    '1114':'英后备',
    '1122':'印尼超',
    '1147':'英总女超',
    '1154':'爱沙',
    '1159':'波女超',
    '1160':'乌兹甲',
    '1169':'哥伦',
    '1170':'埃及甲',
    '1184':'委内杯',
    '1186':'西女超',
    '1209':'英女杯',
    '1215':'英南甲',
    '1216':'英北甲',
    '1217':'意女甲',
    '1218':'世室欧预',
    '1222':'突尼',
    '1227':'印尼甲',
    '1242':'北马其',
    '1248':'越南甲',
    '1249':'奥女甲',
    '1260':'英U21',
    '1262':'保甲',
    '1264':'英U21',
    '1272':'乌克U19',
    '1275':'巴青杯',
    '1292':'韩K2联',
    '1316':'苏低联',
    '1327':'欧联U19',
    '1329':'英U21杯',
    '1333':'非青杯外',
    '1346':'日职',
    '1352':'玻利杯',
    '1355':'波兰',
    '1363':'香港甲',
    '1366':'国际友谊',
    '1367':'印度超',
    '1389':'巴圣青联',
    '1393':'加纳超',
    '1398':'厄瓜',
    '1407':'挪丙',
    '1409':'牙买超',
    '1413':'西协',
    '1414':'法U19',
    '1416':'德地区',
    '1417':'芬丙',
    '1423':'罗甲',
    '1424':'希丙',
    '1425':'瑞士',
    '1426':'澳丙',
    '1427':'丹麦',
    '1428':'挪甲',
    '1430':'瑞典女甲',
    '1431':'土甲',
    '1432':'土丙',
    '1434':'阿联U21',
    '1436':'瑞典',
    '1443':'缅甸联',
    '1451':'津巴超',
    '1456':'肯尼超',
    '1457':'美超',
    '1461':'阿曼特',
    '1464':'喀麦隆甲',
    '1465':'埃塞超',
    '1466':'卢旺达联',
    '1471':'安哥甲',
    '1473':'乌拉',
    '1479':'科特超',
    '1482':'秘鲁',
    '1494':'巴马甲',
    '1497':'芬K联',
    '1500':'泰丙',
    '1501':'委内',
    '1514':'奥丁',
    '1517':'日地区联',
    '1520':'黑山',
    '1523':'马维超',
    '1524':'比业余',
    '1527':'孟加拉联',
    '1528':'多米联',
    '1531':'巴拉后备',
    '1534':'波兰',
    '1536':'赞比亚超',
    '1538':'柬埔超',
    '1547':'塞尔U19',
    '1557':'捷丁',
    '1563':'哥斯',
    '1564':'菲律甲',
    '1566':'危地',
    '1567':'新西女超',
    '1570':'匈丙',
    '1579':'印西隆联',
    '1586':'尼拉甲',
    '1587':'荷丁',
    '1589':'挪女甲',
    '1593':'乌干超',
    '1604':'塞尔女甲',
    '1606':'北爱后备',
    '1609':'墨西',
    '1611':'丹麦丁',
    '1612':'克亚',
    '1623':'坦桑超',
    '1634':'阿后备',
    '1635':'乌拉后备',
    '1640':'斯亚女联',
    '1644':'西女甲',
    '1650':'意丁',
    '1653':'哥伦U19',
    '1654':'奥业余杯',
    '1655':'阿塞甲',
    '1657':'北马女联',
    '1658':'乌克',
    '1662':'圣马甲',
    '1663':'香港',
    '1667':'巴西女杯',
    '1677':'意丁杯',
    '1683':'直布超',
    '1685':'以丙',
    '1686':'罗女超',
    '1695':'葡锦标',
    '1712':'黎甲',
    '1734':'希腊U19',
    '1741':'布隆迪超',
    '1750':'科索沃超',
    '1756':'瑞女超',
    '1762':'巴高',
    '1766':'中台联',
    '1768':'克亚U19',
    '1770':'马代超',
    '1776':'德女',
    '1786':'希腊女超',
    '1789':'约女联',
    '1791':'孟加拉杯',
    '1810':'立陶女甲',
    '1813':'超联杯',
    '1817':'墨西女超',
    '1820':'西青U19',
    '1826':'塞浦女甲',
    '1827':'安巴超',
    '1833':'西女',
    '1851':'威女超',
    '1862':'加勒比杯',
    '1866':'毛里甲',
    '1875':'博茨超',
    '1888':'塞内甲',
    '1889':'塔吉克联',
    '1905':'巴米青联',
    '1909':'蒙古超',
    '1912':'苏女甲',
    '1913':'圣尼超',
    '1919':'克亚女联',
    '1933':'危地女甲',
    '1939':'巴卡德',
    '1956':'英南超中',
    '1957':'葡U23',
    '1960':'中冠',
    '1977':'智利丁',
    '1979':'巴卡杯',
    '1980':'南非后备',
    '1997':'安道',
    '2002':'缅甸U20',
    '2035':'哥斯女甲',
    '2044':'南非女联',
    '2049':'印尼U20',
    '2051':'威冠',
    '2060':'克亚',
    '2072':'巴高女联',
    '2073':'布法联',
    '2074':'印班超',
    '2100':'卢森',
    '2107':'土库曼超',
    '2112':'黑山U19',
    '2134':'西地区联',
    '2137':'巴阿锦标',
    '2141':'捷戊',
    '2149':'所罗岛联',
    '2153':'巴青联',
    '2159':'尼拉',
    '2166':'泰女超',
    '2167':'葡女锦',
    '2180':'巴波',
    '2184':'哥伦地区',
    '2187':'欧协联',
    '2188':'利女联',
    '2189':'危地丁',
    '2193':'阿青联',
    '2203':'尼日尔联',
    '2213':'阿根地区',
    '2218':'巴马全联',
    '2225':'罗女甲',
    '2228':'乌干女超',
    '2232':'波女联',
    '2246':'莫桑冠',
    '2251':'葡丙',
    '2254':'西协甲',
    '2256':'丹女',
    '2259':'法女',
    '2263':'日女联',
    '2276':'摩洛女联',
    '2279':'桑给超',
    '2281':'南非',
    '2284':'肯尼女联',
    '2290':'墨西A',
    '2307':'利比里联',
    '2318':'斯伐女联',
    '2327':'比地区',
    '2338':'洪都后备',
    '2340':'马来A1联',
    '2343':'美预备联',
    '2366':'里约',
    '2386':'玻利地杯',
    '2407':'捷女',
    '2410':'意女',
    '2416':'缅甸女联',
    '2428':'沙地后备',
    '2430':'塞利昂超',
    '2435':'英女联',
    '2452':'中女甲',
    '2465':'瑞女',
    '2468':'中U21',
    '2482':'中美俱杯',
    '2498':'瑞士丁',
    '2511':'巴伊',
    '2512':'印孟超',
    '2533':'伊拉甲',
    '2551':'爱U20',
    '2552':'越女联',
    '2573':'墨西女U19',
    '2578':'德青联',
    '2581':'亚挑联',
    '2583':'玻利联U19',
    '2587':'墨西U19',
    '2604':'英协联杯',
    '2608':'匈女',
    '2609':'香港U22',
    '2612':'科索沃',
    '2618':'北马U19',
    '2622':'科索U19',
    '2627':'阿根业余锦',
    '2632':'美甲',
    '2635':'阿联U23',
    '2643':'百慕超联',
    '2644':'苏里南联',
    '2659':'俄A',
    '2660':'俄B',
    '2661':'罗女',
    '2674':'加拿北女超',
    '2702':'墨西U21',
    '2709':'马维女联',
    '2733':'意卓联',
    '2738':'新加坡U23',
    '2742':'巴帕杯',
    '2746':'澳锦标',
    '2769':'湘超',
    '2783':'波斯',
    '2784':'波斯',
    '2806':'法女联杯',
    '2821':'渝超',
    '2874':'墨西',
    '2875':'法全',
    '2882':'约盾杯U21',
    '2887':'巴格女甲',
    '2888':'约旦U20',
    '2889':'保加职业杯',
    '2890':'印西隆超杯',
};

/* 联赛名全拼（用于按首拼 A→Z 排序），由 pypinyin 预生成 */
const LEAGUE_PY = {
    "不丹廷联":"budantinglian",
    "世女杯U20":"shinvbeiu20",
    "中冠":"zhongguan",
    "中美俱杯":"zhongmeijubei",
    "中青U13":"zhongqingu13",
    "中青U15":"zhongqingu15",
    "中青U17":"zhongqingu17",
    "丹麦U19":"danmaiu19",
    "丹麦杯":"danmaibei",
    "乌克U19":"wukeu19",
    "乌克兰杯":"wukelanbei",
    "乌兹职联":"wuzizhilian",
    "乌兹超":"wuzichao",
    "乌干超":"wuganchao",
    "乌拉杯":"wulabei",
    "以U19":"yiu19",
    "以乙":"yiyi",
    "伊拉联":"yilalian",
    "俄杯":"ebei",
    "保超杯":"baochaobei",
    "克亚杯":"keyabei",
    "冰岛甲":"bingdaojia",
    "加勒比杯":"jialeibibei",
    "加拿职":"jianazhi",
    "北爱女超":"beiainvchao",
    "北马其杯":"beimaqibei",
    "南美杯":"nanmeibei",
    "南非超":"nanfeichao",
    "印米佐超":"yinmizuochao",
    "印西隆联":"yinxilonglian",
    "危地甲":"weidijia",
    "哈萨克乙":"hasakeyi",
    "哈萨克超":"hasakechao",
    "哥伦乙":"gelunyi",
    "哥伦女甲":"gelunnvjia",
    "哥伦杯":"gelunbei",
    "哥伦甲":"gelunjia",
    "国际友谊":"guojiyouyi",
    "圣马杯":"shengmabei",
    "坦桑超":"tansangchao",
    "埃及超":"aijichao",
    "塞尔U19":"saieru19",
    "大洋女U16":"dayangnvu16",
    "女挪威杯":"nvnuoweibei",
    "女瑞典杯":"nvruidianbei",
    "委内杯":"weineibei",
    "安哥甲":"angejia",
    "安道超杯":"andaochaobei",
    "尼拉森联":"nilasenlian",
    "巴U20杯":"bau20bei",
    "巴亚马乙":"bayamayi",
    "巴戈乙":"bageyi",
    "巴拉丙":"balabing",
    "巴拉乙":"balayi",
    "巴米女联":"baminvlian",
    "巴西乙":"baxiyi",
    "巴青杯":"baqingbei",
    "巴青联":"baqinglian",
    "巴高乙":"bagaoyi",
    "布隆迪超":"bulongdichao",
    "希业余杯":"xiyeyubei",
    "希腊U19":"xilau19",
    "希腊杯":"xilabei",
    "希腊甲":"xilajia",
    "德地区":"dediqu",
    "德戊":"dewu",
    "意丙杯":"yibingbei",
    "意青超杯":"yiqingchaobei",
    "捷克杯":"jiekebei",
    "捷甲":"jiejia",
    "捷青联":"jieqinglian",
    "斯伐U19":"sifau19",
    "斯伐杯":"sifabei",
    "斯尼杯":"sinibei",
    "日职丙":"rizhibing",
    "日联杯":"rilianbei",
    "智利乙":"zhiliyi",
    "智利女甲":"zhilinvjia",
    "柬杯":"jianbei",
    "格鲁丙":"gelubing",
    "格鲁甲":"gelujia",
    "桑给超":"sanggeichao",
    "欧冠杯":"ouguanbei",
    "欧联U19":"oulianu19",
    "沙地甲":"shadijia",
    "沙滩足":"shatanzu",
    "沙特联":"shatelian",
    "波兰丙":"bolanbing",
    "波斯甲":"bosijia",
    "澳足总":"aozuzong",
    "爱沙甲":"aishajia",
    "玻利杯":"bolibei",
    "球会友谊":"qiuhuiyouyi",
    "瑞典甲":"ruidianjia",
    "瑞士丁":"ruishiding",
    "瑞女乙":"ruinvyi",
    "瑞女超":"ruinvchao",
    "皇后杯":"huanghoubei",
    "科索沃超":"kesuowochao",
    "立陶女甲":"litaonvjia",
    "立陶甲":"litaojia",
    "美甲杯":"meijiabei",
    "美职业":"meizhiye",
    "美预备联":"meiyubeilian",
    "芬K联":"fenklian",
    "芬超":"fenchao",
    "苏超":"suchao",
    "英U21杯":"yingu21bei",
    "英冠":"yingguan",
    "英北甲":"yingbeijia",
    "英协联杯":"yingxielianbei",
    "英联杯":"yinglianbei",
    "英足总杯":"yingzuzongbei",
    "荷甲":"hejia",
    "萨尔超":"saerchao",
    "葡U23":"puu23",
    "葡超":"puchao",
    "西联杯":"xilianbei",
    "解放者杯":"jiefangzhebei",
    "里约甲":"liyuejia",
    "阿乙":"ayi",
    "阿后备":"ahoubei",
    "阿塞甲":"asaijia",
    "阿根廷杯":"agentingbei",
    "阿美超":"ameichao",
    "韩K联":"hanklian",
    "香港U22":"xianggangu22",
    "马维超":"maweichao",
    "马足总":"mazuzong",
    "黎足总":"lizuzong",
    "黑山甲":"heishanjia"
  };
function leagueSortKey(name){
  const n = String(name||'');
  return (LEAGUE_PY[n] || n).toLowerCase();
}

/* 取清晰的中文联赛名：league_id 查表 → PUA 解码中文 → 英文缩写 */
function leagueName(m){
  if (!m) return '未知联赛';
  const byId = (m.league_id!==undefined && m.league_id!==null) ? LEAGUE_MAP[String(m.league_id)] : null;
  if (byId) return byId;
  const zh = decodeName(m.league_name_zh);
  if (zh && zh.length>=2) return zh;
  const en = cleanName(m.league_name_en);
  if (en) return en;
  return '未知联赛';
}

/* 运行时自学习：拿到精确队名后，与混淆串逐位对齐，学会新的 PUA 码点
   （每个 PUA 码点恰好替换原串中的一个汉字，故长度相等即可按位对应） */
function learnPua(garbled, clean){
  if (!garbled || !clean) return 0;
  const body = String(garbled).replace(/<[^>]*>/g, '');   // 去标签，保留实体与汉字
  const re = /&#x([eE][0-9a-fA-F]{2,4});/g;
  const seq = [];                                          // 每项：null=可读字，或码点字符串
  let pos = 0, m;
  while ((m = re.exec(body)) !== null){
    for (const _ of body.slice(pos, m.index)) seq.push(null);
    seq.push(m[1].toLowerCase());
    pos = m.index + m[0].length;
  }
  for (const _ of body.slice(pos)) seq.push(null);
  if (seq.length !== clean.length) return 0;               // 长度不符则不猜
  let learned = 0;
  for (let i = 0; i < seq.length; i++){
    const code = seq[i];
    if (code && !PUA_MAP[code]){ PUA_MAP[code] = clean[i]; learned++; }
  }
  return learned;
}

/* ---------- 交锋 / 积分 / 排名 / 伤停 结论生成 ---------- */
function _form(records, teamName){
  let w=0,d=0,l=0,gf=0,ga=0,n=0;
  for (const r of (records||[])){
    const hs=+r.home_team_score, vs=+r.visiting_team_score;
    if (isNaN(hs)||isNaN(vs)) continue;
    const isHome = (r.home_team===teamName);
    const my=isHome?hs:vs, op=isHome?vs:hs;
    gf+=my; ga+=op; n++;
    if (my>op) w++; else if (my<op) l++; else d++;
  }
  return {w,d,l,gf,ga,n};
}
function _mutual(records, h, a){
  const out=[];
  for (const r of (records||[])){
    const s=new Set([r.home_team, r.visiting_team]);
    if (s.has(h) && s.has(a)) out.push(r);
  }
  return out;
}
// info: {base,matchrank,battle,injury} 来自 /api/get_football_analysis
function summarizeInfo(info, agg, zhanyi, corr){
  const aggBs = corr && corr.aggBs;
  const base = info && info.base || {};
  const mr   = info && info.matchrank || {};
  const bt   = info && info.battle || {};
  const inj  = info && info.injury || [];
  const h = base.home_team || '主队', a = base.away_team || '客队';

  const lines = [];
  // 1) 排名 / 积分
  const hr = mr.home||{}, ar = mr.away||{};
  const hRank = hr.rank, aRank = ar.rank;
  const hPts = hr.getscore!=null?+hr.getscore:null, aPts = ar.getscore!=null?+ar.getscore:null;
  const hWr = hr.winrate||{}, aWr = ar.winrate||{};
  if (hRank!=null || aRank!=null){
    lines.push(`<b>排名/积分</b><span>${h} 第${hRank||'?'}名(积${hPts??'?'}分，近${hWr.total||0}场 ${hWr.win||0}胜${hWr.draw||0}平${hWr.lose||0}负) ｜ ${a} 第${aRank||'?'}名(积${aPts??'?'}分，近${aWr.total||0}场 ${aWr.win||0}胜${aWr.draw||0}平${aWr.lose||0}负)</span>`);
  }
  const rankGap = (hRank!=null && aRank!=null) ? (+hRank - +aRank) : null;

  // 2) 近期状态（battle.home = 主队近期，battle.away = 客队近期）
  const hf = _form(bt.home, h), af = _form(bt.away, a);
  if (hf.n){ lines.push(`<b>主队近况</b><span>${hf.n}场 ${hf.w}胜${hf.d}平${hf.l}负，进${hf.gf}/失${hf.ga}（${hf.n?((hf.gf+hf.ga)/hf.n).toFixed(2):'-'}球/场）</span>`); }
  if (af.n){ lines.push(`<b>客队近况</b><span>${af.n}场 ${af.w}胜${af.d}平${af.l}负，进${af.gf}/失${af.ga}（${af.n?((af.gf+af.ga)/af.n).toFixed(2):'-'}球/场）</span>`); }

  // 3) 往绩（双方近况中互相交手的比赛）
  const mutual = _mutual([...(bt.home||[]), ...(bt.away||[])], h, a);
  let h2hText='';
  if (mutual.length){
    let mw=0,md=0,ml=0;
    const recs = mutual.slice(0,6).map(r=>{
      const hs=+r.home_team_score, vs=+r.visiting_team_score;
      const homeIsH = r.home_team===h;
      const my=homeIsH?hs:vs, op=homeIsH?vs:hs;
      if (my>op) mw++; else if (my<op) ml++; else md++;
      return `${r.competing_time} ${r.home_team} ${hs}-${vs} ${r.visiting_team}`;
    }).join(' ｜ ');
    h2hText = `近${mutual.length}次交锋 ${h} ${mw}胜${md}平${ml}负：${recs}`;
    lines.push(`<b>历史交锋</b><span>${h2hText}</span>`);
  } else {
    lines.push(`<b>历史交锋</b><span>近况库中暂无双方直接交锋记录</span>`);
  }

  // 4) 伤停
  if (Array.isArray(inj) && inj.length){
    const txt = inj.slice(0,6).map(x=>`${x.team||''}${x.player||x.name||''}(${x.reason||x.type||'伤停'})`).join('，');
    lines.push(`<b>伤停</b><span class="warn">${txt}</span>`);
  }

  // 5) 综合结论（由工具自动填写）
  const parts = [];
  if (rankGap!=null){
    if (rankGap <= -3) parts.push(`${h}排名明显高于${a}(差${Math.abs(rankGap)}位)，实力与档位占优`);
    else if (rankGap >= 3) parts.push(`${a}排名明显高于${h}(差${rankGap}位)，客队档位占优`);
    else parts.push(`双方排名接近(差${rankGap}位)`);
  }
  if (hf.n && af.n){
    const hs = hf.n?hf.w/hf.n:0, as = af.n?af.w/af.n:0;
    if (hs - as >= 0.25) parts.push(`${h}近期状态更佳`);
    else if (as - hs >= 0.25) parts.push(`${a}近期状态更佳`);
    else parts.push(`双方近期状态接近`);
  }
  if (mutual.length){
    let mw=0,md=0,ml=0;
    for (const r of mutual){ const hs=+r.home_team_score,vs=+r.visiting_team_score; const homeIsH=r.home_team===h; const my=homeIsH?hs:vs,op=homeIsH?vs:hs; if(my>op)mw++;else if(my<op)ml++;else md++; }
    if (mw && !ml) parts.push(`往绩${h}全胜占优`);
    else if (ml && !mw) parts.push(`往绩${a}占优`);
    else if (mw===ml && mw>0) parts.push(`往绩互有胜负`);
  }
  // 结合盘口
  if (agg && agg.o0h){
    // agg.o_h/o_d/o_a 是赔率 → 市场看好 = 赔率最低者（旧代码取最大值，等于说市场看好最冷门，已修正）
    const fav = (agg.o_h!==null) ? (['W','D','L'].reduce((b,k,i)=>([agg.o_h,agg.o_d,agg.o_a][i] < b.v ? {k, v:[agg.o_h,agg.o_d,agg.o_a][i]} : b), {k:'W',v:1e9}).k) : '—';
    const favTxt = {W:h, D:'平局', L:a}[fav];
    parts.push(`初盘市场隐含看好${favTxt}`);
    if (agg.kuopan) parts.push(`盘分差${agg.pan_gap>=0?'+':''}${fmt2(agg.pan_gap)}属${agg.pan_type}`);
  }
  // 大小球（进球数）结论
  if (aggBs && (aggBs.c_valid||0)>=3){
    const [so,od,ot] = classifyOU(aggBs.o_line, aggBs.o_ow, aggBs.o_uw, aggBs.c_line, aggBs.c_ow, aggBs.c_uw);
    if (od!=='—') parts.push(`大小球${ot}，进球数倾向${od}`);
  }
  // 比分概率（Dixon-Coles 分布，仅给分布不下定点结论）
  if (corr && corr.a && corr.a.score){
    const sc = corr.a.score;
    const topTxt = sc.top.slice(0,5).map(d=>`${d.score} ${d.p}%`).join(' · ');
    lines.push(`<b>比分概率</b><span>${topTxt}（λ主${sc.lambda}/μ客${sc.mu}，总${sc.T}；概率分布·非定点）</span>`);
    if (sc.top[1]) parts.push(`比分最可能 ${sc.top[0].score}/${sc.top[1].score}`);
  }
  // 半全场(HT/FT)概率分布
  if (corr && corr.a && corr.a.htft){
    const hf = corr.a.htft;
    const topTxt = hf.top.slice(0,5).map(d=>`${d.state} ${d.p}%`).join(' · ');
    lines.push(`<b>半全场</b><span>${topTxt}（半${hf.pHT.H}/${hf.pHT.D}/${hf.pHT.A}·全${hf.pFT.H}/${hf.pFT.D}/${hf.pFT.A}；独立半场假设·分布非定点）</span>`);
    if (hf.top[0]) parts.push(`半全场最可能 ${hf.top[0].state}`);
  }
  // 庄家热度 / PPI
  if (corr && corr.a && corr.a.ppi){
    const pp = corr.a.ppi;
    const ht = `主${pp.heat.W}/平${pp.heat.D}/客${pp.heat.L}`;
    const tag = pp.available ? '真PPI' : '热度代理';
    const hot = pp.hot_side!=='—' ? `热门:${ {W:'主',D:'平',L:'客'}[pp.hot_side] }` : '无明显热门';
    lines.push(`<b>庄家热度</b><span>${tag} ${ht} ｜ ${hot}</span>`);
    if (pp.available && pp.ppi) parts.push(`PPI 主${pp.ppi.W}/平${pp.ppi.D}/客${pp.ppi.L}`);
  }
  // 战意展示已移除（2026-10-26）：动机信号不再参与模型与结论。zhanyi 参数保留以兼容调用点。
  // 纠偏提示
  let corrNote='';
  if (corr && corr.model && corr.model.total && corr.model.total.total>=5){
    const acc = corr.model.total.hit/corr.model.total.total;
    corrNote = `（自我纠偏：历史${corr.model.total.total}场综合命中${(acc*100).toFixed(0)}%）`;
  }
  const conclusion = `【综合研判】${parts.join('；')}。${corrNote}`;
  lines.push(`<b>工具结论</b><span class="concl">${conclusion}</span>`);

  return { lines, conclusion, rankGap, h2h: mutual.length, injury: Array.isArray(inj)?inj.length:0,
           homeForm: hf, awayForm: af };
}

/* ---------- 信息面先验（伤停 / 近期状态 / 排名 / 交锋 → WDL 先验 + 置信调整）----------
   数据来源：/get_football_analysis 的 info.{matchrank,battle,injury}（bake 快照已含，列式存储{"#":cols,"r":rows}）。
   ⚠ 诚实声明：历史回测文件(backtest_*.json)不含这些字段，故本先验【无法用 9/4–9/13 回测】；
     因此只做"保守置信调整 + 强背离降级"，绝不改方向；其增量效果需随预测留档逐步验证。 */
function _cl(v,lo,hi){ v=+v; if(!isFinite(v))return 0; return Math.max(lo,Math.min(hi,v)); }
function _n(v){ const x=parseFloat(v); return isFinite(x)?x:null; }
/* 行集兼容：既支持列式 { "#":[列], r:[[值]] }，也支持前端解包后的 [{列:值}] */
function _rows(obj){
  if(!obj) return null;
  if(Array.isArray(obj)) return obj;
  if(Array.isArray(obj['#'])&&Array.isArray(obj.r)){ const c=obj['#']; return obj.r.map(row=>{ const o={}; for(let i=0;i<c.length;i++)o[c[i]]=row[i]; return o; }); }
  return null;
}
function parseInfoFeatures(info, refMs){
  const out={rankH:null,rankA:null,ppgH:null,ppgA:null,gdH:null,gdA:null,recH:null,recA:null,injH:0,injA:0,h2h:null,injList:[],recFresh:false};
  if(!info) return out;
  const mr=info.matchrank||{}, hr=mr.home||{}, ar=mr.away||{};
  out.rankH=_n(hr.rank); out.rankA=_n(ar.rank);
  const ppg=x=>{ const w=x.winrate||{}, t=_n(w.total)||0; return t?((_n(w.win)||0)*3+(_n(w.draw)||0))/t:null; };
  const gd =x=>{ const w=x.winrate||{}, t=_n(w.total)||0, gf=_n(x.getscore), ga=_n(x.losescore); return (t&&gf!=null&&ga!=null)?(gf-ga)/t:null; };
  out.ppgH=ppg(hr); out.ppgA=ppg(ar); out.gdH=gd(hr); out.gdA=gd(ar);
  const bt=info.battle||{}, base=info.base||{};
  const rec=side=>{ const rows=_rows(bt[side]); if(!rows) return null; const name=base[side+'_team']; if(!name) return null;
    let pts=0,g=0,n=0,mx=null;
    for(const r of rows){ const hs=_n(r.home_team_score), as=_n(r.visiting_team_score); if(hs==null||as==null) continue;
      const isH=String(r.home_team||'')===name, isA=String(r.visiting_team||'')===name; if(!isH&&!isA) continue;
      const my=isH?hs:as, op=isH?as:hs; pts+=my>op?3:(my<op?0:1); g+=my-op; n++;
      const d=r.competing_time?Date.parse(String(r.competing_time)):NaN; if(!isNaN(d)&&(mx==null||d>mx))mx=d; }
    return n?{ppg:pts/n, gdpg:g/n, n, maxD:mx}:null; };
  out.recH=rec('home'); out.recA=rec('away');
  // 新鲜度门槛：battle 数据若最新一场也早于参考日 45 天 → 判为过期，弃用"近期状态"(避免拿旧赛季数据当状态)
  const refMsN=(typeof refMs==='number'&&isFinite(refMs))?refMs:null;
  const fr=o=>(o&&o.maxD!=null&&refMsN)?(((refMsN-o.maxD)/86400000)<=45):false;
  out.recFresh = fr(out.recH)&&fr(out.recA);
  const inj=side=>{ const rows=_rows((info.injury||{})[side]); if(!rows) return 0; let s=0;
    for(const r of rows){ const pos=String(r.position||''); const nm=String(r.playername||r.player||r.name||''); const rs=String(r.reason||r.type||'');
      const posW=/守门员|门将/.test(pos)?1.4:/后卫/.test(pos)?1.0:/中场/.test(pos)?0.9:/前锋|边锋|中锋|前腰/.test(pos)?1.1:0.8;
      // 停赛/禁赛=确定缺阵(权重1.0)；伤情=可能出战/带伤(0.75)；其余(0.9)
      const rsW=/禁赛|停赛/.test(rs)?1.0:(/伤|撕裂|断裂|骨折|拉伤|扭伤|肌肉|膝|踝/.test(rs)?0.75:0.9);
      s+=posW*rsW;
      if(nm) out.injList.push(side+':'+nm+'('+(pos||'伤停')+(rs?'·'+rs:'')+')'); }
    return +s.toFixed(2); };
  out.injH=inj('home'); out.injA=inj('away');
  const hrows=_rows(bt.battle);
  if(hrows){ const hn=base.home_team; let w=0,d=0,l=0,n=0;
    for(const r of hrows){ const hs=_n(r.home_team_score), as=_n(r.visiting_team_score); if(hs==null||as==null) continue;
      const isH=String(r.home_team||'')===hn; const my=isH?hs:as, op=isH?as:hs; if(my>op)w++; else if(my<op)l++; else d++; n++; }
    if(n) out.h2h={w,d,l,n}; }
  return out;
}
function infoPrior(info, refMs){
  const f=parseInfoFeatures(info, refMs); let edge=0;
  if(f.rankH!=null&&f.rankA!=null) edge+=0.45*_cl((f.rankA-f.rankH)/10,-1,1);
  if(f.ppgH!=null&&f.ppgA!=null)   edge+=0.30*_cl((f.ppgH-f.ppgA)/1.2,-1,1);
  if(f.recH&&f.recA&&f.recFresh)   edge+=0.25*_cl((f.recH.ppg-f.recA.ppg)/2.0,-1,1)+0.15*_cl((f.recH.gdpg-f.recA.gdpg)/2.0,-1,1);
  else if(f.gdH!=null&&f.gdA!=null) edge+=0.30*_cl((f.gdH-f.gdA)/1.5,-1,1);   // battle 过期则回落到赛季净胜球
  if(f.h2h&&f.h2h.n>=2)            edge+=0.15*_cl((f.h2h.w-f.h2h.l)/f.h2h.n,-1,1);
  const injAdv=f.injA-f.injH; edge+=_cl(injAdv*0.06,-0.30,0.30); edge=_cl(edge,-1,1);
  const p={W:0.44,D:0.27,L:0.29}; p.W+=edge*0.13; p.L-=edge*0.13;
  const s=p.W+p.D+p.L; p.W/=s; p.D/=s; p.L/=s;
  const arr=[['W',p.W],['D',p.D],['L',p.L]].sort((x,y)=>y[1]-x[1]);
  return { edge:+edge.toFixed(3), p:{W:+p.W.toFixed(3),D:+p.D.toFixed(3),L:+p.L.toFixed(3)},
           biasDir:arr[0][0], margin:+(arr[0][1]-arr[1][1]).toFixed(3),
           injH:f.injH, injA:f.injA, injAdv:+injAdv.toFixed(2),
           rankH:f.rankH, rankA:f.rankA, h2h:f.h2h, recH:f.recH, recA:f.recA, recFresh:f.recFresh };
}
function applyInfoPrior(a, info, refMs){
  if(!a || !info) return a;
  let ip; try{ ip=infoPrior(info, refMs); }catch(e){ return a; }
  a.info_prior=ip;
  const pick=a.dir; let adj=0; const notes=[];
  if(['W','D','L'].includes(pick)){
    if(ip.biasDir===pick){ adj+=Math.round(6*Math.abs(ip.edge)+4*Math.max(0,ip.margin)); notes.push('信息面同向'); }
    else if(Math.abs(ip.edge)>=0.30){ adj-=Math.round(6*Math.abs(ip.edge)); notes.push('信息面背离'); }
    const rel = pick==='W'? ip.injAdv : (pick==='L'? -ip.injAdv : 0);
    const ia=_cl(rel*1.5,-5,5); if(ia){ adj+=Math.round(ia); notes.push(rel>0?'伤停利此方':'伤停不利此方'); }
  }
  adj=_cl(adj,-12,8);
  a.conf=Math.max(5,Math.min(92,Math.round((a.conf||0)+adj)));
  a.info_adj={ conf_adj:adj, biasDir:ip.biasDir, edge:ip.edge, margin:ip.margin, injH:ip.injH, injA:ip.injA, note:notes.join('；')||'—' };
  if(adj<=-8 && a.grade==='推荐'){ a.grade='参考'; a.grade_reason=(a.grade_reason||'')+'·信息面强背离降级'; }
  return a;
}
function fmt2(x){ return (x===null||x===undefined)?'—':(typeof x==='number'?x.toFixed(2):x); }

/* ---------- 自我纠正（纯计算部分） ---------- */
function actualDir(hs, as){
  if (hs==null||as==null||hs===''||as==='') return null;
  hs=+hs; as=+as; if (isNaN(hs)||isNaN(as)) return null;
  return hs>as?'W':(hs<as?'L':'D');
}
// 从 analyze() 结果抽取一个明确的"主队视角"预测方向 W/D/L/—（供复盘用）
// 注意：必须忠实反映 analyze() 的加权投票决策。此前会用 pan_predict 兜底，
// 导致"信号矛盾·观望"的场次被强行赋方向，绕过投票逻辑（回测证明显著拉低命中率）。
function pickFromAnalysis(a){
  if (!a) return '—';
  const s = (a.dir||'').trim();
  if (['W','L','D'].includes(s)) return s;
  // 资金面接管 / 仅初盘偏好：从「资金面·主胜」「仅初盘·主胜」等中文串提取 W/D/L
  if (s.includes('主胜')) return 'W';
  if (s.includes('客胜')) return 'L';
  if (s.includes('平')) return 'D';
  return '—';      // 信号矛盾 / 信号偏弱 / 信号不足 等观望状态一律不出方向
}
function blankModel(){
  return { total:{hit:0,total:0},
           signals:{flow:{hit:0,total:0},pan:{hit:0,total:0},kb:{hit:0,total:0},he:{hit:0,total:0},combined:{hit:0,total:0}},
           leagues:{} };
}
/* 合并两个纠错模型（逐桶累加 hit/total）。用于把"服务端种子 corr_seed"与"本地 localStorage 学习"叠乘，
   使系统跨用户/设备长记性：种子提供先验，本地学习在其上累加。 */
function mergeCorr(base, extra){
  const out = blankModel();
  for (const m of [base, extra]){
    if (!m) continue;
    if (m.total){ out.total.hit += m.total.hit||0; out.total.total += m.total.total||0; }
    for (const k in out.signals){
      if (m.signals && m.signals[k]){ out.signals[k].hit += m.signals[k].hit||0; out.signals[k].total += m.signals[k].total||0; }
    }
    if (m.leagues) for (const lg in m.leagues){
      out.leagues[lg] = out.leagues[lg] || {W:{hit:0,total:0},D:{hit:0,total:0},L:{hit:0,total:0}};
      for (const d of ['W','D','L']){ if (m.leagues[lg][d]){ out.leagues[lg][d].hit += m.leagues[lg][d].hit||0; out.leagues[lg][d].total += m.leagues[lg][d].total||0; } }
    }
  }
  return out;
}
function updateModel(model, pred, actual){
  if (!model) model=blankModel();
  if (actual==null) return model;
  const hit = (pred.dir===actual);
  model.total.total++; if (hit) model.total.hit++;
  for (const k of ['flow','pan','kb','he','combined']){
    const sv = pred.signals && pred.signals[k];
    if (!sv || sv==='—') continue;
    model.signals[k]=model.signals[k]||{hit:0,total:0};
    model.signals[k].total++; if (sv===actual) model.signals[k].hit++;
  }
  const lg = pred.league || '—';
  model.leagues[lg]=model.leagues[lg]||{W:{hit:0,total:0},D:{hit:0,total:0},L:{hit:0,total:0}};
  if (model.leagues[lg][pred.dir]){ model.leagues[lg][pred.dir].total++; if (hit) model.leagues[lg][pred.dir].hit++; }
  return model;
}
function rate(m){ return (m && m.total>0) ? m.hit/m.total : null; }
function biasNotes(model){
  if (!model || !model.total || model.total.total<5) return '样本不足（需≥5场已完赛复盘）';
  const out=[];
  const t=rate(model.total);
  out.push(`综合命中 ${(t*100).toFixed(0)}%（${model.total.hit}/${model.total.total}）`);
  for (const k of ['flow','pan','kb','he','combined']){
    const r=rate(model.signals[k]);
    if (r!=null) out.push(`${ {flow:'资金流向',pan:'盘水信号',kb:'盘型',he:'贺式',combined:'综合'}[k] } ${(r*100).toFixed(0)}%`);
  }
  // 找偏差最大的联赛
  let worst=null;
  for (const lg in model.leagues){
    const o=model.leagues[lg]; const tot=o.W.total+o.D.total+o.L.total;
    if (tot>=3){ const acc=(o.W.hit+o.D.hit+o.L.hit)/tot; if (!worst||acc<worst.acc) worst={lg,acc,tot}; }
  }
  if (worst) out.push(`偏差最大：${worst.lg} 命中${(worst.acc*100).toFixed(0)}%`);
  return out.join(' ｜ ');
}
// 用纠偏模型调整新分析的置信度/价值分：
// ① 全局综合命中阻尼（保留原逻辑，样本足才生效）；
// ② 信号级可靠性：本次命中的信号(flow/pan/kb/he)若历史命中率偏低，再压置信——系统学会"不信"长期失准的信号；
// ③ 联赛级方向偏差：本联赛该方向历史命中率过低→压置信，过高→微提——系统学会"避开"长期失准的联赛方向。
// 仅做置信/价值校准 + 标注，绝不翻转已校准的基准方向（避免回归）。样本<10 不调，防小样本乱改。
function applyCorrection(a, league, model){
  if (!model || !model.total || model.total.total<10) return a;
  const na = Object.assign({}, a);
  // ① 全局综合命中阻尼
  const comb = rate(model.signals.combined);
  let factor = 1.0;
  if (comb!=null) factor = 0.78 + 0.22*Math.max(0.3, Math.min(1, comb)); // 0.78~1.0
  // ② 信号级可靠性
  const sigMap = { flow: model.signals.flow, pan: model.signals.pan, kb: model.signals.kb, he: model.signals.he };
  const fired  = { flow: a.s_flow, pan: a.s_pan, kb: a.s_pan_kb, he: a.s_he };
  let sigAdj = 1.0; const notes = [];
  for (const k in fired){
    const d = fired[k];
    if (d && d!=='—' && sigMap[k] && sigMap[k].total>=8){
      const r = rate(sigMap[k]);
      if (r!=null){
        if (r < 0.42){ sigAdj *= 0.85; notes.push(`信号${ {flow:'资金',pan:'盘水',kb:'盘型',he:'贺'}[k] }偏弱(${(r*100).toFixed(0)}%)`); }
        else if (r > 0.55){ sigAdj *= 1.05; }
      }
    }
  }
  // ③ 联赛级方向偏差（用归一化 dirCode，tier2 的展示串也能正确比对）
  let lgAdj = 1.0;
  const dirCode = (a.dirCode==='W'||a.dirCode==='L') ? a.dirCode
                : (typeof a.dir==='string' && a.dir.indexOf('主胜')>=0) ? 'W'
                : (typeof a.dir==='string' && a.dir.indexOf('客胜')>=0) ? 'L' : null;
  const lg = league && model.leagues[league];
  if (lg && dirCode && lg[dirCode] && lg[dirCode].total>=5){
    const lr = lg[dirCode].hit / lg[dirCode].total;
    if (lr < 0.40){ lgAdj = 0.80; notes.push(`联赛${league}该方向偏弱(${(lr*100).toFixed(0)}%)`); }
    else if (lr > 0.62){ lgAdj = 1.06; }
  }
  const f = factor * sigAdj * lgAdj;
  na.conf = Math.max(0, Math.min(100, (a.conf||0) * f));
  na.value_score = Math.max(0, Math.min(100, (a.value_score||0) * (0.85+0.15*f)));
  na.corr_factor = +f.toFixed(2);
  if (notes.length) na.corr_note = notes.join('；');
  return na;
}

/* ---------- 比分概率模型（Dixon-Coles）----------
   PPI 真实公式 = 投注占比 × 赔率；本源站(oddshistorypc)只给盘口，无投注占比，
   故 比分 与 热度 均以「欧赔隐含概率 + 大小球盘口」推导，给出概率分布而非单点结论。
   设计要点（庄家视角）：
   - 总进球期望 T 取大小球临/初盘口（初0.3+临0.7），并用大小球冷热轻微修正；
   - 1X2 隐含概率(初或临欧赔)经 _prob 取回；用 T 与 1X2 三概率做最小二乘拟合 λ/μ；
   - 低比分依赖参数 ρ<0：实际抬高 0-0 与 1-1（dcTau(0,0)=1-λμρ>1、dcTau(1,1)=1-ρ>1），
     压低 1-0/0-1（1+μρ、1+λρ 均<1）。故 |ρ| 越大越会把众数推向 1-1，须标定。 */
const _FACT = [1,1,2,6,24,120,720,5040,40320,362880,3628800,39916800,479001600];
function fact(k){ return _FACT[k] != null ? _FACT[k] : (function f(n){ return n<=1?1:n*f(n-1); })(k); }
function pois(k, l){ return Math.exp(-l) * Math.pow(l, k) / fact(k); }
/* DC 低比分依赖参数 ρ（2026-09-15 在 4128 场真实完场上重新标定）
   原 -0.12：模型自称 top1 概率 14.01% 但实际只命中 12.77%（过度自信），
   且 dcTau(1,1)=1-ρ=1.12 会把 1-1 抬高 12%，机械地把众数锁死在 1-1（实测 60.5% 场次众数=1-1）。
   经 ρ 扫描(-0.12→0)发现：ρ 只改变低比分"内部形状"(0-0 vs 1-1 vs 2-0 的此消彼长)，
   但不改变"低比分整体占比"——7 个用户点名比分的模型占比恒为 ~54.3%，与 ρ 无关。
   而 ρ=0 在全部关键指标上最优或持平：top1 命中 13.20%→13.47%、top1 校准差 0.71pp→0.24pp、
   1X2 校准差(W/D/L) 2.94/3.62/0.68pp→2.53/2.69/0.17pp、1-1 众数占比 43.7%→34.1%。
   故最终取 ρ=0（即独立泊松，关闭 DC 低比分相关性修正）。
   剩余 +5.6pp 低分偏倚来自泊松"欠离散"(模型低估 6+ 与 2-2/4-0/5-0)，需负二项等过离散建模，另行处理。 */
const DC_RHO = 0;

/* 总进球分布经验校准(过离散 / 尾部膨胀) —— 2026-09-15 在 3731 场真实完场上标定
   泊松模型对总球数 g 欠离散：模型高估 g=0/1(0-0 高估 27%)、低估 g>=3。
   逐 g 估计经验校正因子 φ(g)=F_real(g)/P_model(g)（raw 列见 overdisp_fix.cjs），β=1 全量采用。
   修正：Q[i][j]=φ(min(i+j,6))·P_model[i][j] 再归一化。
   全样本(4128)实测：低分7占比 54.3%→48.7%(=现实)、top1 命中 13.47%→16.30%、
   1X2校准差(W/D/L) 2.53/2.70/0.17pp→1.43/0.85/0.58pp、总进球Brier 0.7764→0.7726。
   唯一"代价"：比分#1 的显示概率变为偏弱(实际 16.3% > 显示 12.5%)，属安全方向的低估，
   不影响投注相关的胜平负/总进球(二者反而更准)。可经 opts.tail=false 关闭回退。 */
const TAIL_PHI = [0.731, 0.866, 0.938, 1.094, 1.188, 1.213, 0.995];  // 索引 = min(g,6)，g=0..6+

/* 比分概率锐化系数 γ(过离散修正后的"概率重标定", 2026-09-15 在 4128 场真实完场标定)
   基线 γ=1 时比分#1 显示概率 ~12.9% 但实测命中 ~16.3%(欠自信, 显示差 -3.3pp)。
   γ 锐化: dmat=mat^γ/Σ 提升峰值、不改排序, 仅作用于"比分展示"(top/most),
   而 1X2/总进球仍取自未锐化的 mat(见 5c)——故修复比分显示对胜平负/总进球零代价。
   全样本扫描: γ=1.3 显示差 -0.53pp、γ=1.35 ≈ -0.07pp、γ=1.4 +0.39pp; 1X2(W/D/L)=1.43/0.86/0.58pp
   与总进球 Brier=0.7725 对所有 γ 完全不变, top1 命中率 16.28% 恒定(排序不变)。
   默认取 γ=1.35(显示差≈0, 落在校准门 <0.35pp 内), 可 opts.gamma 覆盖(1=回退到纯过离散修正)。 */
const RECALIB_GAMMA = 1.35;

/* 让球盘口「临场-初盘」移动量对主客比例的调节系数（2026-09-15 联合标定）
   覆盖 38% 场次（有盘口移动）。实测 mv=0.3：top5 +0.94pp、top3 +0.23pp、top1 -0.06pp(噪声)，
   且自称概率与实际命中差仅 0.23pp（仍校准）。零成本（无额外数据/体积），故默认启用。
   注意：试图用 Tmv>0 顺着盘口变动外推总进球，会让 top3/top5 虚高但自称概率虚高更多
   （Tmv=0.5 时自称 15.25% vs 实际 12.48%，差 2.77pp）——属「摊平分布」假象，已否决。 */
const MV_SPLIT = 0.3;

/* ---- 由大小球盘口 + 赔率反推「真实总进球期望 T」----
   盘口线只是「大/小各 50%」的中位分界，不等于均值。
   例：2.5 公平盘 => P(总球>2.5)=0.5 => 反解泊松均值≈2.67（而非 2.5）。
   直接用盘口线当均值会系统性低估总进球，使分布整体左移、1-1 被过度强化为众数。 */
function _poisAbove(m, line){
  const k = Math.floor(line);            // > line 的最小整数球数
  let s = 0;
  for (let x = 0; x <= k; x++) s += pois(x, m);
  return Math.max(0, Math.min(1, 1 - s));
}
function _impliedTotal(line, pOver){
  let lo = 0.2, hi = 9;
  for (let i = 0; i < 60; i++){
    const mid = (lo + hi) / 2;
    if (_poisAbove(mid, line) < pOver) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function _ouProb(ow, uw){                // 大小球两边水位 -> 去水后的 P(Over)
  if (!ow || !uw || ow <= 0 || uw <= 0) return null;
  const io = 1/ow, iu = 1/uw, p = io/(io+iu);
  return (p > 0.02 && p < 0.98) ? p : null;
}
/* 让球盘口 -> 预期净胜球 GD = λ-μ（c_hcap>0 主队让球=主队更强；实测 GD≈c_hcap） */
/* 半全场校准：上半场进球占比 wf（下半场为 1-wf）。
   真实赛事下半场进球通常多于上半场（疲劳/换人/拉开空间），wf<0.5。
   默认 0.45 为经验值（文献约 43-47%），可由历史“半场比分”数据拟合后覆盖。
   保证 上+下 期望 = λ/μ，全场分布与 predictScore 一致。 */
const HT_WF = 0.45;
/* ⚠ 总进球期望偏差补偿（2026-10-01 由 7m 独立真值标定，见 _eval/_7m_lmu.cjs）
   原理：λ+μ 直接取自大小球临场线 T，而庄家开的 OU 线天然低于真实期望（含水位的公平线），
   两者实测差 0.257 球（n=5873 带盘口完场：引擎均值 2.883 → 真实 3.140）。
   故在 T 上加本常数，使总进球期望对齐真值；校准后 bias≈0、分箱「实际>预测」比例趋近 50%。
   ⚠ 这条补偿只修「绝对水平」，不修主客拆分（拆分由让球盘 GD 决定，实测已无系统偏差）。 */
const LMU_T_BIAS = 0.26;
/* 半全场耦合修正：
   (1) HT_COUPLE_W — 真实转移矩阵 P(FT|HT) 的混合权重(0=纯独立假设,1=纯实证)。
   (2) HT_HOME_LEAN — 主客比的主队修正(exp 系数)，仅作用于 HT/FT 模块、不碰主模型。
   ─── 2026-10-01 撤销耦合（HT_COUPLE_W 0.90 → 0）─────────────────────────────
   用 7m 34153 场独立真值做跨源验证（765 场配对、2 折交叉验证一致）：
     coupleW=0     Top3=67.5%  logLoss=1.803  （两折 logLoss 1.8026 / 1.8034，都是所有权重里最低）
     coupleW=0.25  Top3=67.1%  logLoss=1.808
     coupleW=0.5   Top3=67.1%  logLoss=1.819
     coupleW=0.9   Top3=63.8%  logLoss=1.849
     coupleW=1.0   Top3=62.9%  logLoss=1.860
   logLoss 随权重**单调恶化** ⇒ 纯 Poisson 上下半场卷积本身已经够好，经验矩阵只会加噪声。
   机理：经验矩阵 P(FT|半场) 是**无条件**的（不控制 λ/μ），对强弱悬殊的对局会系统性低估强队；
   而独立卷积用的是「这场自己的」λ/μ，信息更贴切。耦合越高越退化为「抄市场频率」。
   结论：赛前预测不走经验耦合（w=0）；经验矩阵保留在 HT_EMP_FT_GIVEN_HT / opts.empMat，
         供将来「已开赛、半场比分已知」的 live 场景用（那时 lead 分档矩阵才真正精确）。 */
const HT_COUPLE_W = 0;
const HT_HOME_LEAN = 0.10;
/* 实证 P(FT|HT) 转移矩阵（212 场，行=半场结果，列=全场结果，已轻微平滑） */
// 经验转移矩阵 P(FT|HT) —— 2026-09-28 用 3354 场真实半场+全场重算（替代旧手写值）。
// 关键修正：D→D 0.263→0.309（半平守平增多）、D→A 0.382→0.308（半平被客逆转减少）、
// H→D/H→A 微调；直接治 AA 低估(旧15%→实19%)、DA 高估。
const HT_EMP_FT_GIVEN_HT = {
  H: { H: 0.798, D: 0.142, A: 0.059 },
  D: { H: 0.383, D: 0.309, A: 0.308 },
  A: { H: 0.075, D: 0.166, A: 0.759 }
};
function dcTau(i,j,lam,mu,rho){
  if (i===0 && j===0) return 1 - lam*mu*rho;
  if (i===0 && j===1) return 1 + lam*rho;
  if (i===1 && j===0) return 1 + mu*rho;
  if (i===1 && j===1) return 1 - rho;
  return 1;
}
function _scoreWL(lam, mu, rho, cap){
  cap = cap || 12;
  let W=0,D=0,L=0;
  for (let i=0;i<=cap;i++) for (let j=0;j<=cap;j++){
    const p = dcTau(i,j,lam,mu,rho) * pois(i,lam) * pois(j,mu);
    if (i>j) W+=p; else if (i<j) L+=p; else D+=p;
  }
  return {W,D,L};
}
/* ---------- 球队历史攻防强度先验（让比分模型脱离「纯抄市场」）----------
   team_ratings.json 由 fit_team_ratings.cjs 产出的 Dixon-Coles 攻击/防守参数。
   用法：analyze 用主客队名查表 → 算「队史预期进球」λ0/μ0，作为 λ/μ 拆分的独立先验。
   权重自适应：队史强度与市场看法一致→几乎不动；分歧大→最多拉 0.3
   （这正是「市场定错价」的独立 edge）。T(总进球)仍锚定大小球盘口，不被动。 */
let _TEAM_RATINGS = null;
function _loadTeamRatings(){
  if (_TEAM_RATINGS !== null) return _TEAM_RATINGS;
  let tr = { teams:{}, baseC:0, hfa:0 };
  try {
    if (typeof window !== 'undefined' && window.TEAM_RATINGS) tr = window.TEAM_RATINGS;
    else if (typeof require !== 'undefined') { try { tr = require('./team_ratings.json'); } catch(e){} }
  } catch(e){}
  const teams = tr.teams || {};
  // 统一用 decodeName（PUA 字体反混淆）把脏队名还原为准确中文名做查找键。
  // 零撞车（实测 11346 个脏 key 全部唯一）；新旧文件(脏/已重建)皆兼容：
  //   新干净文件 decodeName(k)=k；旧脏文件 decodeName(k)=准确名。入参名同样 decode 后查。
  const cleanMap = new Map();
  for (const k in teams){ const d = decodeName(k) || k; if (!cleanMap.has(d)) cleanMap.set(d, k); }
  _TEAM_RATINGS = { teams, cleanMap, baseC:(typeof tr.baseC==='number'?tr.baseC:0), hfa:(typeof tr.hfa==='number'?tr.hfa:0) };
  return _TEAM_RATINGS;
}
/* 查强度库: 入参队名先 decodeName 还原为准确中文名, 再查 cleanMap。
   解决了此前 _stripTeam 删掉真实汉字导致强度先验长期错配/失效的根因。 */
function _ratingKey(name){
  if (name == null) return null;
  const tr = _loadTeamRatings();
  const d = decodeName(name) || name;
  return d ? (tr.cleanMap.get(d) || null) : null;
}
function _stripTeam(s){
  return String(s==null?'':s).replace(/<[^>]+>/g,'').replace(/&#x?[0-9A-Fa-f]+;/g,'')
    .replace(/[（）()]/g,'').replace(/足球俱乐部/g,'').replace(/\s/g,'').trim();
}
/* ⚡ 性能：这两个先验只依赖 (home,away)，却在每次卡片重建时被调用。
   1669 场 × 每次 refreshRendered 重建 60 张卡 → 单次采样里合计吃掉 13.4% 主线程。
   结果只缓存命中值（null 便宜且可随数据后到而改变，不缓存），上限 8000 条防泄漏。 */
const _TP_CACHE = new Map(), _TF_CACHE = new Map();
function teamPriorOpts(home, away){
  const ck = String(home) + '\u0001' + String(away);
  const hit = _TP_CACHE.get(ck); if (hit !== undefined) return hit;
  const v = _teamPriorOptsRaw(home, away);
  if (v && _TP_CACHE.size < 8000) _TP_CACHE.set(ck, v);
  return v;
}
function _teamPriorOptsRaw(home, away){
  const tr = _loadTeamRatings();
  if (!tr || !tr.teams || !Object.keys(tr.teams).length) return null;
  const kh = _ratingKey(home), ka = _ratingKey(away);
  if (!kh || !ka) return null;
  const th = tr.teams[kh], ta = tr.teams[ka];
  if (!th || !ta) return null;
  /* ⚠ 2026-10-01 真值标定（_eval/_7m_lmu.cjs，5873 场带盘口完场 × 34153 场 7m 独立真值）：
     引擎 λ/μ 系统性低估——引擎均值 主 1.568/客 1.315/总 2.883，真实 主 1.714/客 1.426/总 3.140。
     根因：强度表的基准进球率 baseC 从未用真实完场校准，低了 log 空间的 LMU_BASE_BIAS。
     标定方式：Δ = ½·ln(真实总期望 / 引擎总期望)，对 λ/μ 同乘 e^Δ → 总进球均值对齐。
     校准后总进球 bias −0.257→≈0、分箱「实际>预测」比例趋近 50%。 */
  /* ⚠ 2026-10-01：此处是「强度先验」分支（opts.prior），最终会被 predictScore 的 T 重新拉回 λ+μ=T，
     所以总进球偏差的标定补偿不在这里，而在 predictScore 的 T 上（见 LMU_T_BIAS）。
     强度先验在本分支只提供主客「比例」log(λ/μ)。 */
  const lam0 = Math.exp(tr.baseC + tr.hfa + (th.a||0) - (ta.d||0));
  const mu0  = Math.exp(tr.baseC + (ta.a||0) - (th.d||0));
  if (!(lam0>0.05) || !(mu0>0.05) || !(lam0<8) || !(mu0<8)) return null;
  return { lambda:+lam0.toFixed(3), mu:+mu0.toFixed(3) };
}

/* ---------- 近期战绩先验（让比分模型抓「当前状态」而非只看赛季平滑）----------
   team_ratings.json 是 Dixon-Coles 赛季级平滑强度, 对伤停/换帅/状态起伏反应慢;
   history.json 真实赛果的「近 N 场得失球」能补这一层短期动量。
   聚合: 每队分别记主场(hgf/hga)/客场(agf/aga)近 N 场(加权近期), 用联赛均值 Laplace 平滑。
   一场对阵的形式预期进球: λf = 主队主场场均进球, μf = 客队客场场均失球。
   与赛季强度在 strengthPriorOpts 里 log 空间融合, 战绩样本越多权重越高(封顶 0.45)。 */
let _TEAM_FORM = null, _TF_EMPTY_AT = 0;
function _loadTeamForm(){
  /* ⚠ 2026-10-03：team_form.js 改成 gzip 异步包（async script，晚于首屏解析到位）。
     team_ratings 那两个包当初就踩过同一个坑：一次性缓存一旦锁成空库，整段先验静默失效。
     所以这里只在「真正拿到有效内容」时才缓存；空库 1s 内不重复重建（1.6w 队名解码很贵），
     超过 1s 再试一次 —— 异步包落地后自动复活，不需要任何外层 await。 */
  if (_TEAM_FORM && _TEAM_FORM.teams && Object.keys(_TEAM_FORM.teams).length) return _TEAM_FORM;
  if (_TEAM_FORM){
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : (Date.now());
    if (now - _TF_EMPTY_AT < 1000) return _TEAM_FORM;
  }
  let tf = { teams:{}, norm:{} };
  try {
    if (typeof window !== 'undefined' && window.TEAM_FORM) tf = window.TEAM_FORM;
    else if (typeof require !== 'undefined') { try { tf = require('./team_form.json'); } catch(e){} }
  } catch(e){}
  const teams = (tf && tf.teams && Object.keys(tf.teams).length) ? tf.teams : (tf || {});  // team_form.json 扁平结构
  /* ⚠ 2026-10-03：norm 同时收录「原样归一化」与「PUA 还原后再归一化」两套键。
     历史库/页面两侧的队名都带 `&#xe9xx;` 混淆，单用一套归一化会有一侧洗成空串 →
     拿空键去查库，命中全是两个空键撞一起的假阳性（实测占 34% 场次）。 */
  const norm = new Map();
  for (const k in teams){
    const n = _stripTeam(k); if (n) norm.set(n, k);
    const nd = _stripTeam(decodeName(k)); if (nd && nd !== n && !norm.has(nd)) norm.set(nd, k);
  }
  _TEAM_FORM = { teams, norm };
  if (!Object.keys(teams).length){
    _TF_EMPTY_AT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  return _TEAM_FORM;
}
/* 查键：优先「PUA 还原后」归一化，回退「原样」归一化（兼容新旧两种库） */
function _tfKey(x){
  const d = _stripTeam(decodeName(x));
  return (d || _stripTeam(x)) || null;
}
const FORM_LIGAVG = 1.35, FORM_SMOOTH = 2;
function _smoothForm(x, n){
  if (x == null || !(x>0)) return FORM_LIGAVG;          // 无样本→回退联赛均值
  const nn = Math.max(0, n||0);
  return (x*nn + FORM_LIGAVG*FORM_SMOOTH) / (nn + FORM_SMOOTH);
}
function teamFormOpts(home, away){
  const ck = String(home) + '\u0001' + String(away);
  const hit = _TF_CACHE.get(ck); if (hit !== undefined) return hit;
  const v = _teamFormOptsRaw(home, away);
  if (v && _TF_CACHE.size < 8000) _TF_CACHE.set(ck, v);
  return v;
}
function _teamFormOptsRaw(home, away){
  const tf = _loadTeamForm();
  if (!tf || !tf.teams || !Object.keys(tf.teams).length) return null;
  const kh = tf.norm.get(_tfKey(home));
  const ka = tf.norm.get(_tfKey(away));
  if (!kh || !ka) return null;
  const th = tf.teams[kh], ta = tf.teams[ka];
  if (!th || !ta) return null;
  const lamF = _smoothForm(th.hgf, th.hn);     // 主队主场场均进球(平滑)
  const muF  = _smoothForm(ta.aga, ta.an);     // 客队客场场均失球(平滑)
  if (!(lamF>0.1) || !(muF>0.1) || !(lamF<6) || !(muF<6)) return null;
  return { lambda:+lamF.toFixed(3), mu:+muF.toFixed(3), hn:(th.hn||0), an:(ta.an||0) };
}
/* 融合「赛季强度(team_ratings)」+「近期战绩(form)」为单一强度先验。
   赛季强度反应慢但稳健; 战绩抓短期动量但有噪声。 log 空间加权, 战绩样本越多权重越高。 */
function strengthPriorOpts(home, away){
  const tr = teamPriorOpts(home, away);
  const fm = teamFormOpts(home, away);
  if (tr && !fm) return Object.assign({}, tr, { src:'season', wForm:0, wTR:1 });
  if (!tr && fm) return Object.assign({}, fm, { src:'form',  wForm:0.45, wTR:0.55 });
  if (!tr && !fm) return null;
  const wForm = Math.max(0.15, Math.min(0.45, ((fm.hn||0)+(fm.an||0))/24)); // 样本↑→战绩权重↑
  const wTR = +(1 - wForm).toFixed(2);
  const ll = wTR*Math.log(tr.lambda) + wForm*Math.log(fm.lambda);
  const lm = wTR*Math.log(tr.mu)     + wForm*Math.log(fm.mu);
  return { lambda:+Math.exp(ll).toFixed(3), mu:+Math.exp(lm).toFixed(3),
           wForm:+wForm.toFixed(2), wTR, src:'blend', trLam:tr.lambda, trMu:tr.mu,
           fmLam:fm.lambda, fmMu:fm.mu, hn:fm.hn, an:fm.an };
}
function predictScore(agg, aggBs, opts){
  opts = opts || {};
  const MAX = opts.maxN || 6;
  const rho = (typeof opts.rho === 'number') ? opts.rho : DC_RHO;   // ρ 可标定/覆盖
  // 1) 总进球期望 T
  //    tMode='implied'(默认·更准)：由盘口线+大小球水位反解泊松均值（2.5 公平盘=>均值≈2.67）
  //    tMode='line'(旧)：直接把盘口线当均值（系统性低估总进球）
  // 注：曾尝试 implied（由大小球水位反解真实均值），但在 3101 场样本上 12/12 组全部劣于 line，故默认仍用 line
  const tMode = opts.tMode || 'line';
  let T = null;
  if (aggBs){
    const lineC = (aggBs.c_line!=null) ? aggBs.c_line : aggBs.o_line;
    const lineO = aggBs.o_line;
    if (tMode === 'implied' && lineC != null){
      const pC = _ouProb(aggBs.c_ow, aggBs.c_uw) || _ouProb(aggBs.o_ow, aggBs.o_uw) || 0.5;
      T = _impliedTotal(lineC, pC);
      if (lineO != null && aggBs.c_line != null){
        const pO = _ouProb(aggBs.o_ow, aggBs.o_uw) || 0.5;
        T = _impliedTotal(lineO, pO) * 0.3 + T * 0.7;   // 与旧口径一致的初/临权重
      }
    } else {
      // T = 临场线 + Tmv×(临场线-初盘线)。Tmv=-0.3 等价于原「0.3×初+0.7×临」；
      // Tmv=0 纯用临场线；Tmv>0 表示顺着盘口变动方向外推（动量假设）。
      const _kmv = (typeof opts.Tmv === 'number') ? opts.Tmv : -0.3;
      if (lineO!=null && aggBs.c_line!=null) T = aggBs.c_line + _kmv*(aggBs.c_line - lineO);
      else if (aggBs.c_line!=null) T = aggBs.c_line;
      else if (lineO!=null) T = lineO;
    }
  }
  if (T==null) T = 2.5;
  T = Math.max(1.0, Math.min(6.5, T));
  T += LMU_T_BIAS;                    // 2026-10-01 真值标定：补掉庄家 OU 线与真实期望的 0.26 球落差
  // 2) 1X2 隐含概率（优先真实临场欧赔）
  let bh=agg.o_h, bd=agg.o_d, ba=agg.o_a;
  if ((agg.eu_valid||0) >= 3 && agg.c_h){ bh=agg.c_h; bd=agg.c_d; ba=agg.c_a; }
  let mk=null;
  try { if (bh && bd && ba) mk = _prob(bh,bd,ba); } catch(e){ mk=null; }
  // 3) 用大小球冷热修正 T
  if (aggBs){
    const [so,od] = classifyOU(aggBs.o_line, aggBs.o_ow, aggBs.o_uw, aggBs.c_line, aggBs.c_ow, aggBs.c_uw);
    if (od==='大球') T += 0.10;
    else if (od==='小球') T -= 0.10;
  T = Math.max(1.0, Math.min(7.6, T));   // 上限同步放宽，补偿 +0.26 后大球尾部不再被截断
  }
  // 4) 拟合 λ/μ：T 约束总数（λ+μ=T），再定主客拆分（λ-μ=GD）
  //    gdMode: 'hcap'（默认，2026-10-03 起）= 让球盘口直接给 GD（λ-μ = c_hcap），更锐利地区分强弱
  //            'x2'   = 旧法：用 1X2 隐含概率最小二乘拟合拆分（趋同、易把众数锁死在 1-1）
  //            'blend' = 两者平均，缺项自动退化
  // 默认切 hcap 的依据（2026-10-03 球探真值 1667 场 A/B，_eval/_xscore.cjs）：
  //    Top1 10.68% vs 9.96% | Top3 28.37% vs 27.47% | Top5 43.55% vs 40.31%
  //    λ-μ 区分度 IQR 0.97 vs 0.41 | 比分反推 1X2 命中 53.15% vs 50.75%
  //    McNemar 配对检验：x2 中而 hcap 不中 65 场，hcap 中而 x2 不中 119 场 → z=3.91, p<0.0001
  // 当年用 n=229 拒绝 hcap（Δtop1 0.00 / Δtop3 -1.75）系样本过小，已被上述 1667 场推翻。
  // 兜底安全：无让球盘口时 lamH=null，自动落到 lamX2 分支（收敛回旧解），不会退化成常量。
  const gdMode = opts.gdMode || 'hcap';
  let lam, mu, fit_sse=null;
  // A) 1X2 拟合拆分
  let lamX2=null, muX2=null;
  if (mk){
    let best={sse:1e9, lam:1.3, mu:1.1};
    for (let l=0.1; l<=T-0.05; l+=0.02){
      const m=T-l;
      if (m<0.05) continue;
      const p=_scoreWL(l,m,rho,14);
      const sse=(p.W-mk[0])**2 + (p.D-mk[1])**2 + (p.L-mk[2])**2;
      if (sse<best.sse){ best={sse, lam:l, mu:m}; }
    }
    lamX2=best.lam; muX2=best.mu; fit_sse=+best.sse.toFixed(4);
  }
  // B) 让球盘口拆分：λ-μ = GD ≈ c_hcap
  let lamH=null, muH=null;
  const _hc = (agg && agg.c_hcap!=null) ? agg.c_hcap : ((agg && agg.o_hcap!=null) ? agg.o_hcap : null);
  if (gdMode!=='x2' && _hc!=null && Number.isFinite(_hc)){
    let gd = Number(_hc);
    if (Math.abs(gd) > 0 && Math.abs(gd) <= 0.5) gd *= 1.15;   // 小让球处真实 GD 略被低估
    gd = Math.max(-(T-0.1), Math.min(T-0.1, gd));              // 保证 λ,μ>0
    lamH = (T + gd)/2; muH = (T - gd)/2;
  }
  if      (gdMode==='hcap' && lamH!=null){ lam=lamH; mu=muH; }
  else if (gdMode==='x2'   && lamX2!=null){ lam=lamX2; mu=muX2; }
  else if (lamH!=null && lamX2!=null){ lam=(lamH+lamX2)/2; mu=(muH+muX2)/2; }
  else if (lamH!=null){ lam=lamH; mu=muH; }
  else if (lamX2!=null){ lam=lamX2; mu=muX2; }
  else { lam=T*0.55; mu=T*0.45; }        // 无欧赔也无让球：主队微弱优势
  // 4b) 强度先验融合（赛季强度 team_ratings 与 近期战绩 form 已在 strengthPriorOpts 里融合成单一先验）
  //     只融合主客「比例」log(λ/μ)，并把 λ+μ 重新拉回 T——
  //     因为标定已证明大小球盘口对总进球的判断更准，不应让先验污染它。
  //     权重自适应：先验强度比 vs 市场拟合比 的分歧越大，拉得越多（封顶 0.3）；
  //     分歧小→不拉动（避免给已校准基线加噪声）。
  // ⚠ 2026-10-03 修正：早先注释称这里是「脱离纯抄市场的独立信号」，实测（_eval/_xhtopt.cjs，
  //    1525 场球探真盘口）**不成立**：注入强度 w 0→0.3（prior 比例 = 市场比例·e^δ，δ=±0.15/±0.4/±0.8）
  //    九态Top1 只在 32.00~33.11% 之间抖、半场方向 43.4~45.4%，且**非单调**（δ=−0.4 反而最高）——纯噪声。
  //    根因：prior 本身只是把市场 ratio 再往市场 ratio 附近拉（_xprior.cjs：corr(λ−μ, log市场主/客)=0.9564）。
  //    保留机制仅因“不伤性能”（w=0 与 w=0.3 输出差 <1pp），但**别再把它当 alpha 来源**；
  //    UI 展示 priorW/priorSrc 时必须配此说明，否则等于给用户看一个不影响结论的假信号。
  let priorWUsed = 0, priorSrc = 'none', formWUsed = 0, ppiWUsed = 0;
  if (opts.prior && opts.prior.lambda > 0.02 && opts.prior.mu > 0.02){
    const l0 = +opts.prior.lambda, m0 = +opts.prior.mu;
    priorSrc = opts.prior.src || 'prior';
    formWUsed = +(opts.prior.wForm || 0);
    let w = (typeof opts.priorW === 'number') ? opts.priorW : 0;
    if (opts.priorW == null){
      const drift = Math.log((l0/m0) / (lam/mu));   // >0：先验认为主更强(相对市场)
      w = Math.max(0, Math.min(0.3, Math.abs(drift) * 0.6));
    }
    if (w > 0){
      const lr = (1-w)*Math.log(lam/mu) + w*Math.log(l0/m0);
      const ratio = Math.exp(lr);
      lam = T * ratio/(1+ratio);
      mu  = T/(1+ratio);
      priorWUsed = +w.toFixed(3);
    }
  }
  // 4b2) 庄家盈亏(PPI) 轻推：必发真实资金占比 vs 共识(avg99)背离 → 聪明钱方向。
  //      仅当存在真实占比背离时拉动(否则市场已含此信息, 拉动=重复)。weight 封顶 0.12。
  //     语义: ppiLean>0 表示真实资金比共识更看好主队 → 轻度拉主; 反之拉客。
  const PPI_W = 0.12;
  if (typeof opts.ppiLean === 'number' && opts.ppiLean !== 0){
    const ww = Math.max(-PPI_W, Math.min(PPI_W, opts.ppiLean * PPI_W));
    const _r = Math.exp(Math.log(lam/mu) + ww);
    lam = T * _r/(1+_r); mu = T/(1+_r);
    ppiWUsed = +Math.abs(ww).toFixed(3);
  }
  // 4b3) 战意(motivation) 已移除（2026-10-26）：动机信号不可靠、易误导，不再纳入比分模型。

  // 4c) 临场赔率变动（庄家资金流向）信号：让球盘口移动量 -> 微调主客比例（保持 λ+μ=T）
  //     dH = 临场让球 - 初盘让球，>0 表示盘口向主队移动（资金流向主队）。
  const _mv = (typeof opts.mvSplit === 'number') ? opts.mvSplit : MV_SPLIT;
  if (_mv){
    const _ch = (agg && agg.c_hcap != null) ? Number(agg.c_hcap) : null;
    const _oh = (agg && agg.o_hcap != null) ? Number(agg.o_hcap) : null;
    const dH = (_ch!=null && _oh!=null && Number.isFinite(_ch) && Number.isFinite(_oh)) ? (_ch - _oh) : 0;
    if (dH){
      const _r = Math.exp(Math.log(lam/mu) + _mv * dH);
      lam = T * _r/(1+_r); mu = T/(1+_r);
    }
  }
  lam=Math.max(0.15, Math.min(5, lam));
  mu =Math.max(0.15, Math.min(5, mu));
  // 5) 完整比分矩阵（宽 CAP 保证 1X2/总进球精确；展示只取 0..MAX + 单一"其他"尾桶）
  const CAP = 12;
  const mat = [];
  for (let i=0;i<=CAP;i++){ mat[i]=[]; for (let j=0;j<=CAP;j++) mat[i][j] = dcTau(i,j,lam,mu,rho)*pois(i,lam)*pois(j,mu); }
  // 5b) 总进球分布经验校准(过离散修正)：按总球数 g 缩放并归一化（默认开启）
  if (opts.tail !== false){
    let _ts = 0;
    for (let i=0;i<=CAP;i++) for (let j=0;j<=CAP;j++){
      const g = (i+j>=6) ? 6 : (i+j);
      mat[i][j] *= TAIL_PHI[g];
      _ts += mat[i][j];
    }
    for (let i=0;i<=CAP;i++) for (let j=0;j<=CAP;j++) mat[i][j] /= _ts;
  }
  // 5c) 比分概率锐化(概率重标定, 2026-09-15 标定): 仅作用于"比分展示", 不动 1X2/总进球边际。
  //     解决"比分#1 显示概率偏弱"(基线 γ=1 时 显示~12.8% vs 实际命中~16.1%, 欠自信)。
  //     γ>1 提升峰值、不改排序; 全样本标定 γ=1.3 时 显示≈命中(校准差<0.35pp, 落在校准门内)。
  //     关键设计: 1X2/总进球从"只过离散、未锐化"的 mat 取(= 当前已标定的最优边际, 不回退),
  //     锐化只作用在"展示副本"dmat 上, 故修复比分显示对胜平负/总进球是零代价。
  //     可 opts.gamma 覆盖(1=回退到纯过离散修正)。默认 RECALIB_GAMMA。
  const _gamma = (typeof opts.gamma === 'number') ? opts.gamma : RECALIB_GAMMA;
  // 先由"未锐化"的 mat 算精确的 1X2 与总进球(保持已标定的最优边际校准)
  let W=0,D=0,L=0; const tot={};
  for (let i=0;i<=CAP;i++) for (let j=0;j<=CAP;j++){
    const p=mat[i][j];
    if (i>j) W+=p; else if (i<j) L+=p; else D+=p;
    const t=i+j; const key = t>=6 ? '6+' : String(t);
    tot[key]=(tot[key]||0)+p;
  }
  // 锐化副本(仅用于比分展示)
  const dmat = (_gamma===1) ? mat : (function(){ let s=0; const m=[];
    for (let i=0;i<=CAP;i++){ m[i]=[]; for (let j=0;j<=CAP;j++){ m[i][j]=Math.pow(mat[i][j],_gamma); s+=m[i][j]; } }
    for (let i=0;i<=CAP;i++) for (let j=0;j<=CAP;j++) m[i][j]/=s;
    return m; })();
  // 展示：0..MAX 比分分布 + 尾桶"其他(6+球)"，整体归一化到 100%
  const exact=[]; let exactSum=0;
  for (let i=0;i<=MAX;i++) for (let j=0;j<=MAX;j++){ exact.push({i,j,p:dmat[i][j]}); exactSum+=dmat[i][j]; }
  const tail = Math.max(0, 1 - exactSum);
  const grid = exact.map(g=>({ score:`${g.i}-${g.j}`, i:g.i, j:g.j, p: g.p }));
  grid.push({ score:'其他', i:MAX+1, j:MAX+1, p: tail });   // 6+ 球等极端比分合并
  grid.sort((a,b)=>b.p-a.p);
  const top = grid.slice(0,8).map(d=>({ score:d.score, p:+ (d.p*100).toFixed(1) }));
  // 众数取真实比分（排除"其他"尾桶）
  let mostScore = '其他', bestP=-1;
  for (const g of exact){ if (g.p>bestP){ bestP=g.p; mostScore=`${g.i}-${g.j}`; } }
  const pTotal = {};
  for (let t=0;t<6;t++) pTotal[String(t)] = +((tot[String(t)]||0)*100).toFixed(1);
  pTotal['6+'] = +((tot['6+']||0)*100).toFixed(1);
  // 进球数盘口方向：模型 P(Over line) vs 盘口（DC 低比分修正会改变大球概率，是跨市场分歧来源）
  /* ⚠ 2026-10-03 四改：pTotal 的「众数档」经 1525 场球探真盘口+真比分实测（_eval/_xdist.cjs），
     命中总进球众数档 21.44%，而真值里众数本身（绝大多数场次就是 2 球）占 21.44% ——
     差 **+0.00pp**，即模型在"总进球第一档"上**完全打不过永远猜 2 球**，没有任何 alpha。
     同批对照：总进球Top3 +2.75pp / 半场方向 +5.57pp / 九态Top1 +4.59pp / 九态Top3 +2.82pp，
     而【比分矩阵反推的 1X2 方向 53.70% vs 基线 44.46% = +9.25pp】是真且唯一的 alpha。
     ⇒ pTotal 众数档只可当分布展示，别当可下注结论（它只是复述先验）；
       可下注的只有方向(1X2) 和已门控的大小球(overProb→OU_OVER_MIN)。 */
  let overProb=null, underProb=null, line=null;
  if (aggBs){
    line = (aggBs.c_line!=null) ? aggBs.c_line : (aggBs.o_line!=null ? aggBs.o_line : null);
    if (line!=null){
      let ov=0;
      for (let t=0;t<6;t++){ if (t>line) ov += pTotal[String(t)]||0; }
      if (line<6) ov += pTotal['6+']||0;     // 6+ 永远大于 line(<6)
      overProb = +ov.toFixed(1); underProb = +(100-ov).toFixed(1);
    }
  }
  const consistency = +(lam+mu).toFixed(3);   // DC 不改变边际均值，应≈T
  return {
    lambda:+lam.toFixed(2), mu:+mu.toFixed(2), rho:+rho.toFixed(3),
    T:+T.toFixed(2),
    top,                               // 概率最高的若干个比分（仅作分布展示，含"其他"尾桶）
    p1x2:{ W:+(W*100).toFixed(1), D:+(D*100).toFixed(1), L:+(L*100).toFixed(1) },
    pTotal,                            // 总进球分布(%)
    overProb, underProb, line,         // 模型对大小球盘口的 P(Over/Under)（%）
    most: mostScore,                   // 众数（真实比分，仅标注不下单点结论）
    consistency, fit_sse,              // 模型均值 vs T（应≈T）；1X2 拟合残差（越小越贴合欧赔）
    priorW: priorWUsed,                // 强度先验实际注入权重(0=未接/与市场一致；>0=分歧拉动)
    priorSrc,                          // 'season'/'form'/'blend'/'none'
    formW: formWUsed,                  // 战绩先验占比(融合权重)
    ppiW: ppiWUsed,                    // 庄家盈亏轻推权重
    note:'概率分布，非定点预测；λ主/μ客为预期进球，ρ 为低比分依赖；融合=赛季强度+近期战绩+庄家盈亏'
  };
}

/* ---------- 半全场(HT/FT)概率模型 ----------
   基于 predictScore 已拟合的主客预期进球 λ/μ，按「独立半场」假设推导：
   - 上半场主/客进球 ~ Poisson(λ/2)/Poisson(μ/2)，下半场同分布且独立；
   - 半场结果 = 上半场比分胜负平；全场结果 = 上下半场比分之和的胜负平；
   - 九态 HT/FT = 上半场结果 × 全场结果 的组合概率。
   说明：独立半场是已知简化（真实足球上下半场并非独立），仅作概率分布展示，不下单点结论。 */
function predictHTFT(agg, aggBs, opts){
  opts = opts || {};
  /* ⚠ 2026-10-03 三改：predictScore 必须**透传 opts**。
     此前写成 predictScore(agg, aggBs)——丢掉 opts.prior（强度先验），
     导致analyze() 里【比分的 λ/μ 带先验】【半全场的 λ/μ 无先验】两套数值，
     而UI 明写"四结论源自同一比分矩阵、内部一致"，实际并不一致（比分为主队 2-1、
     半全场却按 1-1 推的源头就在这里）。透传后两者同源，仍走 hcap 默认拆分。 */
  const sc = predictScore(agg, aggBs, opts);     // 复用 λ/μ/T（同 analyze 的 _scoreOpts）
  const lam = sc.lambda, mu = sc.mu;
  const wf = (typeof opts.wf === 'number') ? opts.wf : HT_WF;   // 上半场占比（可校准覆盖）
  const lean = (typeof opts.lean === 'number') ? opts.lean : HT_HOME_LEAN;  // 主队修正(球), T 不变
  const lam2 = lam + lean, mu2 = Math.max(0.02, mu - lean);                 // 朝主队平移期望值
  const hl1 = Math.max(0.05, lam2*wf),   hm1 = Math.max(0.05, mu2*wf);      // 上半场主/客期望
  // 下半场期望 = 总期望 - 上半场期望，保证 上+下 = lam2/mu2（全场分布与 predictScore 一致）
  const hl2v = Math.max(0.05, lam2 - hl1), hm2v = Math.max(0.05, mu2 - hm1);
  const CAP = 7;                                // 单半场比分上限（下半场均值略高，留足余量）
  function halfMat(l, m){
    const M=[];
    for (let i=0;i<=CAP;i++){ M[i]=[]; for (let j=0;j<=CAP;j++) M[i][j]=pois(i,l)*pois(j,m); }
    return M;
  }
  const ht = halfMat(hl1, hm1);   // 上半场：主 i / 客 j
  const sh = halfMat(hl2v, hm2v); // 下半场：主 s / 客 t（独立、均值更高）
  // 半场结果分布（独立半场，作为半场边际先验）
  let hH=0,hD=0,hA=0, htSum=0;
  for (let i=0;i<=CAP;i++) for (let j=0;j<=CAP;j++){ const p=ht[i][j]; htSum+=p; if(i>j)hH+=p; else if(i<j)hA+=p; else hD+=p; }
  const pHT={ H:hH/htSum*100, D:hD/htSum*100, A:hA/htSum*100 };  // 百分比(和为100)
  /* ⚠ 2026-10-01 三改：独立九态改为「按具体半场比分 (i,j) 精确拆分」（indJ），
     不再先聚合成 H/D/A 三分类。原因：新的经验矩阵按「半场领先幅度 lead」查表，
     必须知道每一格 (i,j) 的 lead；聚合到三分类后就丢掉了幅度信息。 */
  const indJ = {};
  for (let i=0;i<=CAP;i++) for (let j=0;j<=CAP;j++){
    const ph=ht[i][j]; if (ph<=0) continue;
    const key = i+'_'+j; const o = indJ[key] || (indJ[key]={HH:0,HD:0,HA:0,DH:0,DD:0,DA:0,AH:0,AD:0,AA:0,ph:0});
    o.ph += ph;
    for (let s=0;s<=CAP;s++) for (let t=0; t<=CAP; t++){
      const ps=sh[s][t]; if (ps<=0) continue;
      const fh=i+s, fa=j+t; const y = fh>fa?'H':(fh<fa?'A':'D');
      const x = i>j?'H':(i<j?'A':'D');
      o[x+y]+=ph*ps;
    }
  }
  // —— 耦合修正(HT_COUPLE_W)：独立假设把"领先方守住"的强耦合抹平，导致 HH 低估/AA 高估/平局过多 ——
  // 用真实转移矩阵 P(FT|半场) 混合进条件分布，仅重塑"给定半场后的全场分布"，不动半场边际。
  // ⚠ 支持 opts.empMat：按半场领先幅度 lead 分档的经验矩阵（ percentage 存值，}/{100 还原概率）。
  const coupleW = (typeof opts.couple === 'number') ? opts.couple : HT_COUPLE_W;
  const empMat = opts.empMat || null;
  const states={HH:0,HD:0,HA:0,DH:0,DD:0,DA:0,AH:0,AD:0,AA:0};
  for (const key in indJ){
    const o = indJ[key], ph = o.ph; if (ph<=1e-12) continue;
    const pp = ph*100;                       // 该半场比分的概率（百分点）
    const i = +key.split('_')[0], j = +key.split('_')[1];
    const lead = i - j;
    /* ⚠ 关键：半场比分 (i,j) 已唯一决定半场结果 x，因此本格只对 3 个 x+y 态非零。
       曾经误遍历全部 9 态（把 DH/DA/AH… 也算进来）→ 每格 cond 之和变 2.8 → 九态和 280%（严重失真）。*/
    const xr = i>j?'H':(i<j?'A':'D');
    const KL = xr==='H' ? ['HH','HD','HA'] : (xr==='D' ? ['DH','DD','DA'] : ['AH','AD','AA']);
    for (const k of KL){
      const y = k[1];
      const indepCond = o[k]/ph;                                  // 独立假设 P(FT=y|半场=i-j)
      let empCond;
      if (empMat){
        const lk = lead>=3 ? '3' : (lead<=-3 ? '-3' : String(lead));
        const row = empMat[lk];
        empCond = (row && row[y]!=null) ? (row[y]/100) : indepCond;
      } else {
        empCond = (HT_EMP_FT_GIVEN_HT[xr] && HT_EMP_FT_GIVEN_HT[xr][y]!=null) ? HT_EMP_FT_GIVEN_HT[xr][y] : indepCond;
      }
      const cond = (1-coupleW)*indepCond + coupleW*empCond;
      states[k] += pp * cond;                                     // 九态(%) = 半场边际概率 × 混合条件
    }
  }
  // 全场边际 + 九态百分比 + 条件矩阵（全程百分比，joint 与 marginal 一致）
  const sFT={H:0,D:0,A:0}; for (const k in states){ sFT[k[1]]+=states[k]; }
  const pFT={ H:+(sFT.H).toFixed(1), D:+(sFT.D).toFixed(1), A:+(sFT.A).toFixed(1) };
  const pHTFT={}; for (const k in states) pHTFT[k]=+states[k].toFixed(1);
  const X=['H','D','A'], Y=['H','D','A'];
  const pFT_HT={}, pHT_FT={};
  for (const x of X){ pFT_HT[x]={}; for (const y of Y) pFT_HT[x][y] = pHT[x]>0 ? +((states[x+y]/pHT[x])*100).toFixed(1) : 0; }
  for (const y of Y){ pHT_FT[y]={}; for (const x of X) pHT_FT[y][x] = sFT[y]>0 ? +((states[x+y]/sFT[y])*100).toFixed(1) : 0; }
  const top = Object.keys(pHTFT).map(k=>({state:k, p:pHTFT[k]})).sort((a,b)=>b.p-a.p).slice(0,6);
  return { lambda:sc.lambda, mu:sc.mu, wf:+wf.toFixed(2), lean:+lean.toFixed(3), couple:+coupleW.toFixed(2),
           hl1:+hl1.toFixed(2), hm1:+hm1.toFixed(2), hl2:+hl2v.toFixed(2), hm2:+hm2v.toFixed(2),
           pHT, pFT, pHTFT, pFT_HT, pHT_FT, top,
           note:`半全场九态概率（主队修正 lean=${lean}+耦合修正 couple=${coupleW}：上 Poisson(${hl1.toFixed(2)})/(${hm1.toFixed(2)})，下 Poisson(${hl2v.toFixed(2)})/(${hm2v.toFixed(2)})，wf=${wf}）；只给分布，不下单点结论。` };
}

/* ---------- 半场破蛋（上半场≥1球）专属模型 ----------
   复用 predictHTFT 的半场期望 hl1/hm1（wf=HT_WF=0.45，与看板卡片/破蛋筛选完全一致）。
   P(破蛋) = 1 − e^(−(hl1+hm1))。口径与 _val_break.cjs 离线标定严格一致（wf=0.45，1637 样本 / 3354 真值）。
   2026-10-01 二次标定（权威）：改用 7m 独立真值跨源验证（729 场配对，见 _eval/_7m_pair_eval.cjs）——
     强 p≥0.80 实际 87%(117/135，+13pp edge)；中 0.70~0.80 实际 73%(278/381)≈基准、无 edge；
     弱 <0.70 实际 66%(141/213) 属负 edge（反向观察档）。
   旧档位结论（基准73.7% / mid 78.8% / strong 86.9%，1637 样本 Over 页回测）含同源偏倚，已作废。
   只给概率 + 高置信子集提示，不下单点结论。tier 由标定阈值决定，可随重标定覆盖。 */
/* ---------- 联赛半场破蛋率（数据驱动剔除，2026-10-12 #305） ----------
   强档(pBreak≥0.80)若落在系统性低半场进球/非主流联赛，降级为中性并提示，避免"模型高估强档"。
   仅在 Node 环境加载（浏览器由重烘焙产物直接带 tier，无需此文件）。 */
let _LHB = null;
function _loadLeagueHt(){
  if (_LHB !== null) return _LHB;
  if (typeof require === 'undefined' || typeof module === 'undefined') { _LHB = false; return null; }
  try { const fs = require('fs'), path = require('path');
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'league_ht_break.json'), 'utf8'));
    _LHB = { base: d.base, leagues: d.leagues || {} }; return _LHB;
  } catch(e){ _LHB = false; return null; }
}
function _leagueHtFlag(ctx){
  const T = _loadLeagueHt();
  /* ctx 兼容两种调用：旧版传联赛名字符串；新版传 {league, home, away}。
     ★ 2026-10-12 扩展：除联赛名外，也扫描队名——"国际友谊" 等主流联赛名下藏 U19/女足/青年队，
     联赛级正则漏判（用户曾投诉 武汉三镇U21/威尔士U19 被错标强档），故队名含 青年/U19/女 等一并降权。 */
  const parts = [];
  const _add = x => {
    const L = String(x == null ? '' : x);
    const c = (typeof decodeName === 'function')
      ? decodeName(L).replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim()
      : L.replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
    if (c) parts.push(c);
  };
  if (typeof ctx === 'string') _add(ctx);
  else if (ctx && typeof ctx === 'object') { _add(ctx.league); _add(ctx.home); _add(ctx.away); }
  // 联赛表命中（表是联赛名键，仅联赛名可查）
  for (const c of parts){ if (T && T.leagues && T.leagues[c]) return T.leagues[c]; }
  // 非主流（女/青年/U-series/后备/业余/院校 等）——联赛名或队名任一命中即降权
  for (const c of parts){
    if (/女|wom|girl|u17|u18|u19|u20|u21|u23|青年|后备|reserve|业余|大学|学院|学生|校|少年|kid|colt|acad/i.test(c)) return { nonMain: true };
  }
  return null;
}
function predictBreak(agg, aggBs, htftOpt, leagueOpt){
  const h = htftOpt || predictHTFT(agg, aggBs);
  const hl1 = h.hl1, hm1 = h.hm1;
  if (hl1 == null || hm1 == null) return null;
  const pBreak = 1 - Math.exp(-(hl1 + hm1));     // P(上半场≥1球)
  // 档位标签统一为「破蛋·强/中/弱」，与看板面板「档」列、卡片 pill、单场明细四处口径一致。
  /* 档位基准：2026-10-01 由 7m 独立真值跨源标定（729 场配对，见 _eval/_7m_pair_eval.cjs）。
     ⚠ 旧值 86.9/78.8/73.7 来自 1637 场 Over 页旧回测（含同源偏倚），已作废：
       strong 87%(117/135) 有 +13pp edge；mid 73%(278/381) ≈ 基准 74%、无 edge；
       low 66%(141/213) 反而是负 edge（真实破蛋率低于基准，属反向观察档）。 */
  /* ★ 2026-10-05 展示口径重标定（用户投诉：武汉三镇U21 81.7% / 威尔士U19 79.4% 两场都 0-0）。
     先在 6656 场真赔率重跑上做了三件事，结论如下（脚本 _eval/_lmu_calib.cjs + _eval/_break_verdict.cjs）：
       ① wf 不是问题：真值库 38169 场实测 wf = 0.4470，引擎 0.45 正确，不动。
       ★★ 2026-10-09 二次复核（差点改错，务必看）：拿 htft_validate.js 的 1637 场重算，
          得到 wf=0.482、且"λ+μ 比真实全场低 9.1%"，一度以为 wf 该改成 0.48。**结论：不能改。**
          根因：htft_validate.js 里存的 lambda/mu 是**补偿前**的原始值（未加 LMU_T_BIAS=0.26）。
          补偿后 2.828+0.26=3.088 vs 真实 3.111 → 仅差 0.7%，**无偏**，与本条 ② 一致。
          若照 0.48 改，等于在已补偿的 λ 上再放大 → 破蛋概率**高估约 10%**，纯负优化。
          ⇒ 任何用 htft_validate.js 做的标定，必须先给 λ+μ 加 LMU_T_BIAS，否则全部结论作废。
       ② λ+μ 整体无偏：平均预测 3.149 vs 平均实际 3.149，偏差 0.000（z=0.0）。
       ③ 🔴 但**档位阈值定错了**。实测各档「实际平均总进球」与「全场 0-0 率」：
            p≥85%  n=412  4.88 球 / 1.70%      ← 真强档（唯一有意义的强标签）
            80~85% n=1387 3.92 球 / 3.24%  ⚠ 模型自报 0-0 率 2.33% → 实际是它的 1.39 倍（z=+2.2 显著低估）
            75~80% n=1061 3.62 球 / 2.92%
            70~75% n=2263 3.01 球 / 6.72%
            65~70% n=1230 2.54 球 / 7.40%
            <65%   n=303  2.09 球 / 13.20%     ← 真弱档（反向观察有意义）
          即：**70~85% 这一整段（占 47%）区分度极弱**，79% 只是"比平均略好一点"
          （全库 5.50% 的 0-0 率 → 该档 3.22%），完全没有"有球把握大"的含义。
          用户把「破蛋率 79%」读成高置信，正是旧口径把 0.70 就叫「破蛋·中」、0.80 就叫「破蛋·强」害的。
       故重排档位：强档抬到 p≥0.85（实测 4.88 球/1.70% 0-0，才有资格叫"强"）；
                  0.70~0.85 合并为**中性档**并显式标注"无区分度·不作把握依据"；
                  0.65~0.70 与 <0.65 分成「弱」「偏弱」，因为 <65% 的 13.2% 0-0 率是**真 alpha（反向）**。
       edge 也按实测重算（相对全库均值 3.149 球 / 5.50% 0-0 率），不再用旧的 87.0/72.9/73.5 那套。 */
  /* ★ 2026-10-08 破蛋出手口径重定（_val_break.cjs 直量上半场真值 1668 场，破蛋=上半场≥1球）：
       旧强档门槛 0.85 只覆盖 75 场；实测 ≥0.80 已稳在 85.1%(n=323，+11.6pp)，0.80–0.85 段同 85%，
       故强档降到 ≥0.80 → 可出手破蛋场次翻 4 倍且胜率不变。
       各档实测上半场破蛋率(基准 73.5%)：强≥0.80=85.1%(+11.6) / 中 0.70–0.80=72.7%(≈基准) /
       偏弱 0.65–0.70=65.5%(−8.0) / 弱<0.65=67.9%(−5.6)。即唯一正 edge 在强档，中性≈基准、弱档反向。
       edge 改为真实上半场命中 edge（相对 73.5% 基准），不再用旧 73.5−5.50 那串错位数字。 */
  let tier = 'low', tag = '破蛋·弱', edge = 0;
  if (pBreak >= 0.80){ tier = 'strong'; tag = '破蛋·强'; edge = +11.6; }
  else if (pBreak >= 0.70){ tier = 'mid'; tag = '破蛋·中性'; edge = 0; }
  else if (pBreak >= 0.65){ tier = 'weak'; tag = '破蛋·偏弱'; edge = -8.0; }
  else { tier = 'low'; tag = '破蛋·弱'; edge = -5.6; }
  /* ★ 2026-10-12 #305：联赛剔除（数据驱动，league_ht_break.json）。
     强档若落在非主流/系统性低半场进球联赛 → 降级为中性，避免"模型高估强档"
     （OOS 实证：香港/U19/爱 等在强档内破蛋率显著低于 81.7%，拖累有效强档命中）。 */
  let leagueWarn = null;
  /* ★ 联赛剔除（数据驱动，league_ht_break.json）—— 对所有档位都计算 leagueWarn，
     不只 strong：否则非主流联赛落在 mid 档(pBreak 0.70~0.80)时不会被标记，
     又被 gen_ht_select 的 ht_pick A/B 路径漏进"优选"（实测漏 3 场女足/U20/后备）。
     强档仍降级为中性；中/弱/低档保持原档，仅打 leagueWarn 标记供下游排除/提示。 */
  const _lf = _leagueHtFlag(leagueOpt);
  if (_lf){
    const _reason = _lf.nonMain ? '非主流联赛(女/青年/后备/业余等)' : '系统性低半场进球联赛';
    if (tier === 'strong'){ tier = 'mid'; tag = '破蛋·中性'; edge = 0; }
    leagueWarn = _reason + '·降权';
  }
  /* 中性档必须显式说"不构成把握"，否则用户还会把 79% 当成强信号 —— 这是本次投诉的根因。 */
  const _neutralNote = (tier === 'mid')
    ? `⚠ 此档（70~85%）实测无区分度：本档平均总进球 3.01~3.92 球、全场 0-0 率 2.9~6.7%，与全库基准 3.15 球 / 5.50% 相差无几，**不构成"有球把握大"的依据**。`
    : '';
  /* 上半场比分分布（top，按概率降序）：独立 Poisson(主 hl1)/Poisson(客 hm1)，与 predictHTFT 半场矩阵同口径。
     仅展示分布，不下单点结论；与「档/破蛋概率」互为补充，让"上半场最可能打成几比几"一目了然。 */
  const _htScore = (function(){
    const _C = 7; const _M = [];
    for (let _i=0;_i<=_C;_i++){ _M[_i]=[]; for (let _j=0;_j<=_C;_j++) _M[_i][_j]=pois(_i,hl1)*pois(_j,hm1); }
    let _s=0; for (let _i=0;_i<=_C;_i++) for (let _j=0;_j<=_C;_j++) _s+=_M[_i][_j];
    const _a=[]; for (let _i=0;_i<=_C;_i++) for (let _j=0;_j<=_C;_j++) if(_M[_i][_j]>0) _a.push({s:`${_i}-${_j}`, p:+( _M[_i][_j]/_s*100 ).toFixed(1)});
    _a.sort((x,y)=>y.p-x.p); return _a.slice(0,8);
  })();
  return { pBreak:+(pBreak*100).toFixed(1), hl1:+hl1.toFixed(2), hm1:+hm1.toFixed(2),
           lambda:h.lambda, mu:h.mu, wf:+h.wf.toFixed(2), tier, tag, edge, leagueWarn, htScore: _htScore,
           note:`上半场破蛋概率 ${ (pBreak*100).toFixed(1) }%（半场期望主${hl1.toFixed(2)}/客${hm1.toFixed(2)}，wf=${h.wf}）；复用半全场九态的半场期望，与看板卡片一致。`
             + _neutralNote
             + `档位基准（2026-10-08 用 _val_break.cjs 直量上半场真值 1668 场重定，破蛋=上半场≥1球，基准 73.5%）：`
             + `强档(p≥0.80)实测上半场破蛋 85.1%(n=323，+11.6pp)——唯一正 edge、可出手；`
             + `中性档(0.70~0.80)72.7%≈基准、无 edge（勿单独投破蛋）；偏弱(0.65~0.70)65.5% / 弱档(<0.65)67.9% 均为反向负 edge。`
             + `（注：2026-10-05 曾用"全场0-0率"当破蛋代理定 0.85 强档，已改；上半场真值才是对的度量。）`
             + `仅分布+高置信子集提示，不下单点结论。` };
}

/* ---------- 庄家热度 / PPI ----------
   - 真 PPI = 投注占比 × 赔率（需澳客/必发 feed，经 ppiInput 注入）；PPI_i>1 即该结果被过度投注。
   - 代理热度：源站无占比时，用「临场赔率变动幅度(隐含资金流向) + 亚盘水位」合成 0-100 热度。 */
function computeHeat(agg, a){
  const mv_h=a.mv_h||0, mv_d=a.mv_d||0, mv_a=a.mv_a||0;
  let hW=50+2.2*mv_h, hD=50+2.2*mv_d, hL=50+2.2*mv_a;   // 赔率下调=注码涌入=升温
  if (a.p1!=null && a.h1!=null){
    const up_home = a.p1>=0;
    if (a.h1<0.85){ if(up_home) hW+=8; else hL+=8; }      // 上盘低水=受热
    else if (a.h1>1.05){ if(up_home) hW-=6; else hL-=6; }
  }
  const clamp=v=>Math.max(0,Math.min(100,v));
  hW=clamp(hW); hD=clamp(hD); hL=clamp(hL);
  const arr=[['W',hW],['D',hD],['L',hL]].sort((x,y)=>y[1]-x[1]);
  const hot = arr[0][1]>=58 ? arr[0][0] : '—';
  return { proxy:true, available:false,
    heat:{W:Math.round(hW),D:Math.round(hD),L:Math.round(hL)},
    hot_side:hot, ppi:null,
    note:'热度代理（源站无真实投注占比；以临场赔率变动+亚盘水位合成）。接入澳客/必发投注占比即可算真 PPI=占比×赔率。' };
}
/* ---------- 澳客真实投注数据（自动填充，无需手输） ----------
   来源：澳客「必发数据」页（真投注占比 = 必发比例）+ 单场 exchanges 页。
   由 fetch_okooo.cjs 抓取、match_okooo.cjs 按队名模糊匹配后生成 ppi_auto.json，
   打包时注入为 BETFA_DATA。命中的比赛自动带真实占比，未命中的回落手动输入/热度代理。 */
let BETFA_INDEX = {};
let BETFA_TEAM_INDEX = {};     // 队id精确索引（okooo 同源 home_team_id|away_team_id，bidirectional）★ 2026-10-11 #290
let COMPANY_DIV_INDEX = {};   // 跨公司赔率分歧索引（loadCompanyDiv 注入，按 tid）
function loadCompanyDiv(rows){ COMPANY_DIV_INDEX = {}; for (const r of (rows||[])){ if (r && r.tid != null) COMPANY_DIV_INDEX[String(r.tid)] = r; } return Object.keys(COMPANY_DIV_INDEX).length; }
function getCompanyDiv(tid){ return (tid != null && COMPANY_DIV_INDEX[String(tid)]) ? COMPANY_DIV_INDEX[String(tid)] : null; }
let BETFA_NAME = {};   // 队名对索引（澳客/必发数据常无 tid，按 home|away 匹配）
function normName(s){ if(!s) return ''; return String(s).replace(/<[^>]+>/g,'').replace(/&#xe[0-9a-f]+;/gi,'').replace(/\s+/g,''); }
function loadBetfa(rows){
  BETFA_INDEX = {}; BETFA_NAME = {}; BETFA_TEAM_INDEX = {};
  for (const r of (rows || [])){
    if (!r) continue;
    if (r.tid != null) BETFA_INDEX[String(r.tid)] = r;
    /* ★ 2026-10-11 #290：必发行带 okooo 同源 home_team_id/away_team_id（match_okooo 注入），
       与 bake_pack 的 team_id 一字不差同源 → 精确直配，绕开 2.9M/3.0M tournament_id 分裂失配。
       双向建索引（主客倒置也能命中）。 */
    if (r.htid != null && r.atid != null){
      BETFA_TEAM_INDEX[String(r.htid)+'|'+String(r.atid)] = r;
      BETFA_TEAM_INDEX[String(r.atid)+'|'+String(r.htid)] = r;
    }
    const h=normName(r.home), a=normName(r.away);
    if (h && a){ BETFA_NAME[h+'|'+a]=r; BETFA_NAME[a+'|'+h]=r; }
  }
  return Object.keys(BETFA_INDEX).length + Object.keys(BETFA_NAME).length + Object.keys(BETFA_TEAM_INDEX).length;
}
function getBetfa(tid, home, away, league, htid, atid){
  /* ★ 2026-10-16 修复「算不出过热」根因：精确 ID 通道（tid / team_id）ID 已唯一锁定具体场次，
     无需 _cupOk 杯赛/联赛守卫。旧逻辑对所有通道套 _cupOk，导致 bake 联赛名("欧联杯")与源站("欧联")
     的"杯"字不一致即拒绝有效精确匹配（如 马赛vs奥林匹亚科斯 tid 3073727）→ 真实澳客热度永不挂载。
     现：精确 ID 通道直接放行；仅队名模糊通道保留 _cupOk 防串场误配（北单/澳客同名两队联赛+杯赛混贴）。 */
  if (tid != null && BETFA_INDEX[String(tid)]) return BETFA_INDEX[String(tid)];
  if (htid != null && atid != null){
    const r = BETFA_TEAM_INDEX[String(htid)+'|'+String(atid)];
    if (r) return r;
  }
  const h=normName(home), a=normName(away);
  if (h && a){
    const r1 = BETFA_NAME[h+'|'+a]; if (r1 && _cupOk(league, r1.league)) return r1;
    const r2 = BETFA_NAME[a+'|'+h]; if (r2 && _cupOk(league, r2.league)) return r2;
  }
  return null;
}

/* ---------- 竞彩官方数据（中国体彩 sporttery）：编号 + 官方胜平负/让球/比分/半全场/进球数 ----------
   用途：① 标记"竞彩场次"并按此筛选；② 官方赔率（含比分/半全场/进球数）——用户正业数据。
   源：fetch_jingcai.cjs 抓 webapi.sporttery.cn → jingcai.json → gen_index 注入为 JC_DATA。 */
let JC_ROWS = [];
function loadJingcai(rows){ JC_ROWS = Array.isArray(rows) ? rows : []; return JC_ROWS.length; }
function getJingcaiRows(){ return JC_ROWS; }

// ===== 北单（北京单场）数据层（照抄竞彩，2026-09-15 新增）=====
// 说明：北单官方赛程无免费可抓接口（已实测 bjlot/sporttery-bd 网关/okooo/500 全部 403/404/E0001），
// 故 beidan.json 默认空（source:'未接入'）。用户提供场次清单或接口后，loadBeidan 即可生效，"只看北单"过滤随之可用。
globalThis.BD_ROWS = globalThis.BD_ROWS || [];
function loadBeidan(rows){ globalThis.BD_ROWS = Array.isArray(rows) ? rows : []; return globalThis.BD_ROWS.length; }
// 杯赛/联赛一致性守卫（2026-10-10 修串场误配）：同一两队可能既踢联赛又踢杯赛（如东京绿茵vs广岛三箭），
// 北单只有一条联赛赔率池行，纯队名匹配会把该行同时贴到联赛场与杯赛场 → 杯赛场拿到错配的热度（实测 3086990 杯赛场被 3000482 联赛行误贴）。
// 规则：bake 场联赛含"杯" ⇔ 北单行联赛含"杯"（双方必须同属杯赛或同属联赛），否则判不匹配。
/* ★ 2026-10-20 修误杀：同一赛事两侧叫法不同——bake"欧冠杯/欧罗巴杯/欧会杯" vs 北单"欧冠/欧联/欧协联"，
   旧"含杯字二分"把它们全误判成一杯一联而拒配（今日欧冠欧联 20+ 场全挂）。
   先同义归一（欧罗巴杯→欧联、欧会杯→欧协联…），相等或互包含=同一赛事直接放行；否则退回杯/联赛二分。 */
const _lgNorm = s => String(s || '')
  .replace(/欧罗巴杯?|欧联杯?/g, '欧联').replace(/欧冠杯?/g, '欧冠')
  .replace(/欧会杯|欧协杯|欧协联/g, '欧协联').replace(/亚冠杯?/g, '亚冠')
  .replace(/南美杯/g, '南俱杯').replace(/(杯|联赛)$/, '');
function _cupOk(bakeLeague, srcLeague){
  const b = _lgNorm(bakeLeague), s = _lgNorm(srcLeague);
  if (b && s && (b === s || b.includes(s) || s.includes(b))) return true;
  const bCup = !!bakeLeague && /杯|欧冠|欧联|欧罗巴|欧协|亚冠|解放者|南俱|世俱|天皇/.test(bakeLeague);
  const sCup = !!srcLeague && /杯|欧冠|欧联|欧罗巴|欧协|亚冠|解放者|南俱|世俱|天皇/.test(srcLeague);
  return bCup === sCup;
}
/* ★ 2026-10-20 口径修复（用户"想办法做到"扩容行动）：北单同一场比赛有多行——rq=0 是胜平负行，
   rq=-1/-2/-3 是【让球盘】行（sp/pct 是让球后的赔率与占比，与三项资金占比完全不是一个东西）。
   此前不区分，遍历到第一行就返回 → 实测 17/57 场拿到让球行（利物浦U19 rq=-1 等），
   资金热度口径全错。修复：只用 rq==0 || rq==null 的胜平负行；让球行直接跳过。 */
function _bdStdRow(r){ return r && (r.rq === 0 || r.rq == null); }
function getBeidan(home, away, league){
  if (!home || !away) return null;
  for (const r of (globalThis.BD_ROWS||[])){ if (_bdStdRow(r) && _bdNameEq(home, r.home) && _bdNameEq(away, r.away) && _cupOk(league, r.league)) return r; }
  for (const r of (globalThis.BD_ROWS||[])){
    if (_bdStdRow(r) && _bdNameEq(home, r.away) && _bdNameEq(away, r.home) && _cupOk(league, r.league)){
      const sw = o => { if (!o) return o; const out = {}; for (const k in o) out[k] = (/^h/.test(k) ? 'a' + k.slice(1) : /^a/.test(k) ? 'h' + k.slice(1) : k); return out; };
      return Object.assign({}, r, { swapped: true, home: r.away, away: r.home });
    }
  }
  return null;
}
/* ★ 2026-10-29 让球行覆盖（用户"三盘资金过热板为什么赛前不给信息"排查结论之一）：
   北单对强弱悬殊场（本菲卡/哈马比/弗洛西诺内等）只开【让球胜平负】玩法（rq≠0），
   旧口径铁律 rq≠0 一律跳过 → 这批在售场在板上完全无北单资金信息。
   本 getter 只做【展示覆盖】：返回让球行原值（rq/sp/pct），不参与 heatExcess/过热信号计算——
   让球后的胜平负 ≠ 原始胜平负，占比不能与公平胜率直接相减（口径不同，绝不能混算）。 */
function getBeidanRq(home, away, league){
  if (!home || !away) return null;
  for (const r of (globalThis.BD_ROWS||[])){
    if (!(r && r.rq !== 0 && r.rq != null)) continue;
    if (_bdNameEq(home, r.home) && _bdNameEq(away, r.away) && _cupOk(league, r.league)) return r;
  }
  for (const r of (globalThis.BD_ROWS||[])){
    if (!(r && r.rq !== 0 && r.rq != null)) continue;
    if (_bdNameEq(home, r.away) && _bdNameEq(away, r.home) && _cupOk(league, r.league)){
      return Object.assign({}, r, { swapped: true, home: r.away, away: r.home });
    }
  }
  return null;
}
/* ★ 2026-10-14 #319：北单专用队名匹配 —— 用 decodeName 真解码 PUA（normName 只剥离不解码 → 残名 0.9% 失配）。
   竞彩仍走 _jcNameEq（官方简称+JC_ALIAS）；北单与 bake 同源 okooo 残名，须 decodeName 才能对上。 */
/* ★ 2026-10-20 北单侧译名别名（实测今日缺口：巴萨/马竞/曼联/威科姆，2字简称 includes/重合度都够不着）。
   只收实测确认的一对一映射，宁缺毋滥。 */
const BD_ALIAS = { '巴萨': '巴塞罗那', '马竞': '马德里竞技', '曼联': '曼彻斯特联', '威科姆': '韦康比流浪者',
                   '巴黎圣': '巴黎圣日耳曼', '国米': '国际米兰', '拜仁': '拜仁慕尼黑', '皇马': '皇家马德里',
                   /* ★ 2026-10-29 扩容（beidan 孤儿配对，node 真引擎+碰撞校验，43→55 标准行，0 碰撞）：均为男足、队名已核对 */
                   'AC奥': '奥卢', '瓦萨': 'VPS瓦萨',
                   '兰赫姆': '兰黑姆', '腓特烈': '腓特烈斯塔',
                   '安格森': '埃格尔森德', '桑纳菲': '桑德菲杰',
                   '佐加顿': '佐加顿斯', '布鲁马': '布洛马波卡纳',
                   '代格福': '代格福什', '韦斯特': '瓦斯特拉斯',
                   '基尔': '荷尔斯泰因', '邓迪F': '邓迪FC', '基尔马': '基马诺克',
                   '阿尔胡': '奥胡斯费马', '沃洛斯': '维洛斯NFC', '阿特罗': '阿特罗米托斯',
                   '厄尔格': '奥尔格里特', '米亚尔': '米亚尔比', '克鲁日': '克卢日大学' };
function _bdNameEq(a, b){
  let x = decodeName(a), y = decodeName(b);
  if (!x || !y) return false;
  x = BD_ALIAS[x] || x; y = BD_ALIAS[y] || y;
  x = x.replace(/\s+/g, ''); y = y.replace(/\s+/g, '');
  if (x === y) return true;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return true;
  const s = x.length <= y.length ? x : y, L = x.length <= y.length ? y : x;
  if (s.length >= 3 && L.length >= 3){
    const pool = L.split(''); let hit = 0;
    for (const ch of s){ const i = pool.indexOf(ch); if (i >= 0){ hit++; pool.splice(i, 1); } }
    if (hit / s.length >= 0.85) return true;
  }
  return false;
}
// 官方队名为简称(如"国际图尔")，源站为全称(如"国际图尔库") → 用包含式匹配，主客都需命中
// 已知译名差异（源站名 → 竞彩官方名）。精确表优先，避免模糊匹配误配
const JC_ALIAS = { '尤尔加登':'佐加顿斯', '桑德菲杰':'桑纳菲', '图尔库国际':'国际图尔' };
function _jcNameEq(a, b){
  let x = normName(a), y = normName(b);
  if (!x || !y) return false;
  x = JC_ALIAS[x] || x; y = JC_ALIAS[y] || y;
  if (x === y) return true;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return true;
  // 字符重合度兜底（阈值 0.85，宁可漏配不误配）。主客双命中才判定。
  const s = x.length <= y.length ? x : y, L = x.length <= y.length ? y : x;
  if (s.length >= 3 && L.length >= 3){
    const pool = L.split(''); let hit = 0;
    for (const ch of s){ const i = pool.indexOf(ch); if (i >= 0){ hit++; pool.splice(i, 1); } }
    if (hit / s.length >= 0.85) return true;
  }
  return false;
}
function getJingcai(home, away){
  if (!home || !away) return null;
  // 1) 同向匹配
  for (const r of JC_ROWS){ if (_jcNameEq(home, r.home) && _jcNameEq(away, r.away)) return r; }
  // 2) 主客反向匹配（两站对主客标注可能相反，如"中国女vs中国港女"）。
  //    命中则返回官方赔率已同步对调(h<->a)的副本，保证与页面主客一致。
  for (const r of JC_ROWS){
    if (_jcNameEq(home, r.away) && _jcNameEq(away, r.home)){
      const sw = o => { if (!o) return o; const out = {}; for (const k in o) out[k] = (/^h/.test(k) ? 'a' + k.slice(1) : /^a/.test(k) ? 'h' + k.slice(1) : k); return out; };
      return Object.assign({}, r, { swapped: true, had: sw(r.had), hhad: sw(r.hhad), home: r.away, away: r.home });
    }
  }
  return null;
}

// 战意：由联赛排名推导（争冠/保级战意高，中游无欲无求）。无排名则返回 null。
// 战意相关函数 calcZhanyi / leagueSize 已移除（2026-10-26）：动机信号不再参与模型。

function computePPI(ppiInput, agg){
  const odds = ((agg.eu_valid||0)>=3 && agg.c_h) ? [agg.c_h,agg.c_d,agg.c_a] : [agg.o_h,agg.o_d,agg.o_a];
  const ks=['W','D','L']; const ppi={}, heat={};
  for (let i=0;i<3;i++){
    const pct = (ppiInput && ppiInput[ks[i]]!=null) ? ppiInput[ks[i]] : null;
    if (pct==null){ ppi[ks[i]]=null; heat[ks[i]]=50; continue; }
    const o = odds[i];
    ppi[ks[i]] = +(pct*o).toFixed(3);                 // 真 PPI
    heat[ks[i]] = Math.round(Math.min(100, pct*100)); // 占比即热度基准
  }
  const arr=ks.map((k,i)=>[k, ppi[k]!=null?ppi[k]:0]);
  arr.sort((x,y)=>y[1]-x[1]);
  const hot = arr[0][1] > 1.0 ? arr[0][0] : '—';       // PPI>1 即过度投注
  return { proxy:false, available:true, heat, hot_side:hot, ppi,
    note:'真 PPI=投注占比×赔率；PPI>1 表示该结果被过度投注（庄家若打出将亏本）。' };
}

/* ====== 临场盘路融合主信号（提高命中率的真实杠杆）======
   仅用 agg 的 初盘(o_*) 与 即时(c_*) 欧赔，无需完整历史：
     curProb  = 即时隐含概率(最高方=市场最看好方)
     openProb = 初盘隐含概率
     move     = curProb - openProb (临场移动方向：市场资金向哪方聚集)
   规则（经 5042 场回测验证，详见整改报告）：
     • 临场最优方 == 临场移动看好方（双重确认）→ tier1、置信高（全量 56.4% / 9/13 留出 77.8%）
     • 仅临场最优方、移动不确认 → tier2（全量 52.8%）
     • 平局仅在"其为最优方且概率≥0.32、且移动同向"才出（平局本身难预测，~30% 为真实上限）
   该信号取代原 SIG_W 投票成为主推荐，原投票/战意/PPI/洋哥/贺 作为置信调整层。 */
function improvedPick(agg, betfaPct){
  if (!agg || agg.c_h==null || agg.o_h==null) return null;
  let cur, opn;
  try { cur = _prob(agg.c_h, agg.c_d, agg.c_a); opn = _prob(agg.o_h, agg.o_d, agg.o_a); }
  catch(e){ return null; }
  if (!cur || !opn) return null;
  const curP = [cur[0], cur[1], cur[2]];                 // 0=W,1=D,2=L (0~1)
  const move = [curP[0]-opn[0], curP[1]-opn[1], curP[2]-opn[2]];
  const argmax = a => { let bi=0; for(let i=1;i<a.length;i++) if(a[i]>a[bi]) bi=i; return bi; };
  const curFav = ['W','D','L'][argmax(curP)];
  const favMove = ['W','D','L'][argmax(move)];
  const mx = Math.max(...curP);                          // 即时最高隐含概率
  const mv = move[argmax(move)];                         // 最大移动幅度
  const agr = (curFav === favMove);
  // 澳客真实投注占比(PPI)信号：市场一致看好方(≥55%)跟随（15场真实回测 75% 命中）
  const bpOk = betfaPct && [betfaPct.W, betfaPct.D, betfaPct.L].every(v => v != null);
  const betFav = bpOk ? ['W','D','L'][argmax([betfaPct.W, betfaPct.D, betfaPct.L])] : null;
  const betMax = (bpOk && betFav) ? Math.max(betfaPct.W, betfaPct.D, betfaPct.L) : 0;
  const strong = betFav && betMax >= 55;
  if (strong){
    const agreeBet = (betFav === curFav) || (betFav === favMove);
    return { pick: betFav, conf: Math.round(Math.min(88, 56 + betMax*0.35 + (agreeBet ? Math.abs(mv)*220 : 0))), tier: agreeBet ? 1 : 2, src: 'ppi-strong' };
  }
  // 平局：仅在确实为最优方且概率够高时才给，否则让位 W/L
  if (curFav === 'D'){
    if (mx >= 0.32 && agr) return { pick:'D', conf:Math.round(Math.min(70, 40 + mx*120 + Math.abs(mv)*200)), tier:1, src:'agree-D' };
    return null;                                         // 平局非最优/未确认 → 跳过(不强行出平局)
  }
  if (agr){
    const conf = Math.round(Math.min(86, 50 + mx*70 + Math.abs(mv)*240));
    return { pick:curFav, conf, tier:1, src:'agree' };
  }
  // 仅临场最优、移动不支持 → 弱确认(tier2)
  if (mx >= 0.40) return { pick:curFav, conf:Math.round(Math.min(64, 42 + mx*60)), tier:2, src:'fav-only' };
  return null;
}

/* ====== 平局信号卡（新范式核心：平局 = 问题盘结果，不是概率阈值）======
   依据（全部来自已逐字研读的文献）：
     · 洋哥《盘赔我见》：平局=典型问题盘结果（让方被否定 + 平赔不作为）
     · 米客《赔率会说话·欧赔招式版》平局手法：拉胜分平 / 抬胜分平 / 逆拉双分平 / 平高梯度阻
     · 米客平赔思维：平实位 / 平中庸 / 韬开平 / ★洼地判据（胜负不足以分散平赔→必非平局）
     · 孤行：平赔思维 + 威廉平赔指南针 + 心理关口 2.0/2.5/3.0/3.5/4.0/5.0
     · 今在：受注初盘反映庄家真实态度；初盘偏离=问题盘
   四层判据（①让方被否定 ②平赔思维形态 ③平赔位置/洼地 ④初盘偏离），
   score ≥ 4 视为平局信号成立，≥6 强。返回 {fire,score,tag,reasons,level}。 */
function drawCard(x){
  const o = { fire:false, score:0, tag:'—', reasons:[], level:'弱' };
  if (!x) return o;
  const o0h=x.o_h, o0d=x.o_d, o0a=x.o_a;
  if (o0h==null || o0d==null || o0a==null) return o;
  const o1h=x.c_h, o1d=x.c_d, o1a=x.c_a;
  const hasC = ((x.eu_valid||x.c_valid||0) >= 3) && o1h!=null && o1d!=null && o1a!=null;
  // 赔率变动：正 = 赔率下降 = 资金涌入 = 升温；负 = 赔率上升
  const mvH = hasC ? (o0h-o1h)/o0h*100 : 0;
  const mvD = hasC ? (o0d-o1d)/o0d*100 : 0;
  const mvA = hasC ? (o0a-o1a)/o0a*100 : 0;
  const a0 = x.o_hcap;
  const upHome = (a0!=null) ? a0>=0 : true;       // 让方(上盘)是否主队
  const mvUp = upHome ? mvH : mvA;                // 让方赔率变动
  const mvLo = upHome ? mvA : mvH;                // 受让方赔率变动
  const r = o.reasons;
  let neg = false;   // 让方(上盘)被否定 标记（庄家视角：站注码对面）

  // ① 让方(上盘)被否定 —— 问题盘核心（平局建立在"庄家否定让方"基础上，双场景客观）
  const typ = String(x._pan_type||'');
  if (/浅诱|深诱|示弱|妥协/.test(typ)){ o.score += 2.0; neg=true; r.push(`盘型【${typ}】=让方被否定`); }
  if (x._hot_up){ o.score += 1.0; r.push('上盘注码受热(弱代理·仅辅助，不单独构成否定)'); }
  // ★ 真实大热（澳客/必发投注占比）：让方资金占比远超公平胜率 → 庄家视角"站注码过多方对面"=让方被否定。
  //   这是真信号（洋哥：北单池一方≈70%即大热；代理水位只作弱辅助），故可设 neg。
  if (x._real_hot_up){ o.score += 2.0; neg = true; r.push(`必发真实占比 ${(+x._real_hot_up_pct||0).toFixed(1)}% 大热(资金远超公平胜率)→让方被否定·站注码对面`); }
  if (x.dp!=null){ const backOff = upHome ? (x.dp < -0.2) : (x.dp > 0.2); if (backOff){ o.score += 1.0; neg=true; r.push('亚盘退盘，让方支撑减弱'); } }

  // ② 平赔思维形态（米客平局手法；必须是"刻意"异动才计为正信号，阈值收紧以剔除常规漂移）
  //    注：平高梯度阻 必须 让方已否定 —— 无否定的高平赔只是庄家真看衰平局，非平局手法。
  if (hasC){
    if (mvUp>2.0 && mvD<-2.0 && mvLo<=1.0){ o.score += 4.0; o.tag='拉胜分平'; r.push(`拉胜分平：让方赔${(-mvUp).toFixed(1)}%(拉)+平赔${(-mvD).toFixed(1)}%(顶)+受让方未降`); }
    else if (mvUp<-2.0 && mvD>1.5){ o.score += 4.0; if(o.tag==='—') o.tag='抬胜分平'; r.push(`抬胜分平：让方赔升${(-mvUp).toFixed(1)}%(给赔付)+平赔降${mvD.toFixed(1)}%`); }
    else if (mvUp<-1.5 && mvLo>1.5){ o.score += 4.0; if(o.tag==='—') o.tag='逆拉双分平'; r.push('逆拉双分平：让方升水+受让方降水，双向逆拉分散(金标准)'); }
    else if (neg && mvD<-4.0 && o0d>=3.40){ o.score += 2.5; if(o.tag==='—') o.tag='平高梯度阻'; r.push(`平赔顶起${(-mvD).toFixed(1)}%成梯度阻力(让方已否定)`); }
  }

  // ③ 平赔位置（米客平赔思维：平赔高低必须结合"让方是否被否定"才有方向意义）
  //    高平(>3.50) 无让方否定 = 庄家真看衰平局 → 不给正分；有否定 = 韬高阻力(平局手法)
  //    低平(<3.10) = 降赔付平局手法；中庸 = 不明确
  if (o0d >= 3.70 && neg){ o.score += 1.0; r.push(`平赔${o0d.toFixed(2)}韬高+让方已否定=强阻力(平局手法)`); }
  else if (o0d >= 3.50 && neg){ o.score += 0.5; r.push(`平赔${o0d.toFixed(2)}高位+让方已否定(阻力平局手法)`); }
  else if (o0d >= 3.50){ /* 高平无让方否定：庄家看衰平局，不给正分 */ }
  else if (o0d < 3.10){
    o.score += 0.3;
    if (neg){ o.score += 1.0; r.push(`平赔${o0d.toFixed(2)}低平+让方已否定=庄家"认怂"不作为(典型不可拉动型平局)`); }
    else r.push(`平赔${o0d.toFixed(2)}（低平·降赔付平局手法）`);
  }
  else { o.score += 0.3; r.push(`平赔${o0d.toFixed(2)}（中庸略韬）`); }
  // ★洼地判据（米客）：中庸平赔(3.20~3.50) + 胜负分散力不足 → 平赔洼地 → 必非平局
  const splitStrong = (Math.abs(mvH) >= 1.0 || Math.abs(mvA) >= 1.0);
  if (o0d >= 3.20 && o0d < 3.50 && hasC && !splitStrong){ o.score -= 2.0; r.push('中庸平赔且胜负分散力不足→平赔洼地（非平局）'); }

  // ③b 威廉平赔指南针（由丹麦平局引申）：威廉平赔高于同业→难打出；低于同业→易打出（仅当有威廉数据）
  if (x.william_d != null && x.peer_d_avg != null && x.peer_d_avg > 0){
    if (x.william_d > x.peer_d_avg * 1.03){ o.score -= 1.5; r.push('威廉平赔高于同业→平局难打出(指南针)'); }
    else if (x.william_d < x.peer_d_avg * 0.97){ o.score += 1.0; r.push('威廉平赔低于同业→平局易打出(指南针)'); }
  }

  // ④ 初盘偏离（问题盘/错盘）
  if (x._pan_gap!=null && Math.abs(x._pan_gap) >= 1.0){ o.score += 1.0; r.push(`实际初盘偏离预期${x._pan_gap>0?'+':''}${x._pan_gap}（错盘·问题盘）`); }

  // 门控：必须"让方被否定"与"平赔形态"至少命中其一，否则不视为真平局
  if (!neg && o.tag === '—'){ o.score = Math.min(o.score, 1.5); }

  o.fire = o.score >= 4.0;
  o.level = o.score >= 6.0 ? '强' : (o.score >= 4.0 ? '中' : '弱');
  if (o.tag === '—') o.tag = o.fire ? '问题盘·平局' : '—';
  return o;
}

/* 洋哥热度适用域（自传原文硬约束）：
   "大型比赛，基本仅仅限于欧洲杯和世界杯，可以无脑使用洋哥热度系统找出问题盘。
    当然平时的一些大联赛杯赛，同样有一定参考意义，但必须结合上面四点来分析，不能无脑使用。"
   → 反过来说：低级别 / 青年队 / 女足 / 友谊赛资金池极小，北单亦不开盘 → 热度系统不适用。
   实测教训（2026-09-23）：复盘里 6 场"大热"全部落在女足 / U19 / 国际友谊，实际 4 场仅 2 中，
   根因正是把热度系统用在了洋哥明确排除的域上。 */
function heatDomainOf(lg){
  const L = String(lg || '');
  if (!L) return 'unknown';
  if (/U\d{2}/.test(L) || /青年|后备|预备|学院|校园/.test(L)) return 'low';
  // 女足/女子赛事一律归 low（注意：必须放在 major 的「日联/韩K」等匹配之前，
  // 否则「女日联杯」会被「日联」误判为 major —— 实测踩过的坑）
  if (/女足|女子|女篮|女超|女甲|女联|女杯/.test(L) || /^女/.test(L)) return 'low';
  if (/国际友谊|友谊赛|热身|邀请赛|对抗赛/.test(L)) return 'low';
  if (/世界杯|欧洲杯|欧冠|欧洲冠军联赛|欧联|欧协|欧洲联赛|欧洲协会/.test(L)) return 'elite';
  if (/英超|西甲|德甲|意甲|法甲|英冠|英甲|荷甲|葡超|苏超|比甲|土超|俄超|乌超|希超|瑞超|挪超|丹超|波超|捷甲|奥甲|巴甲|阿甲|墨超|日职|日联|日乙|韩K|K联赛|澳超|美职|MLS|中超|中甲|亚冠|解放者杯|南美杯|非洲杯|亚洲杯|世预|欧预|欧国联|国王杯|意大利杯|德国杯|法国杯|英足总|英联赛杯|联赛杯|社区盾|超级杯/.test(L)) return 'major';
  return 'low';
}
/* 洋哥大热阈值（取自自传真实案例实测复算，非拍脑袋）：
   案例① 2022世界杯 美国vs伊朗：北单真实 38.09% vs 亚洲隐含 22.55% → +15.54pt，
          不败资金 66.9%（原文"接近7成"）→ 洋哥定性"太夸张""可遇不可求的机会"。
   案例② 2025-02-18 西甲 巴萨vs巴列卡诺：1.18(覆盖84.7%)→临场1.40(覆盖71.4%)，资金约80%
          → 超出约 +9pt → 洋哥定性"非常危险""大热倒灶"。 */
/* ===== 洋哥资金管理：三条问题盘线索合流 → 出手等级与仓位 =====
   依据（自传"世界杯投资策略"原文）：
     "90%的比赛，都是实力盘，吃水盘，正常盘…这部分比赛，我们的首要目标是利用概率盘，
      做到赢半，不输，少输，尽可能的让本金处在低风险中。这样的比赛，建议投资金额为本金的 1/20。"
     "另外10%的比赛，一旦出现破绽，出现问题盘，也就是精选推荐，就要把握住，尽可能的将利润扩大。
      这样的比赛，建议投资金额为本金的 1/3。"
     "本金每一轮小组赛结束后，更新一次。"（本金随周期滚动，非固定）
   三条**相互独立**的问题盘线索（互不替代，合流越强越接近"精选推荐"）：
     ① 大热必死   = 北单池真实资金占比 − 公平胜率 ≥ 15pt（洋哥案例①标定）
     ② 聪明钱背离 = 权威组 vs 大众组对同一结果定价差 ≥ 4pt（机构引导资金）
     ③ 权威分歧   = 权威公司(威廉/立博)间离散 ≥ 0.70 且大于大众离散（庄家内部无共识）
   仓位梯度（按**严格线索**条数）：0条=空手 / 1条=1/20 / 2条=1/10 / 3条=1/3。
   注：大热预警(≥8pt)/聪明钱关注(≥2.5pt)是洋哥自传里的**软预警**，仅作风险提示展示，**不计入档位**；
       仓位是**风险预算**而非命中率承诺；1/3 仅对应原文"10% 的精选推荐"，不可滥用。 */
function stakePlan(yg, div){
  const y = yg || {}, d = div || {};
  /* ★ 2026-10-21 修正（用户复核洋哥实推精选）：洋哥自传原文「一旦出现破绽=问题盘=精选推荐=本金1/3」，
     三条线索(大热必死/聪明钱背离/权威分歧)是**相互独立**的破绽类型，任一命中即属「10%精选」，不再要求三条合流。
     原 2026-10-10 的「1条=SMALL/2条=MID/3条=PICK」是我过度收紧的梯度，把单信号大热必死
     （如斯图加特vs马竞、科特布斯vs纽伦堡——洋哥均列为精选）错杀成 SMALL，与洋哥实推矛盾。现改为：任一严格破绽→PICK(1/3)。
     软预警(大热预警≥8pt/聪明钱关注≥2.5pt)仍仅作风险提示，不计入破绽档位。 */
  const clues = [];
  const warns = [];
  /* ★ 2026-10-22 二次精读自传199行修正：洋哥"大热必死"= 三盘合流 —— 大热(差值>返还率缺口) + ①盘资金趋势同指 + ②盘365不设防确认。
     不可单看第三盘(北单池)。原 isHot(gap+12) 改读 daHot(严格>缺口, 洋哥定性)，并要求二盘异常确认：
     二盘365「跟随降水设防(follow)」= 洋哥所谓正常吃水盘（无人工操盘异常）→ 不机械反买，降级软预警。 */
  /* ★ 2026-10-30 四修·对照洋哥原文逐条核对后补三个真实缺口（用户复盘：弗拉门戈/格雷米奥两场全错）：
     ① stakePlan 此前判大热必死没查 pan2.hot1——①盘必须有**真实资金流速**（流速热方降幅≥0.13，
        洋哥"一盘大热线"），否则市场几乎不动时 side 只是碰巧同指 → 误判。自传199行：一盘资金趋势必须先确认。
     ② 竞彩印证通道此前只查 jc.hotSide 方向一致，没查 jc.dev（竞彩归一隐含 vs 365 同口径隐含的资金倾斜pt）；
        自传199行明言"一盘的资金趋势也要进行相同返还率的计算，确保和二盘的真实偏差" → 补 jc.dev>0 才算印证。
     ③ 自传174行大热定性是「差值>返还率缺口 **或** 换算亚盘盘级差≥2」（**或**，不是与）——
        daHot 只看差值会漏掉盘级差型大热（美伊案例：半球盘被资金打到平手）。补 lvlDiff 通道
        （flip=方向相反=错行脏数据，必须排除）。
     实测依据：过热历史19场已结算仅 31.6% 胜率 → 旧门槛放进大量假信号，必须收紧到洋哥完整口径。 */
  const _lvlHot = !!(y.lvlDiff && y.lvlDiff.bd != null && Math.abs(y.lvlDiff.bd) >= 2 && !y.lvlDiff.flip
                  && y.heatExcessEff != null && y.heatExcessEff > 0);
  if (y.daHot || _lvlHot){
    /* ★ 三盘合流严格门控（自传197-199行）：①盘资金趋势同指（含真实流速/竞彩倾斜印证）
       + ②盘365不设防(异常) 才判大热必死；缺一即降级预警，不入场。 */
    const _sideOk1 = (y.pan2 && y.pan2.side && y.heatSide && y.pan2.side === y.heatSide && y.pan2.hot1)
                  || (y.jc && y.jc.hotSide && y.heatSide && y.jc.hotSide === y.heatSide
                      && ((y.jc.lvlDiffUp != null && y.jc.lvlDiffUp >= 1)      // ★ 原文判据：竞彩换算后比真实亚盘深≥1个盘级
                          || (y.jc.dev != null && y.jc.dev > 0)));
    /* ★ 2026-10-31 术语/定性校正（原文《资金流速详解》+《盘赔我见》荷兰段，此前注释写反，差点误改逻辑）：
       二盘判的是「365 是否**顺应**资金流速」，不是"设防/不设防"：
         · fade  = 365 对资金热方**升水**（热方变便宜、更诱人）= 不惧热钱 → 异常
                   原文荷兰：全民买荷兰，"不仅没有升盘降水，反而提高上盘水位到90以上" → 荷兰输盘。
         · flat  = 365 **纹丝不动**（以较慢盘口承接较快资金冲击）= 不顺应流速 → 异常
                   原文捷克vs南非：竞彩换算 1/1.7 冲击，365 与亚盘"至始至终都纹丝不动"以 1/1.85 承接 → 捷克死。
         · follow= 365 **跟随降水/升盘**（顺应资金） = 正常吃水盘 → 无分析价值
                   原文葡萄牙vs乌兹别克：亚盘 1.75 一路升到临场让 2.25 低水，与一盘流速吻合 → 正常变化。
       故：flat|fade = 机构不顺应资金（可反买）；follow = 顺应资金（不可反买）。 */
    const _noDefend = (y.pan2 && (y.pan2.def === 'flat' || y.pan2.def === 'fade'));
    const _follow = (y.pan2 && y.pan2.def === 'follow');
    /* ★ 2026-10-31 五修·净超买强度门槛（用户复盘：10-30 弗拉门戈 +3.1、格雷米奥 +15 两场反买双双穿盘）
       洋哥「差值>缺口」只回答"是不是偏热"，不回答"够不够格叫正式过热"。
       用户给的参考软件标尺（里尔 正式过热 +7 / 毕尔巴鄂 正式过热 +4）已定死：**净超买 ≥ +4pt 才算正式过热**。
       弗拉门戈 +3.1pt（9.8−6.7）差额只超缺口 3.1pt，属"警戒·偏热"，本不该进大热必死 → 这是那一场穿盘的直接原因。
       故：差值通道须净超买 ≥+4pt；盘级差通道（洋哥174行"或"）自带强度，不另设门槛。 */
    const _netPt = (y.heatExcessEff != null) ? +y.heatExcessEff : null;
    /* 盘口翻转型（洋哥美伊型）另设更高强度门槛：+8pt。理由：翻转本身就把 365 上盘打翻了，
       盘级差必然≥2（否则不会 flip），若沿用"盘级差通道自带强度"会无条件放行；而洋哥那场实测净超买 +16.5pt，
       取 +8 仍只留下他口中"太夸张了"那一档。 */
    const _gradeNeed = y.bdFlip ? 8 : 4;
    const _gradeOk = (_netPt != null && _netPt >= _gradeNeed) || (_lvlHot && !y.bdFlip);
    if (!_gradeOk) {
      warns.push('偏热·未达正式过热(' + (_netPt != null ? (_netPt > 0 ? '+' : '') + _netPt.toFixed(1) : '?') + 'pt<+4)');
    } else if (_sideOk1 && _noDefend) clues.push('大热必死');   // ★ 三盘合流严格门控：①同指 + ②不设防 才判大热必死
    else if (_follow) warns.push('大热预警·365顺应资金');  // 365跟随降水/升盘=正常吃水盘（葡萄牙型），非问题盘
    else if (!y.pan2) warns.push('大热预警·缺二盘');     // 缺二盘数据，无法完成三盘合流
    else if (!_sideOk1) warns.push('大热预警·盘向背离'); // ①盘与北单热门方不同指
    else warns.push('大热预警');
  } else if (y.isHot) warns.push('大热预警');
  if (y.marketHeavy) clues.push('市场大热');   // ★ 2026-10-21 洋哥「市场大热」线索(用户选B)：临盘热门方极低赔(≤1.65)的主流联赛名气队 = 大众扎堆超级热门
  if (d.sharpVsPop && d.sharpVsPop.gap >= 4) clues.push('聪明钱背离');
  else if (d.sharpVsPop && d.sharpVsPop.gap >= 2.5) warns.push('聪明钱关注');
  if (d.authSpread != null && d.authSpread >= 0.70 && (d.popSpread == null || d.popSpread < d.authSpread * 0.85)) clues.push('权威分歧');
  const n = clues.length;                 // ★ 严格计数（档位唯一依据）
  const sig = clues.concat(warns);        // 展示用：严格线索 + 软预警
  let level, frac, txt;
  /* ★ 2026-10-21：任一严格破绽 = 自传"精选推荐"级(1/3)；无破绽=空手(正常盘/吃水盘 1/20 由板外风险预算处理)。 */
  if (n >= 1){ level = 'PICK';      frac = 1 / 3;  txt = '本金 1/3'; }
  else { level = 'SKIP'; frac = 0; txt = '空手'; }
  const note = n === 0
    ? (warns.length ? '无严格问题盘线索（仅软预警：' + warns.join('、') + '），按洋哥"空手即是赢"原则不入场。' : '无破绽（正常盘/吃水盘）。洋哥：这类盘研究三天三夜也改变不了命中率，空手即是赢。')
    : (n >= 3 ? '三条严格线索合流 = 自传"精选推荐"级，把握住扩大利润（仍属小概率机会，不可常态化）。'
              : (n >= 2 ? n + '条严格线索合流，问题盘特征强，属自传"精选推荐(1/3)"级。'
                         : '单条严格破绽(大热必死/赔率抬升型/市场大热/聪明钱背离/权威分歧之一) = 自传"10%精选推荐"级，把握住扩大利润（本金1/3，仍属小概率机会）。'));
  return { signals: sig, strict: n, warns: warns, n: n, level: level, frac: frac, stakeText: txt, note: note };
}

const YG_HOT_EXCESS_PT = 18;   // 大热必死档·无365即时赔率时回退值（案例①）。2026-10-22 起主阈值改为动态「返还率缺口+缓冲」(见 _hotThr)，此处仅作365缺失回退。
/* ★ 2026-10-30 让球（亚盘）分档真实回测表 v4 —— 用户："让球是短板，野鸡比赛只能看亚盘"。
   数据：2586 场完场（3份快照去重，剔除|pan_gap|≥2脏场），按临场盘口p1+真实水位结算。
   这张表是 pan_predict 的门槛依据，也是 UI 让球列的自证读数（每档历史命中/ROI）。
   ⚠ 命中率 ≠ 赚钱：下盘档命中 48.8% 但 ROI −3.8%（水位吃光）。
   ★ v4 终校关键发现：①浅盘打"上盘"(让球方/热门方) = 65.2%/+26.5%，是全场最硬一档；
     而浅盘打"下盘"(受让方) = 32.1%/−31.6% 是最差坑 → 浅盘统一判上盘（此前误判下盘/观望）。
     ②深盘·上盘+dh降 = 63.1%/+22.0%；深盘·下盘+dh升 = 65.3%/+26.4%（水位变化接进方向，pan_hint 标记）。
     ③中庸盘·下盘+dh升·盘<=0.5 = 78.9%/+38.3% n=171（最强细分，但样本仍小，仅参考）。 */
const AH_BT = {
  '深盘·上盘':  { n:441, win:49.9, roi:-2.9,  ok:false, note:'全深盘上盘被水位吃光；须叠加dh降才正' },
  '深盘·下盘':  { n:441, win:48.8, roi:-3.9,  ok:false, note:'同上，须叠加dh升才正' },
  '深盘·上盘·dh降': { n:56, win:58.9, roi:+16.8, ok:true, note:'深盘上盘+临场降水=正ROI' },
  '深盘·下盘·dh升': { n:47, win:68.1, roi:+31.7, ok:true, note:'★深盘下盘+临场升水=反向最强(小样本)' },
  '浅盘·上盘':  { n:54, win:61.1, roi:+23.6, ok:true,  note:'★最硬档：浅盘打让球方(热门方)' },
  '浅盘·上盘·升盘': { n:23, win:65.2, roi:+28.3, ok:false, note:'浅盘上盘+升盘·小样本' },
  '浅盘·下盘':  { n:187, win:32.1, roi:-31.6, ok:false, note:'★最差坑：浅盘机械买受让方=送钱' },
  '示弱盘·上盘': { n:186, win:61.8, roi:+21.0, ok:true,  note:'浅让+低水诱下，上盘为主' },
  '中庸盘·下盘': { n:1220, win:58.9, roi:+14.6, ok:true, note:'盘口偏深，受让方结构偏差' },
  '中庸盘·下盘·dh升': { n:366, win:63.9, roi:+20.0, ok:true, note:'中庸下盘+水位升=更强' },
  '中庸盘·下盘·盘<=0.5': { n:608, win:66.8, roi:+19.3, ok:true, note:'中庸下盘·浅盘口=最稳' },
  '中庸盘·下盘·盘浅·升水': { n:83, win:68.7, roi:+31.8, ok:true, note:'★中庸下盘+升水+浅盘=最强细分(小样本)' },
  '中庸盘·下盘·浅盘口': { n:114, win:77.2, roi:+36.2, ok:true, note:'★中庸下盘·|p1|<=0.5=77.2%/+36.2%(n=114)' },
  '阻挡盘·上盘': { n:38, win:71.1, roi:+27.0, ok:false, note:'阻挡盘押上盘·小样本仅参考' },
  '妥协盘·下盘': { n:284, win:53.9, roi:+1.2,  ok:false, note:'接近零edge' },
  '妥协盘·上盘': { n:87,  win:50.6, roi:-1.9,  ok:false, note:'负edge' },
  '阻挡盘·下盘': { n:67,  win:41.8, roi:-10.4, ok:false, note:'负edge' },
};
const YG_HOT_WARN_PT   = 8;    // 危险预警档·无365即时赔率时回退值（案例②实测 80%−71.4% = 8.6pt）
const YG_HOT_BUFFER_PT = 12;   // ★ 2026-10-22 洋哥相对缺口自适应缓冲：动态门槛 = 返还率缺口(1−R365) + 12pt。回测(287场站对面)：gap+12 → n=25/命中80.0%/ROI+16.8%（优于固定18的75.8%/+14.6%）；本质=洋哥「偏差远超返还率缺口」(高返还率门槛低、低返还率门槛高)。
const YG_HOT_WARN_BUFFER_PT = 2;  // 危险预警缓冲：缺口+2pt ≈ 洋哥「危险级」(~9.5pt)
/* ★★ 2026-10-31 六修·热度分档唯一标尺（用户："正式过热/中热/正常热到底阈值多少"——此前板上有两套互相打架的标尺）
   旧两套：① UI _fpGrade 按净超买 pt（≥6 必发级 / ≥4 显著 / ≥3 警戒 / ≥2 偏热）
           ② engine heatTier 按「返还率缺口+12」动态（典型缺口6.5 → 18.5pt 才算 hot）
   同一场 net=+12：① 判"必发级(最高)"，② 判"mid(连过热都不到)" —— 完全矛盾，用户无从判断。
   现**统一到净超买 pt 单一标尺**（锚点：参考软件 里尔+7/毕尔巴鄂+4 标"正式过热"；洋哥莫尔德净+8.4、美伊净+5.5）：
     ≥ +6.0pt  → 'extreme'  必发级·极端过热（洋哥"可遇不可求"）
     +4.0~5.9  → 'formal'   正式过热（参考软件起跳线，可进"大热必死"候选）
     +2.0~3.9  → 'mid'      中热·警戒（洋哥"差值>缺口"定性区，仅观察）
     0~+1.9    → 'small'    正常热（受注均衡）
     < 0       → 'normal'   无倾斜（该方未被超买）
   ⚠ 返还率缺口(1−R365)不再是"过热门槛"，只作背景量显示（洋哥判据一的参照物）。 */
const YG_NET_TIER = { extreme: 6.0, formal: 4.0, mid: 2.0 };
function ygNetTier(netPt){
  const v = (netPt != null && isFinite(+netPt)) ? +netPt : null;
  if (v == null) return 'normal';
  if (v >= YG_NET_TIER.extreme) return 'extreme';
  if (v >= YG_NET_TIER.formal)  return 'formal';
  if (v >= YG_NET_TIER.mid)     return 'mid';
  if (v >= 0)                   return 'small';
  return 'normal';
}

/* ★ 2026-10-09 热度信号（8449 场真值校准，calib_heat.py）：
   旧"热度代理"在无真实投注占比时 hardcode heat=50、hot_side='—'，本质是噪声 → 用户骂"完全没用"。
   本函数用三条有真值依据的信号替换：
   ① 让球盘深度(主让=正)：|c_hcap|≥1.0 时热门方兑现率高（让+1.0→主胜66%、让-0.8→客胜63%）
   ② 初盘→临盘移动：主胜概率上移≥5% → 主胜率 52.9%（上移<0% 仅 40%），资金临场涌向=真信号
   ③ 热度概率门：临盘 fav P≥65% → 该方命中 75.1%（热门兑现，非 alpha，但作"别反买"依据）
   返回 { dir, strength, basis[] }；dir 为热点方向(W/D/L/'—')，strength∈{0,1,2,3}。 */
function buildHeatSignal(agg, ppiInfo){
  const out = { dir: '—', strength: 0, basis: [], proxy: true };
  if (!agg) return out;
  const hasC = ((agg.eu_valid || 0) >= 3) && agg.c_h != null && agg.c_d != null && agg.c_a != null;
  const hasO = agg.o_h != null && agg.o_d != null && agg.o_a != null;
  // ① 让球盘深度
  const cH = agg.c_hcap != null ? agg.c_hcap : (agg.o_hcap != null ? agg.o_hcap : null);
  let deepDir = '—', deepLabel = '';
  if (cH != null && Math.abs(cH) >= 0.8){
    const abs = Math.abs(cH);
    const side = cH > 0 ? 'W' : 'L';
    deepDir = side;
    deepLabel = abs >= 1.0
      ? '深盘' + (side === 'W' ? '主让≥1球→主胜' : '客让≥1球→客胜')
      : '盘差' + (side === 'W' ? '主让' : '客让') + abs.toFixed(1);
    out.basis.push(deepLabel);
  }
  // ② 初盘→临盘移动
  let moveDir = '—', moveLabel = '';
  if (hasC && hasO){
    try {
      const cur = _prob(agg.c_h, agg.c_d, agg.c_a);
      const opn = _prob(agg.o_h, agg.o_d, agg.o_a);
      if (cur && opn){
        const mW = cur[0] - opn[0];
        const idx = mW >= (cur[1] - opn[1]) && mW >= (cur[2] - opn[2]) ? 0
              : (cur[1] - opn[1]) >= (cur[2] - opn[2]) ? 1 : 2;
        const mv = [mW, cur[1] - opn[1], cur[2] - opn[2]][idx];
        const L = ['W', 'D', 'L'][idx];
        if (mv >= 0.03){ moveDir = L; moveLabel = '临场资金涌向' + L + (mv * 100).toFixed(1) + '%'; out.basis.push(moveLabel); }
      }
    } catch (e) {}
  }
  // ③ 热度概率门（临盘 fav）
  let favDir = '—', favLabel = '';
  if (hasC){
    try {
      const p = _prob(agg.c_h, agg.c_d, agg.c_a);
      if (p){
        const fi = p[0] >= p[1] && p[0] >= p[2] ? 0 : (p[1] >= p[0] && p[1] >= p[2] ? 1 : 2);
        const fav = ['W', 'D', 'L'][fi];
        const prob = p[fi] * 100;
        if (prob >= 60){ favDir = fav; favLabel = '热门' + fav + ' 隐含' + prob.toFixed(0) + '%'; out.basis.push(favLabel); }
      }
    } catch (e) {}
  }
  // 汇总：三信号投票
  const votes = { W: 0, D: 0, L: 0 };
  [deepDir, moveDir, favDir].forEach(d => { if (d !== '—') votes[d]++; });
  const best = Object.keys(votes).reduce((a, b) => votes[a] >= votes[b] ? a : b);
  if (votes[best] > 0){
    out.dir = best;
    out.strength = Math.min(3, votes[best]);  // 1~3
    if (votes[best] >= 2) out.proxy = false;  // 两信号确认=非纯代理
  }
  return out;
}

function analyze(agg, zhanyi, aggBs, ppiInput, tid, home, away, league){
  /* ★ 2026-10-30 用户要求：365/立博/威廉/英特 4家实时欧赔。
     若传入 agg 是 aggregate() 结果（含 co365/coLad/coWill/coInt），聚合成 agg.coLive 供返回。 */
  if (agg && !agg.coLive){
    const _co4 = [['co365','Bet365'],['coLad','立博'],['coWill','威廉希尔'],['coInt','Interwette']];
    agg.coLive = {};
    for (const [k, co] of _co4){
      if (agg[k] && agg[k].c) agg.coLive[co] = { o: agg[k].o || null, c: agg[k].c };
    }
  }
  const a0 = agg.o_hcap, h0 = agg.o_uw;
  // 澳客真实投注数据：有则自动采用（优先于手输），无则用传入的 ppiInput
  const betfa = getBetfa(tid, home, away, league, agg && agg.htid, agg && agg.atid);
  if (betfa && betfa.W && betfa.W.pct != null){
    ppiInput = { W: betfa.W.pct, D: betfa.D.pct, L: betfa.L.pct };
  }
  // 战意派生已移除（2026-10-26）：动机信号不再参与模型。zhanyi 参数保留以兼容调用点，但不再派生/使用。
  const p1 = agg.c_hcap, h1 = agg.c_uw;
  const dp = (p1 !== null && a0 !== null) ? (p1 - a0) : null;
  const dh = (h1 !== null && h0 !== null) ? (h1 - h0) : null;
  const o0h=agg.o_h, o0d=agg.o_d, o0a=agg.o_a;
  const o1h=agg.c_h, o1d=agg.c_d, o1a=agg.c_a;

  const has_c_asia = (agg.c_valid||0) >= 3;
  const has_c_eu   = (agg.eu_valid||0) >= 3;

  // 市场概率/实力差：优先真实临场欧赔，否则初盘（初盘始终干净）
  /* ⚠ 2026-09-23 修复：融合底板(fused.agg)只存 c_h/c_d/c_a，不含 o_h/eu_valid →
     旧条件 (agg.eu_valid||0)>=3 恒假、bh=o0h 恒 undefined → mk 恒 null →
     北单热度的"公平胜率/超出/大热"全部死掉。改为：临场欧赔齐备即优先用（初盘缺失时也用它兜底）。 */
  let bh=o0h, bd=o0d, ba=o0a;
  const _liveEuOk = (o1h!=null && o1d!=null && o1a!=null && +o1h>1 && +o1d>1 && +o1a>1);
  if (_liveEuOk && (has_c_eu || bh==null)){ bh=o1h; bd=o1d; ba=o1a; }
  let mk=null;
  try { mk = _prob(bh,bd,ba); } catch(e){ mk=null; }
  const mk_h = mk?mk[0]:null, mk_d = mk?mk[1]:null, mk_a = mk?mk[2]:null, payout = mk?mk[3]:null;
  let mv_h=0, mv_d=0, mv_a=0;   // 临场赔率相对初盘的变动幅度(%)（资金流向代理）

  let oProb=null;
  try { oProb = _prob(o0h,o0d,o0a); } catch(e){ oProb=null; }
  const o_h = oProb?oProb[0]:null, o_d = oProb?oProb[1]:null, o_a = oProb?oProb[2]:null;
  /* ⚠ 2026-09-11 修正：o_h/o_d/o_a 是**概率**不是赔率，旧代码取最小值 = 选了"市场最不看好"的结果。
     而 94% 的场次走「仅初盘·fav」兜底，等于绝大多数卡片的初盘倾向一直是反的。
     现改为取概率最大者（=赔率最低者=市场看好方）。 */
  const fav = (o_h!==null) ? (['W','D','L'].reduce((b,k,i)=> ([o_h,o_d,o_a][i] > b.v ? {k, v:[o_h,o_d,o_a][i]} : b), {k:'W',v:-1}).k) : '—';

  // 资金流向
  let flow='—', s_flow='—';
  if (has_c_eu && o1h){
    mv_h = o0h ? (o0h-bh)/o0h*100 : 0;
    mv_d = o0d ? (o0d-bd)/o0d*100 : 0;
    mv_a = o0a ? (o0a-ba)/o0a*100 : 0;
    const mvs = {W:mv_h, D:mv_d, L:mv_a};
    const mx = Math.max(mv_h,mv_d,mv_a);
    if (mx < MINMOVE) { flow='无明显'; s_flow='—'; }
    else { flow = Object.keys(mvs).reduce((b,k)=> mvs[k]>b.v?{k,v:mvs[k]}:b, {k:'W',v:-1e9}).k; s_flow=flow; }
  } else { flow='N/A·无临场'; s_flow='—'; }

  // 盘水信号
  let sig='—', s_pan='—';
  if (has_c_asia && p1 !== null){
    const up_home = p1 >= 0;
    if (dp === 0 && dh === 0) { sig='盘水未动·中性'; s_pan='—'; }
    else if ((dp>0&&dh<=0)||(dp===0&&dh<0)||(dp>=0 && (h1||0) < HOTW)) { sig='上盘受热'; s_pan = up_home?'W':'L'; }
    else if ((dp<0&&dh>=0)||(dp===0&&dh>0)||(dp<=0 && (h1||0) > COLDP)) { sig='上盘偏冷'; s_pan = up_home?'L':'W'; }
    else { sig='盘水背离·需人工判断'; s_pan='—'; }
  } else { sig='N/A·无临场'; s_pan='—'; }

  // 综合方向：改在下方「盘型预判」之后统一用实测加权投票（需先算出 s_pan_kb）
  const vals0 = [s_flow, s_pan].filter(v => v !== '—');

  const strength_diff = (o_h!==null && o_a!==null) ? (o_h - o_a)*100 : null;

  // 知识库：实力预期盘口 / 盘型 / 错盘
  let exp_hcap=null, pan_gap=null, typ='—', predict='—', s_pan_kb='—', kuopan=false;
  if (o0h && o0d && o0a){
    exp_hcap = expectedHcap(o0h,o0d,o0a);
    pan_gap = (a0 !== null && exp_hcap !== null) ? (a0 - exp_hcap) : null;
    const up_home = (a0 !== null && a0 >= 0);
    if (pan_gap !== null){
      [typ, predict, s_pan_kb] = classifyPan(pan_gap, h0, dp, dh, up_home);
      kuopan = Math.abs(pan_gap) >= 1.0;
    }
  }

  /* ====== 综合方向：实测加权投票 + 平局回避闸门 ======
     2026-09-11 基于「修正欧赔字段顺序后」的 7 天（09-04~09-10）3081 场重训。
     ⚠ 旧权重作废：旧数据把欧赔读成(主,平,客)，真实为(平,主,客)，导致
       s_pan_kb:W 旧测 59.1% 实为 32.8%、s_flow:W 旧测 35.7% 实为 46.2% —— 弃用清单全错。
     新规则（留一法 CV）：命中 59.4% / EV +14.6% / 覆盖 8.4%（旧规则 49.7% / −0.4%）。
       · 权重 = 命中率 − 33.3（edge）
       · 弃用 s_flow:D（实测 EV −15.4%，唯一负 EV；平局不可预测）
       · 弃用 s_pan_kb:W（闸门内仅 33.3%）
       · **平局回避闸门**：市场 P(平) ≥ 0.24 时不出注 —— 这是最大改进来源，
         无闸门 EV −6.6%，闸门 0.24 → +14.6%（网格单调、四种配置一致，非过拟合）
       · 方向不一致即放弃；组合 edge 合计 < 8 → 观望 */
  const SIG_W = {                            // edge = 实测命中率 − 33.3
    's_pan:W':     { edge: 17.1, n: 389, rate: 50.4 },
    's_flow:W':    { edge: 12.9, n: 364, rate: 46.2 },
    's_flow:L':    { edge: 11.3, n: 359, rate: 44.6 },
    's_pan:L':     { edge:  0.7, n: 365, rate: 34.0 },
    's_pan_kb:L':  { edge: -5.5, n:  90, rate: 27.8 }
  };
  const DRAW_GATE = 0.24;                    // 市场 P(平) 上限，超过则回避
  const DRAW_WATCH_GATE = 0.26;              // 2026-10-04：市场 P(平)≥此值整段降 t0 观望（详见下方「势均力敌观望闸」）
  const MIN_EDGE  = 8;                       // 组合 edge 合计下限
  const COMBO_CONF = {                       // 闸门内实测命中率 → 校准后置信度
    's_flow:W+s_pan:W': 70,
    's_pan:W': 63,
    's_flow:W': 57,
    's_flow:L': 57,
    's_pan:L': 44,
    's_flow:L+s_pan:L': 32
  };
  const sigVal = { s_flow, s_pan, s_pan_kb };
  let dir_='信号不足·观望', conf=0, vote=null;
  let drawHeatInfo = null;            // 平局热度(PPI/盘路)校准信息，供输出与前端展示
  let tier = 0;                   // 0=无结论 1=下注级(正EV) 2=参考级(仅方向，实测负EV，不可下注)
  const hits = [];
  for (const k in SIG_W){
    const i = k.indexOf(':');
    const key = k.slice(0,i), dir = k.slice(i+1);
    if (sigVal[key] === dir) hits.push(k);
  }
  const mkDraw = (mk && mk[1] != null) ? mk[1] : null;
  /* 平局信号卡（新范式）：方法论驱动，独立于市场概率阈值。
     让方被否定(盘型/受热/退盘) + 平赔思维形态(米客) + 平赔位置/洼地 + 初盘偏离。 */
  const hotUp = (s_pan !== '—') && ((a0 != null && a0 >= 0 && s_pan === 'W') || (a0 != null && a0 < 0 && s_pan === 'L'));
  /* 真实大热（澳客/必发占比）：让方(上盘)资金占比远超公平胜率 → 庄家视角"站注码过多方对面"=让方被否定。
     洋哥：北单池一方≈70%即大热；代理水位(_hot_up)只作弱辅助，此处方为真信号、可设 neg。 */
  const _a0 = (agg.o_hcap != null) ? agg.o_hcap : (a0 != null ? a0 : null);
  const upIsHome = _a0 != null ? _a0 >= 0 : true;
  const upKey = upIsHome ? 'W' : 'L';
  let realHotUp = false, realHotUpPct = null;
  if (betfa && betfa[upKey] && betfa[upKey].pct != null){
    realHotUpPct = betfa[upKey].pct;
    const upFair = (mk && mk[upIsHome ? 0 : 2] != null) ? mk[upIsHome ? 0 : 2] * 100 : null;
    if (realHotUpPct >= 68) realHotUp = true;
    else if (realHotUpPct >= 58 && upFair != null && (realHotUpPct - upFair) >= 10) realHotUp = true;
  }
  const dcard = drawCard(Object.assign({}, agg, { _pan_type: typ, _pan_gap: pan_gap, _hot_up: hotUp, _real_hot_up: realHotUp, _real_hot_up_pct: realHotUpPct, dp: dp }));

  /* 庄家「反向洗盘」标记 ★2026-10-01 由 9153 场完场库标定（_eval/_7m_motion2.cjs）
   * 判据：临场让球 c_hcap 与「初盘→临场」移动量 Δh = c_hcap − o_hcap **反号**，且 |Δh| ≥ 0.25。
   * 含义：庄家临场把盘口往 fav 的反方向调（洗盘/诱导资金）；此时候选方向应**更坚定地锚定临场 fav**。
   * 实测（4640 场可分析，市场临场 fav 基准 55.0%）：
   *   |Δh|≥0.25 → 69.9%(n=455, z=6.4) | ≥0.5 → 74.9%(n=207) | ≥0.75 → 80.2%(n=91)
   *   ⚠ 控制临场盘口幅度后，四个幅度层内的增量仍全为正（+11.3/+4.9/+17.1/+4.9pp）⇒ 不是深盘换皮。
   *   ⚠ 2 折交叉（A→B / B→A）两折都成立，阈值过拟合可排除。
   *   ⚠ 反向佐证：欧赔 Δo 与亚盘方向背离时，跟临场走只剩 5~20% ⇒ 市场内部分歧是真危险信号。
   */
  /* ★ 2026-10-02 扩展「庄家反向洗盘」为**双判据**（_eval/_7m_water.cjs 阈值 912 场标定）：
     ① 旧：盘口逆势 —— 临场让球 c_hcap 与「开盘→临场」盘口移动 Δh 反号且 |Δh|≥0.25
              命中 66.4%（n=113，基准 59.0%）
     ② 新：**水位大幅调节** —— fav 方（=临场盘口的上盘，水位字段 b/e）临场与开盘水位差
              |Δw|≥0.20 → 73.3%(n=105, z=3.0)；≥0.25 → 83.1%(n=59, z=3.8)；≥0.30 → 88.4%(n=43)
              单调、升/降**两侧都行**（升≥0.25 = 79.3% / 降≥0.25 = 86.7%，不是单向挑的）
              ⇒ 信号不是"反向"，而是「庄家把水位大幅拨动 = 在洗盘」，真值仍在临场 fav。
              硬检验：2 折交叉两折都过；前 50% 定阈值→后 50% 盲验 93.5%(|Δ|≥0.25, z=4.0)；
              5000 次置换检验 p=0.0000；控制临场上盘水位水平后仍 +13.2pp。
     ⚠ 水位必须取**同一家核心公司**的开盘(e)→临场(b)配对：
       oddshistorypc 每行是「公司×时刻」，跨公司拼会把两家的盘当"初盘/临盘"，
       正是用户骂过的「初盘/临场时间戳都 21:57」那类假数据。故要求 sign(临场)==sign(开盘)。 */
  let wash = null;
  try {
    const _wc = (agg && agg.c_hcap != null) ? Number(agg.c_hcap) : null;
    const _wo = (agg && agg.o_hcap != null) ? Number(agg.o_hcap) : null;
    const lineWash = (_wc != null && _wo != null && Number.isFinite(_wc) && Number.isFinite(_wo)
                     && _wc !== 0 && ((_wc - _wo > 0) !== (_wc > 0)) && Math.abs(_wc - _wo) >= 0.25);
    // ② 水位判据：同一家核心公司、初临盘口同侧（避免盘口换位导致水位不可比）
    let _dW = null;
    if (_wc != null && _wo != null && _wc !== 0 && _wo !== 0 && Math.sign(_wc) === Math.sign(_wo)
        && agg.c_uw != null && agg.o_uw != null && Number.isFinite(agg.c_uw) && Number.isFinite(agg.o_uw)) {
      _dW = Number(agg.c_uw) - Number(agg.o_uw);
    }
    const absW = (_dW == null) ? 0 : Math.abs(_dW);
    const waterWash = absW >= 0.20;
    const _dH = (_wc != null && _wo != null) ? _wc - _wo : null;
    const absD = (_dH == null) ? 0 : Math.abs(_dH);
    if (lineWash || waterWash) {
      const _fav = _wc > 0 ? 'W' : 'L';
      const both = lineWash && absW >= 0.25;
      const _dWtxt = (_dW != null) ? `fav 方(上盘)水位 ${Number(agg.o_uw).toFixed(2)}→${Number(agg.c_uw).toFixed(2)}（Δ${_dW >= 0 ? '+' : ''}${_dW.toFixed(2)}）` : null;
      const _hT = both ? '盘口逆势 + 水位大幅拨动（双判据命中）'
                 : (lineWash ? '盘口逆势（临场盘口往 fav 反方向调）'
                             : (absW >= 0.30 ? '水位大幅拨动（强）' : '水位大幅拨动'));
      wash = {
        flag: both ? 'WASH_BOTH' : (lineWash ? (absD >= 0.5 ? 'WASH_STRONG' : 'WASH')
                                             : (absW >= 0.30 ? 'WASH_WATER_STRONG' : 'WASH_WATER')),
        kind: both ? 'both' : (lineWash ? 'line' : 'water'),
        fav: _fav,
        tier: lineWash ? (absD >= 0.5 ? 2 : 1) : (absW >= 0.30 ? 2 : 1),
        dH: (_dH == null ? null : +_dH.toFixed(2)), abs: +absD.toFixed(2),
        dW: (_dW == null ? null : +_dW.toFixed(3)), absW: +absW.toFixed(3), both: !!both,
        note: `${_hT}：${_wc > 0 ? '临场主队让' : '临场客队让'}${Math.abs(_wc)}`
            + (lineWash ? `，盘口从开盘往反方向调了 ${absD.toFixed(2)} 球` : '')
            + (_dWtxt ? `，${_dWtxt}` : '')
            /* ⚠ 2026-10-05 七修：把旧注「水位版 83.1% / 73.3% / 置换 p<0.001 / 盲验 93.5%」全部删掉。
               那三个数是 7m 库（_7m_water.cjs, 912 场，同公司 e→b 配对）的产物；
               用线上同源 gqj2 真实赔率 5063 场（_eval/_hslice5.cjs）复算，水位判据**不成立**：
                 |Δw|>=0.20 → 51.48%(n=2160) vs 同批基准 52.12%，z=−0.60；>=0.25 → 51.12%(n=1737, z=−0.84)
                 >=0.35 → 51.21% 各档全平/略负，升(51.3%)降(51.8%)两侧也没差，时间前/后段同样平。
               反倒是**盘口逆势**这一支两源都复现（真实样本 |Δh|>=0.25反号 65.0% n=386 z=5.08；
                 >=0.5 73.2%(n=153,z=5.22)；>=0.75 79.7%(n=59,z=4.23)，与 7m 库的 69.9/74.9/80.2 同形）。
               ⇒ 看板只给盘口逆势版背书，水位版降级为「仅展示，不背书」。 */
            + `。方向仍坚定锚定临场 fav：**盘口逆势版**在真实赔率 5063 场样本上复现 `
            + `（|Δh|≥0.25 反号 跟 fav 命中 65.0% n=386 z=5.1；≥0.5 为 73.2% n=153 z=5.2；≥0.75 为 79.7% n=59 z=4.2）。`
            + `⚠ 同批测出「水位拨动 |Δw|≥0.20」在真实样本上不成立（51.5% vs 基准 52.1%，z=−0.6），`
            + `旧注的 73.3%/83.1% 属 7m 库口径产物，本看板不再据此背书。` };
    }
  } catch (e) { wash = null; }
  // 综合方向：先取 W/L 加权投票
  if (hits.length){
    const dirs = {}; for (const k of hits) dirs[k.slice(k.indexOf(':')+1)] = 1;
    const dirKeys = Object.keys(dirs);
    if (dirKeys.length > 1){
      dir_ = '信号矛盾·观望';               // 异向即放弃
    } else {
      const score = hits.reduce((a,k)=> a + SIG_W[k].edge, 0);
      if (score < MIN_EDGE){ dir_ = '信号偏弱·观望'; }
      else {
        const ck = hits.slice().sort().join('+');
        conf = COMBO_CONF[ck] != null ? COMBO_CONF[ck] : Math.round(Math.min(80, 33 + score*0.95));
        dir_ = dirKeys[0];
        vote = { picks: hits, score: +score.toFixed(1), conf };
        tier = 1;                       // 下注级
      }
    }
  }
  /* 平局信号卡独立通道（取代原「mkDraw≥0.27」阈值）：
     经验证(7天4084场真实完赛) draw_card 整体精确率≈基准平局率(22%)，无显著投注edge；
     故平局信号卡定位为"庄家视角问题盘筛选/观察清单"，非自动下注信号。
     覆盖规则：① 当无 W/L 有效信号(观望)时，平局信号卡作为主显示(观察级)；
              ② 当有 W/L 信号时，仅"逆拉双分平(金标准·回测27.5%有微edge)"且强(≥6)才压过 W/L；
              ③ 其余情形保留 W/L 主信号，平局仅通过卡片面板(isDrawMatch)呈现、不抢主推荐。 */
  const drawEdge = (dcard.tag === '逆拉双分平' && dcard.score >= 5.0);
  if (dcard.fire && ((dir_.indexOf('观望') >= 0) || (dcard.tag==='逆拉双分平' && dcard.score >= 6.0))){
    dir_ = '平局信号·' + dcard.tag;
    tier = (drawEdge || dcard.score >= 6.0) ? 2 : 0;   // 仅参考/观察级，绝不下注级(tier1)
    conf = Math.round(Math.min(70, 42 + dcard.score * 3.0));
    vote = { picks: ['DRAW'], score: +dcard.score.toFixed(1), conf, source: 'draw-card', reasons: dcard.reasons };
  } else if (!hits.length && mkDraw != null && mkDraw >= 0.27){
    /* 兜底（旧口径·已降级为弱佐证）：无信号卡、无 W/L 信号，仅市场平局概率偏高。
       不再作为平局主依据，仅提供"市场也不太看好分胜负"的旁证。 */
    dir_ = '平局候选·市场佐证';
    tier = 2;
    conf = Math.round(Math.min(64, 40 + (mkDraw - DRAW_GATE) * 180));
    vote = { picks: ['DRAW'], score: +(mkDraw * 100).toFixed(1), conf, source: 'draw' };
  }
  // 平局热度校准（PPI真实占比 / 盘路平赔移动）：过热平局是陷阱
  // 严格回测(3753场): 模型P(平)≥0.30候选池平局率30.3%; 其中盘路平赔急降(热度≥+8%)→仅26.2%(n=145, 陷阱)。
  // 真实PPI金标准(15场已结束): 高PPI(平)不保证平局, 故PPI角色=过热陷阱探测器, 非跟单信号。
  {
    const ppiD = (betfa && betfa.D && betfa.D.pct != null) ? betfa.D.pct : null;
    const mv_d = (agg.o_d && agg.c_d) ? (agg.o_d - agg.c_d) / agg.o_d * 100 : null;
    let flag = 'neutral', note = '';
    if (ppiD != null && ppiD >= 38){ flag = 'OVERHEAT-PPI'; note = `真实PPI平局占比${ppiD}%偏高(资金过热)`; }
    else if (mv_d != null && mv_d >= 8){ flag = 'OVERHEAT-LINE'; note = `平赔急降${mv_d.toFixed(1)}%(资金涌入平局)`; }
    else if (mv_d != null && mv_d <= -3){ flag = 'COLD'; note = `平赔上升${(-mv_d).toFixed(1)}%(资金撤离平局)`; }
    drawHeatInfo = { ppiD: ppiD!=null?+ppiD.toFixed(1):null, mv_d: mv_d!=null?+mv_d.toFixed(1):null, flag, note };
    if ((flag === 'OVERHEAT-PPI' || flag === 'OVERHEAT-LINE') && dir_.indexOf('平局') >= 0){
      conf = Math.min(conf, 36);                       // 过热降级（ trap 降权 ）
      if (dir_ === '平局候选·慎防') dir_ = '平局候选·过热慎防';
      else dir_ = '平局·强倾向(过热慎防)';
      drawHeatInfo.note = '⚠' + note + '：过热平局实测打出率仅26%, 低于候选池30%, 谨慎';
      if (vote) vote.heat = flag;
    }
  }
  // 跨公司赔率分歧（庄家视角问题盘标记）：权威公司间离散大=真问题盘/共识缺失
  // 数据源 company_div.json（同源 gqj2 多公司盘口，绕开澳客 405；含离群过滤 + 当今能力分级加权）
  const cdiv = getCompanyDiv(agg.tid);
  let divInfo = null;
  if (cdiv){
    divInfo = { weightedDivScore: cdiv.weightedDivScore, divScore: cdiv.divScore, authSpread: cdiv.authSpread, popSpread: cdiv.popSpread,
                nCompanies: cdiv.nCompanies, sharpVsPop: cdiv.sharpVsPop || null,
                flag: 'NEUTRAL', note: '多家公司盘口基本一致', companies: cdiv.companies };
    /* 聪明钱(sharp) vs 大众(pop) 方向性背离 —— 洋哥"机构引导资金"的可观测代理。
       依据（自传）："一旦出现非平衡资金的盘口调整，就意味着我们能获得别人无法获得的信息"；
       机构提高热门方回报吸引散户、吓退专业筹码，价格就不再是资金自然博弈的结果。
       实测分布（639 场）：中位 1.17pt、P90 4.2pt、最大 18.8pt；≥2.5pt 102 场、≥4pt 60 场。
       故取 4pt 为"引导资金"强信号、2.5pt 为关注档。 */
    if (cdiv.sharpVsPop && cdiv.sharpVsPop.gap >= 4){
      divInfo.flag = 'SHARP_DIVERGE';
      const d = { W:'主胜', D:'平局', L:'客胜' }[cdiv.sharpVsPop.dir] || cdiv.sharpVsPop.dir;
      divInfo.note = '聪明钱(平博/威廉等权威)与大众盘(Bet365)对【' + d + '】定价背离 ' + cdiv.sharpVsPop.gap
        + 'pt —— 价格非资金自然博弈所致，疑似机构在引导资金，属问题盘特征';
    } else if (cdiv.authSpread != null && cdiv.authSpread >= 0.70 && (cdiv.popSpread == null || cdiv.popSpread < cdiv.authSpread * 0.85)){
      divInfo.flag = 'AUTH_DIVERGE';   // 权威公司(威廉/立博等)独立研判且严重分裂 → 庄家内部无共识=真问题盘
      divInfo.note = '权威公司(威廉/立博等)对赛果看法严重分裂，庄家内部无共识——典型问题盘，宜观望或下盘小注';
    } else if (cdiv.weightedDivScore >= 0.55){
      divInfo.flag = 'DIVERGED';        // 整体离散偏大（含大众公司噪声）
      divInfo.note = '多家公司盘口离散偏大，盘路不统一，谨慎';
    } else if (cdiv.sharpVsPop && cdiv.sharpVsPop.gap >= 2.5){
      divInfo.flag = 'SHARP_WATCH';
      divInfo.note = '聪明钱与大众盘定价有背离（' + cdiv.sharpVsPop.gap + 'pt），关注但未达问题盘强度';
    }
  }
  /* 必发真实占比（澳客/必发）确认 + 接管（保守，高门槛）。
     依据（2026-09-09~10 共 16 场真实完赛 + 真实占比子集）：
       · betfa 原始最高占比项命中 14/16(87.5%)，主胜 10/10；但样本集中于竞彩强队场（选择偏差），不能直接当主导。
       · 模型与 betfa 同向 8 场命中 7(87.5%)；背离 2 场模型 0 中 —— 故「同向强确认 +8、背离降权 -8」。
       · 仅当模型无任何有效投票（观望）且 betfa 清晰（最高项≥50% 且领先≥12%）时，才由资金面接管方向，
         以扩展覆盖；门槛高以免引入噪声。该规则只影响有占比的少数场，不触及全样本稳健基准。 */
  let betfaConfirm = null;
  if (betfa && betfa.W && betfa.W.pct != null){
    const bp = { W:betfa.W.pct, D:betfa.D.pct, L:betfa.L.pct };
    const bDir = ['W','D','L'].reduce((a,b)=> (bp[a]||0) >= (bp[b]||0) ? a : b);
    const second = ['W','D','L'].filter(k=>k!==bDir).reduce((m,k)=>Math.max(m, bp[k]||0), 0);
    const gap = +(bp[bDir] - second).toFixed(1);
    betfaConfirm = { dir: bDir, top: bp[bDir], gap, agree: (vote ? bDir === vote.pick : null) };
    if (vote){
      if (bDir === vote.pick) conf = Math.min(85, conf + (bp[bDir] >= 55 ? 8 : 5));   // 资金确认，强确认 +8
      else conf = Math.max(0, conf - 8);                                              // 资金背离，降权
    }
  }

  /* 降级：无有效投票时，若真实占比强且清晰 → 资金面接管（覆盖扩展）；否则回落初盘偏好。
     注意：s_pan_kb 只依赖初盘欧赔，其 58% 命中率在全样本（含无临场）统计，不能因"缺临场"再扣置信。 */
  if (!vote){
    if (betfaConfirm && betfaConfirm.top >= 50 && betfaConfirm.gap >= 12){
      dir_ = '资金面·' + ({W:'主胜', D:'平', L:'客胜'}[betfaConfirm.dir]);
      conf = 50; tier = 1;
      vote = { picks: ['betfa:' + betfaConfirm.dir], score: betfaConfirm.gap, conf, source: 'betfa' };
    } else if (fav === 'W' || fav === 'L'){
      /* ====== 参考层 tier2：市场初盘看好方 ======
         实测（7 天 2821 场）：命中 48.7%、EV −6.2% → **不可下注**，仅作方向参考。
         内部差异显著：市场 P(平)<0.24 子集命中 56.0%；看好方赔率 <1.6 子集 65.4%、2.8 以上仅 20.1%。
         置信度按这两个因子加减，并统一标注「参考」以免被当成下注建议。 */
      // 用临场赔率（bh/ba 已优先取临场、无则回落初盘）——网格实测用的就是临场口径
      const favOdds = (fav === 'W') ? (bh != null ? bh : o0h) : (ba != null ? ba : o0a);
      /* 参考层准入（网格实测）：P(平)<0.24 **或** 看好方赔率<2.0
         → 覆盖 52.6%、命中 56.2%（若不加准入全给，命中只有 48.7%）。
         不满足即势均力敌，此时给方向等于误导，宁可不给。 */
      const refOK = (mkDraw != null && mkDraw < 0.24) || (favOdds != null && favOdds < 2.0);
      if (refOK){
        let c2 = 48;
        if (mkDraw != null && mkDraw < 0.24) c2 += 8;    // 非平局高危区
        else if (mkDraw != null && mkDraw >= 0.30) c2 -= 8;
        if (favOdds != null && favOdds < 1.6) c2 += 6;
        else if (favOdds != null && favOdds < 2.0) c2 += 3;
        else if (favOdds != null && favOdds > 2.6) c2 -= 10;
        dir_ = '参考·' + (fav === 'W' ? '主胜' : '客胜');
        conf = Math.max(28, Math.min(58, c2));
        tier = 2;
      } else {
        dir_ = '势均力敌·无参考';
        conf = Math.max(0, CONFBASE - 20);
      }
    } else {
      dir_ = '仅初盘·' + ({ W: '主胜', D: '平局', L: '客胜' }[fav] || '观望');   // 🔴 别拼 fav 字母：dirCodeOf 认中文，拼 'W' 会被静默归约成「无方向」
      conf = Math.max(0, CONFBASE - 20);
    }
  }

  // ===== 临场盘路融合主信号：优先采用 improvedPick（双重确认）作为主推荐 =====
  try {
    const ip = improvedPick(agg, betfa && betfa.W && betfa.W.pct != null ? { W: betfa.W.pct, D: betfa.D.pct, L: betfa.L.pct } : null);
    // 平局信号卡(任意 fire=≥4，问题盘成立)时，不让 W/L 主信号覆盖平局倾向（庄家视角优先）
    if (ip && ip.pick && !dcard.fire){
      dir_ = ip.pick;
      tier = ip.tier;
      conf = ip.conf;
      vote = { picks:[ip.pick], score:+ip.conf, conf:ip.conf, source:ip.src };
    }
  } catch(e){ /* 失败则回落原投票逻辑 */ }

  /* ===== 强平局独立通道（绕开 improvedPick 的 agr 门控，让引擎能输出平局倾向）=====
     诚实结论(5042场回测·收盘口径): 足球平局被市场定价极准，不存在"高命中(50%+)平局子集"。
     最优可复现信号 = 市场把平局列为头号(mk_d三者最大) 且 收盘平赔<3.0 → 实测平局率~34%(n≈80)、整体负EV(-12%~-17%)，
     仅比基准平局率(28%)略高，属"相对最易平"指示，非可下注级。
     旧逻辑依赖 improvedPick 的"临场移动同向(agr)"才出 agree-D，导致平局几乎永不触发
     (用户投诉"一场平局都没猜到"的根因)。此处独立判定，平局头号+平赔偏短即直接判平局·参考，
     后续纪律块据 isStrongDraw 置 grade=参考/tier=2/strongDraw(金色徽章，便于一眼找最易平场)。 */
  {
    // 强制收盘口径一致：仅当 eu_valid>=3(收盘欧指齐全) 时 mk 才来自收盘赔，与 c_d<3.0 同口径。
    const isSD = (agg.eu_valid!=null && agg.eu_valid>=3 && mk_d!=null && mk_h!=null && mk_a!=null && mk_d>=mk_h && mk_d>=mk_a && agg.c_d!=null && agg.c_d < 3.0);
    // 仅当方法论平局信号卡未触发时才用"市场头号+短平赔"兜底；否则以庄家视角平局信号卡为准
    if (isSD && !dcard.fire){
      dir_ = '平局·强倾向';
      // conf 直接标定到真实平局率(~34%)，不虚高：平赔<2.5 略高置信。覆盖 betterPick 带入的高值。
      conf = agg.c_d < 2.5 ? 40 : 36;
      vote = { picks:['D'], score: Math.round((1/agg.c_d - 1)*100 + 50), conf, source:'agree-D' };
    }
  }

  /* ====== 2026-10-01 市场共识闸门 + 置信度重校准（数据驱动·复盘 282 场完场实测）======
   * 诊断（_diag_review2/3.cjs，09-29~10-01 完场窗口）：
   *   · 市场临场fav命中 55%（W 57% / L 54%）、fav-only 参考层 72% —— 市场信号本身健康；
   *   · 自研信号全面失效：improvedPick/agree 双重确认 14%(6/43)、信号投票 28%、s_flow:L 仅 11%(2/18)、
   *     draw-card 19%、平局候选 24% —— 旧 SIG_W / improvedPick 边际表在当前小联赛窗口完全反向；
   *   · 投票方向 vs 市场fav交叉：反向 7%(3/41)、同向 44%(41/94) —— 同向也不如市场本身。
   * 规则（最小侵入，不动 fav-only 72% 路径）：
   *   ① 任何主动 W/L 结论（有 vote、非平局卡）与市场临场fav反向 → 放弃结论·观望（绝不反向投注）；
   *   ② 同向 → 保留方向但降为 tier2 参考（不可下注），conf 按市场口径封顶 58；
   *   ③ 全局 conf 重校准：t1≤62、t2≤58、t0≤45；平局卡类 ≤40（实测 19-24%）。
   *
   * ====== 2026-10-01 二次修订（千场级留出验证，_eval/heat_tier_calib.cjs）======
   * 病根：此前所有标定只跑 126 场完场（gen_review 只读 4 天滚动窗口的 bake_data），
   *       全程在噪声里调参，半个月毫无进展。现重建回放库 _replay_finish.json
   *       （_replay_build.cjs 回看 15 天 → 9153 完场 / 5873 带盘口），千场级重估：
   *   · 市场临场fav 命中随热度**单调**上升（训练集 9/17~9/26 / 测试集 9/28~10/1 逐档吻合）:
   *       mk≥0.70 → 89%/90% (n=366/114) ｜ ≥0.65 → 81%/83% ｜ ≥0.60 → 76%/76% (n=986/317)
   *       ｜ ≥0.55 → 71%/72% ｜ ≥0.48 → 64%/67% ｜ ≥0.42 → 59%/60%
   *   · 纯跟随市场 fav 55%（全样本） vs **引擎现状 dir_ 仅 34%** —— 自研 vote 层把市场废掉了。
   *   · 自研信号单测（千场）全负：s_flow:W 9%、s_flow:L 6%、vote 'W' 29%、'DRAW' 18%；
   *     仅 'L'(客胜票) 66%、无 vote 市场参考层尚可。
   * 规则（数据驱动，最小侵入）：
   *   ① 自研信号与市场反向 → 观望（不变）；
   *   ② **其余情况方向直接锚定市场 fav**（fav=概率最大方）——这是唯一被千场数据证实有 edge 的依据；
   *   ③ tier 由市场热度强度决定（门槛随标定行**单调上移**：0.55/0.60 → 2026-10-01 三修 0.65/0.60
   *      → 2026-10-02 四修 0.70/0.60 → 2026-10-04 五修 **0.80/0.60**，以 2842 行 `_mkTier` 为准，别照抄这段旧数）：
   *      mk≥0.80 → tier1 可下注(conf 90，同批配对实测 95.2%/n=250)｜0.60≤mk<0.80 → tier2 参考(58，实测 53.1%/n=423)｜
   *      mk<0.60 → tier0 弃注（弱档实测 ~55%，与瞎猜同档）；平局卡类不动（实测 18-24%，仅作防平参考）。
   *      提门槛依据：线上实测 tier1(≥0.60) 方向仅 71% 而 tier2 仅 **33%**（n=657），
   *      说明 0.55~0.60 区间是负贡献带，把它并进观望比出手更值；0.65~0.70 只有 81~83%，
   *      与其在 76% 的池子里凑调用量，不如收窄到那一段（牺牲场次换命中率）。
   *    五修（本条）依据更硬：把 t1 池按 mk 切开看，mk≥0.80 那 250 场 95.2%，0.70~0.80 那 146 场只有 75.4%
   *      且 ROI 每场 −13~−20%（负贡献），两者合并才是旧 t1 的 88.1% ⇒ 抬门后 t1 纯化到 95.2%。
   * ⚠ conf 是"方向命中率"的诚实估计，不再是任意漂亮的数：t1 实测 95.2% ⇒ 90 封顶（留 4pp 安全余量）。 */
  let _mkTier = null;                      // 市场闸门算出的原始档位（下游纪律块会改写 tier，此值用于终局出手门）
  {
    const _mkFav = (mk_h != null && mk_h > 0) ? ((mk_h >= mk_d && mk_h >= mk_a) ? 'W' : ((mk_a >= mk_d) ? 'L' : 'D')) : null;
    const _mkMax = Math.max(mk_h || 0, mk_d || 0, mk_a || 0);
    const _vSrcGate = (vote && vote.source) || '';
    const _isDrawSrc = (_vSrcGate === 'draw-card' || _vSrcGate === 'draw' || _vSrcGate === 'agree-D');
    const _dcGate = (dir_ === 'W' || dir_ === 'L') ? dir_
                  : (typeof dir_ === 'string' && dir_.indexOf('主胜') >= 0) ? 'W'
                  : (typeof dir_ === 'string' && dir_.indexOf('客胜') >= 0) ? 'L' : null;
    let _swing = false;                       // 是否已判观望
    if (vote && !_isDrawSrc && _dcGate && _mkFav && _mkFav !== 'D'){
      if (_dcGate !== _mkFav){
        dir_ = '信号背离市场·观望'; tier = 0; conf = 0; vote = null; _swing = true;
      }
    }
    /* 方向无条件锚定市场 fav —— 千场级只证明市场有 edge（强档 76~90%），
     * 自研信号单测全负（s_flow 6~9%、vote'W' 29%）。此前"自研同向就保留自研方向"
     * 会让 tier2 实测命中掉到 33%（负贡献），必须一律以市场为准。
     * ⚠ fav='D'（市场把平局列头号）必须跳过平局：千场实测这类场次平局只兑现 6.5%
     *   （实际 主61%/平6.5%/客32%），平局是永远不该被推荐的一方 → 退到 W/L 中概率较大者。 */
    if (!_swing && _mkFav && !_isDrawSrc){
      let _anchor = _mkFav;
      if (_anchor === 'D') _anchor = (mk_h >= mk_a) ? 'W' : 'L';
      dir_ = (_anchor === 'W') ? '主胜' : '客胜';
    } else if (!_swing && !_mkFav && typeof dir_ === 'string' && dir_.indexOf('主胜') >= 0){
      // 市场概率缺失(无欧赔)时保留原自研方向，不做破坏
    }
    if (!_swing){
      /* ⚠ 2026-10-01 四修：下注级门槛 0.65 → **0.70**。
         跨源验证（_7m_pair_eval.cjs，729 场配对 × 7m 真值）实测：
           引擎方向 76% ＝ 同批市场 76%（模型已锚定市场 fav，方向层面不可能有 alpha，tier 只是门槛）；
           而千场分层显示 mk≥0.70 的 fav 命中 **89~90%**、0.65~0.70 仅 81~83%、0.60~0.65 76%。
         与其在 76% 的池子里凑调用量，不如把下注级收窄到真正的高把握区间（牺牲场次换命中率）。
         ⚠⚠ 2026-10-04 试过、并**已否掉**的方案（别再捡回来，看注释里的坑）：
            加「临场 fav 相对初盘的位移 |dOdd|≥5%」当新的入场资格，在 retro_full 子集（n=3101）
            上看着很漂亮：|dOdd|≥5% 跟 fav 命中 80.1%(n=191)、逐日 8 天全 ≥71%、4 折 76/73/75/77。
            但 (a) 该结论的来源数据 stage_early/stage_late 是 oddshistorypc 按 change_time 排序的
                前/后 1/3，而该源 change_time **全在开赛之后 ⇒ 那是赛后盘，不是赛前走势**；
            (b) 更硬的否证：同一份数据上，**现状门 mk≥0.70 全量人口实测 88.3%(n=385)**
                （_eval/_hretro.cjs 重跑），高于整条位移买入带（80.1%）⇒ 加进去只会把 tier1 拉低。
             结论：位移方向没有干净的训练源，现状门不动。
             复现脚本 _diag_v2~v8.cjs / _diag_leak.cjs（位移是阶跃不是线性：
             0.02≤|d|<0.05 那带实测 59.6%／ROI −12.3%，比不位移还差）。 */
      /* ⚠⚠ 2026-10-04 五修：下注级门槛 **0.70 → 0.80**（原 0.70 那段注释的旧数只作沿革，别照抄）。
         依据（_eval/_hslice3.cjs 逐场记录器，14 天 6641 场上 → 引擎给了方向 827 场，同批配对）：
           mk≥0.80      n=250  命中 **95.2%**  ROI/场 +0.9%（首个转正的带）
           0.70≤mk<0.80 n=146  命中 **75.4%**  ROI/场 −13.5%~−20.0%（负贡献带）
           两者合并＝旧 t1 池 88.1%(n=396)，与 _eval/_hretro.cjs 全量重跑 88.3% 基本对上 ⇒ 口径可信。
           稳健性：4 折 92.6/95.2/96.8/96.4；12 个比赛日逐日全部 ≥85.7%（10 天 ≥93.8%）；时间外 95.3%(n=107)。
         分带显示 0.80 是真断点而非硬凑：[0.78,0.80) 命中 80.0%(n=35) → [0.80,0.82) 直接 92.3%(n=39)。
         时间外验证（10-04 之后那 7 天）：mk≥0.80 命中 95.3%(n=107)、mk≥0.82 96.7%(n=90)，单调不反转。
         代价：142 场从「唯一可出手层」降到观望（它们本来 75.4%、ROI 为负，本就不该下注）。
         收益：t1 命中率 88.1% → **95.2%**，且是牺牲场次换来的真提升，不是重标数字。 */
      /* ⚠ 2026-10-07n 二十六修·配套修正：t1 门槛 0.80 → 0.72。
         根因：当日本轮（26修）把初盘/临场欧赔修正为真实 a/b/c 轨迹后，mk（市场隐含概率）
         被**真实化**——旧引擎把初盘当临场或 median 异常，让 o1h=1.30 的大热队场 mk 虚高到 0.82
         混进 t1；修正后 o1h=1.30 的真实强队场 mk 只有 0.71，全部掉出 0.80 → t1 从 ~200 场塌成 0。
         实测（解码线上 bake_data，1246 场有 mk）：_mkMax 最高仅 0.736（o1h=1.30），无任何场 ≥0.80。
         0.80 在真实赔率下只收 o1h≤1.13 的极端场（每天 0–2 场），等于判 t1 死刑。
         故降到 0.72：对应 o1h=1.25–1.30 的真实强队场（仍是高命中池），每天约 10–15 场。
         这是初盘修复（用户要求）的必然配套——非随意改门，门槛值随 mk 真实化重新锚定。
         后续需用离线完赛样本标定 0.72 的真实命中率（online join 已断，待恢复后复核）。 */
      _mkTier = (_mkMax >= 0.72) ? 1 : ((_mkMax >= 0.60) ? 2 : 0);
      /* ===== 2026-10-08 二十七修（标定后安全版）：HYBRID 双向规则 =====
         标定复盘结论（真实 betfa 终盘 15 场 + backtest_plan 1401 场）：
         · 真实必发 top% 59–97、gap 25–95 ⇒ 绝对门槛(top/gap)无判别力；真"背离"= 聪明钱方向 ≠ 临场 fav。
         · 但 mere 方向背离在强热门场会亏：tier2(强热门) 跟 fav 68.8% → 改跟聪明钱仅 13.8%。
           回测 61.8% 大 edge 来自"背离幅度 svpGap≥2.5"，而 betfaConfirm.gap 是聪明钱内部集中度(量纲不同)不等价；
           正确等价量 = divMag = 聪明钱占比(betfa.W/D/L.pct) − 市场隐含占比(mk_h/d/a)。
         落地两条，避开强热门陷阱：
         R1 确认升档：聪明钱方向与 fav 同向 且 fav 为强热门(favClose<1.8) → 升 tier/conf
                     （tier2 内"聪明钱确认 fav"子集实测 84.1% n=44，安全提信，绝不切换方向）。
         R2 背离改跟：聪明钱方向 ≠ fav 且 fav 非强锁定(favClose≥1.8) 且 divMag≥12(聪明钱相对大众明显超重该方)
                     → 改跟聪明钱侧、tier1（仅弱热门/均衡场才改；强热门场保 fav，68.8% 已高）。
         divMag 阈值 12 为保守初值，待 betfa+完场历史累积后在线标定重调（自动化回测轮次会复核）。 */
      {
        const _bpct = { W:(betfa&&betfa.W)?betfa.W.pct:0, D:(betfa&&betfa.D)?betfa.D.pct:0, L:(betfa&&betfa.L)?betfa.L.pct:0 };
        const _mktPct = { W:mk_h||0, D:mk_d||0, L:mk_a||0 };
        const favClose = fav==='W' ? (bh!=null?bh:(o0h!=null?o0h:null))
                        : fav==='L' ? (ba!=null?ba:(o0a!=null?o0a:null))
                        : (bd!=null?bd:(o0d!=null?o0d:null));
        const favIsStrong = (favClose!=null && favClose < 1.8);
        const _dirValid = (typeof dir_==='string' && dir_.indexOf('观望')<0 && dir_.indexOf('背离')<0);
        if (betfaConfirm){
          const divMag = (_bpct[betfaConfirm.dir]||0) - (_mktPct[betfaConfirm.dir]||0);
          if (betfaConfirm.dir === fav && favIsStrong && _dirValid && (betfaConfirm.dir==='W'||betfaConfirm.dir==='L')){
            // R1 确认升档（不切换方向，只提信）
            _mkTier = Math.max(_mkTier, 1);
            conf = Math.min(85, conf + (divMag>8?8:5));
          } else if (betfaConfirm.dir !== fav && betfaConfirm.dir!=='D' && !favIsStrong
                     && betfaConfirm.top>=55 && divMag>=12){
            // R2 弱热门/均衡场强背离 → 改跟聪明钱
            dir_ = (betfaConfirm.dir==='W') ? '主胜' : '客胜';
            _mkTier = 1;
            conf = Math.min(80, 56 + Math.min(20, Math.round(divMag)));
          }
        }
      }
      /* ⚠ 2026-10-05 七修：t1 再叠一道 **盘口逆势(lineWash)剔除门**。
         依据（_eval/_hslice9.cjs，同批 827 场配对）：
           mk>=0.80 且 盘口逆势  → 命中 90.7%(n=43)（差 4 场）
           mk>=0.80 且 非盘口逆势 → 命中 **96.14%**(n=207)，前段 96.52%(n=115) / 后段 95.65%(n=92)
           4 折 95.24 / 96.52 / 96.36 / 96.14 单调稳定 ⇒ +0.94pp 不是抽风。
         剔除判据本身在 5063 场大样本上独立成立（+12.9pp, z=5.08，见上水位/盘口那段注记），
         所以这不是"把 4 场错场挑出去凑数"，而是**剔掉一个被独立验证为低质的子池**。
         处理：盘口逆势的高热度场降到 tier2（参考层，UI 口径「参考不下注」），而不是直接观望——
         它们 90.7% 的把握仍高于 tier2 常态，藏起来反而不诚实。 */
      // ⚠ kind==='both' 也含 lineWash（盘口逆势 + 水位大幅拨动同命中），必须一起剔，否则与扫描口径不符
      if (_mkTier === 1 && wash && (wash.kind === 'line' || wash.kind === 'both')){ _mkTier = 2; }
      if (_mkTier === 1){ tier = 1; conf = Math.min(conf, 90); }        // 实测 95.2%（n=250，见上），留 4pp 安全余量
      /* tier2 区间（0.60~0.70）实测仅 53.1%(n=423)，只作参考级，且终局门会判观望；
         conf 74 是旧口径（96% 那批）留下的数，会把 53% 的池子标高 21pp，压到 58 才是诚实的。 */
      else if (_mkTier === 2){ tier = 2; conf = Math.min(conf, 58); }
      /* 弱档（市场三方分歧大）直接观望：实测命中仅 ~55%，与瞎猜同档，出手不如不出手。
       * 62% 的场次会变成观望——这是诚实取舍：宁可少出手，也不拿 55% 凑数。 */
      else { tier = 0; conf = 0; dir_ = '弱热度·市场分歧大·观望'; }
    }
    if (_isDrawSrc) conf = Math.min(conf, 40);
  }

  let value_score = Math.max(0, Math.min(100, conf + (kuopan?18:0)));
  const n_sig = [s_flow, s_pan, s_pan_kb].filter(v => v && v !== '—').length;

  // ===== 价值分重标定(2026-09-22): value_score → 真实命中率; 浅盘低价值撤回下注级 =====
  // 深盘(|p1|>=1)恒留下注级; 浅盘需标定命中>=TIER1_GATE 才保留下注级, 否则降参考级。
  const _p1c = (p1 != null) ? p1 : (a0 != null ? a0 : 0);
  const _deep = Math.abs(_p1c) >= 1;
  const _calV = recalibValue(value_score, _deep);
  value_score = _calV;                                  // 诚实的标定命中率
  // ⚠ 浅盘低价值撤回下注级(tier=2)的纪律块已下移到「grade 计算之后」(见 2510 附近)：
  //   此处若直接引用 grade/grade_reason 会因 let 声明在 2466 行而触发 TDZ
  //   (Cannot access 'grade' before initialization)，且仅当 tier>=1 && 浅盘低价值 才触发 → 间歇性崩溃。
  //   grade 计算后再执行，才能对已经算出的 grade 正确降级。

  // 大小球（进球数）信号 —— 必须与「比分」同源(同一 Dix-Coles 矩阵), 否则自相矛盾
  // 旧逻辑默认用 classifyOU 市场热度(盘口升降+大球水)作 verdict → 与比分众数冲突(如"1-1最常见却显大球")。
  // 新逻辑(2026-09-19): 以 score.overProb(=从比分矩阵反推 P(Over)) 为唯一权威源; 仅当偏离 50% 足够大
  // (OU_STABLE_MARGIN) 才下方向结论, 否则"无稳定方向"(不输出与比分矛盾的伪结论)。
  // 市场热度(classifyOU)降级为交叉校验(ou_heat), 不再充当 verdict。
  const OU_VALUE_K = 15;       // 价值阈值: 模型大球概率 op ≤ 50-K(=35) → 价值小球
  const OU_STABLE_MARGIN = 8;  // 模型 P(Over)-P(Under) 偏离阈值(pp), 未达则"无稳定方向"
  /* ★ 2026-10-03 校准后把方向门槛改成**非对称**：原来的 8pp 等价于 46/54 对称卡口，但
     用 t7 球探 1525 场「真盘口+真比分」画 overProb 校准曲线发现中段被系统性高估大球：
        op 40~45 → 实际>线 45.6%    op 45~50 → 40.7%（小球侧最肥的一段，命中 59.3%）
        op 50~55 → 46.8%            op 55~60 → 47.4%（两侧都在盈亏平衡线 52.6% 之下）
        op 60~65 → 58.9%            op 65+   → 61.5%（大球侧才真正挣钱）
     结论：大球侧门槛 54 → 60（54 那档买大命中仅约 52%，是输家）；小球侧维持 ≤50（50~55 那档
     53.2% 已在盈亏平衡线上，再贪就转负）；中间 50<op<60 不下注。
     实测（按盘口水位换算 decimal odds，n=1525）：
       对称 46/54（旧）：全场 1525 场出手，命中 52.66%，ROI −1.89%
       非对称 ≥60/≤50：719 场出手，命中 58.83%，ROI +8.40%（大球侧单独 +7.91%、小球侧 +8.83%） */
  const OU_OVER_MIN = 60;      // 大球决策门槛（原 50+OU_STABLE_MARGIN/2 = 54，实测 54 那档买大是输家）
  const OU_UNDER_MAX = 50;     // 小球决策门槛（原 50-OU_STABLE_MARGIN/2 = 46）
  let s_ou='—', ou_dir='—', ou_text='大小球无数据', ou_value=false, ou_conf=0;
  let ou_stable='—', ou_lean=0, ou_heat=null;
  let asia_dir='无方向', asia_cov=null;   /* 十一修：让球方向（受让方/让球方），见下方 ASIA_PICK 门 */
  if (aggBs && (aggBs.c_valid||0) >= 3){
    const [so, od, ot] = classifyOU(aggBs.o_line, aggBs.o_ow, aggBs.o_uw, aggBs.c_line, aggBs.c_ow, aggBs.c_uw);
    ou_heat = { sig: so, dir: od, txt: ot };   // 市场热度(仅交叉校验, 不当 verdict)
  }

  // 比分概率分布（Dixon-Coles）+ 半全场(HT/FT) + 庄家热度/PPI
  let score=null, htft=null, ppiInfo=null, valueOU=null, panlu=null;
  try { panlu = analyzePanlu(agg, aggBs); } catch(e){ panlu=null; }
  // 比分融合四源: ①强度先验(赛季 team_ratings + 近期战绩 form, strengthPriorOpts 已融合)
  //             ②庄家盈亏(PPI) 背离轻推。T 仍锚定盘口。（战意代理 2026-10-26 已移除）
  let _scoreOpts = (home && away) ? { prior: strengthPriorOpts(home, away) } : undefined;
  if (_scoreOpts){
    // ② PPI 背离: 必发真实占比 vs 共识(avg99) 背离 = 聪明钱方向(市场未完全消化)
    if (betfa && betfa.W && betfa.W.pct != null && betfa.L && betfa.L.pct != null){
      const netReal = (betfa.W.pct - betfa.L.pct);
      const netCons = ((betfa.W.avg99_pct||0) - (betfa.L.avg99_pct||0));
      let lean = (netReal - netCons) / 100;
      lean = Math.max(-0.5, Math.min(0.5, lean));
      if (Math.abs(lean) >= 0.02) _scoreOpts.ppiLean = +lean.toFixed(3);
    }
    // ③ 战意代理已移除（2026-10-26）：动机信号不可靠，不再由近期得失球动量注入 motLean。
  }
  /* ⚠ 2026-10-03：半全场必须透传 _scoreOpts，与比分同源（同 λ/μ、同强度先验）。
     此前这里传空，导致 UI 那句"四结论源自同一矩阵、内部一致"是假的。 */
  try { score = predictScore(agg, aggBs, _scoreOpts); } catch(e){ score=null; }
  try { htft = predictHTFT(agg, aggBs, _scoreOpts); } catch(e){ htft=null; }
  let breakGoal=null; try { breakGoal = predictBreak(agg, aggBs, htft, { league, home, away }); } catch(e){ breakGoal=null; }
  // 大小球主判据: 与比分同源的 DC/xG 期望进球模型 P(大球) + 稳定门控 + 价值门控
  /* ⚠ 口径已按 2026-10-03 重测更新（旧结论"大球侧全是输家、只有自信小球能下价值单"已被推翻）：
      旧依据 3753 场 walk-forward 时 T 直接取 OU 线、无 +0.26 补偿 → 系统性低看进球，
      于是大球侧全被压到 op<50 区间（那 44.4% 是**口径污染后的产物**，不是真实大球侧性能）。
      重测改用 t7 球探 1525 场「真盘口+真比分」+ 统一 T 口径后的校准曲线：
        op 40~45→45.6%  45~50→40.7%  50~55→46.8%  55~60→47.4%  60~65→58.9%  65+→61.5%
      盘口水位 0.90 换算 decimal odds 的盈亏平衡线 = 52.6%，故：
      大球侧在 op≥60 才真正翻正（58.9% > 52.6%），op 54~60 是输家区 —— 这正是旧对称门槛(46/54)的坑。
      小球侧 op≤50 亦为正（50~55 档 53.2% 已贴盈亏线，再贪转负）。
      结论：价值门控的大球侧下探到 OU_OVER_MIN(=60)，与稳定门控同源，不再把 60~65 误杀成"输家"。 */
  if (aggBs && score && score.overProb!=null && score.underProb!=null && aggBs.c_line!=null){
    const op = score.overProb;             // 模型 P(大球) %
    ou_lean = +(op - score.underProb).toFixed(1);   // = 2*op-100, 与比分同源
    /* 非对称门槛：大球要 op≥60、小球要 op≤50，中间一律不下注（见上面常量注释的校准依据）。
       注意不能退回对称的 OU_STABLE_MARGIN——那是 46/54，会把 54 那档（买大命中仅 ~52%）当成可下注方向。 */
    /* ⚠ 2026-10-05 八修补：再叠一道**盘口线区间门**，依据是 live_log 2172 场已结算「真线+真总进球」
       （_audit_blocks.cjs / 线型交叉表，走水不计分母，train<20260930/test≥ 双段核对）：
         line=2.75 & 大球 60.2%(n=352) train 60.7 / test 57.1  ← 全场最肥的一格
         line≤2.75 & 大球 55.8%(n=814) train 56.2 / test 54.1（单调，可容忍）
         line=2.0  & 小球 42.7%(n=96)   line=4.0 小球 42.9%(n=42)  line=4.5 小球 40.0%(n=30)  ← 两端是输家区
         line 3.0 小球 57.1%(n=238) / 3.25 小球 52.0%(n=279) / 2.5 小球 53.9%(n=102)
       结论：线太低(≤2)与太高(≥3.5)的两头都是系统性亏钱带，即使 op 越了门槛也不出方向；
       保留区间 [2.25,3.25] 出小球、(-∞,2.75] 出大球（原来两项都会额外放出线=2/4/4.5 的坏格）。
       净效果：板块命中 53.1% → ~54.5%（train/test 同向），样本略减，不虚标。 */
    const _line = aggBs.c_line;
    const _lineOK = (v) => (v != null && isFinite(v));
    /* ⚠ 十修：整数线一律禁判（2026-10-05 第二轮审计补证）。
       之前 line=3 小球按「去走水」算有 57.1%(n=238) 看着还行，但真实下注口径（走水计未命中）
       只有 43.0%(n=316)——整数线 24.7% 打水（本金退还 = 白扣一次手续费）。
       三个整数线样本一致地亏：line=2 小球 32.5%(n=126,走水23.8%)｜line=3 43.0%(n=316,走水24.7%)
       ｜line=4 小球 33.3%(n=54,走水22.2%)，而非整数线 2.25→51.6% / 2.5→53.9% / 2.75 大球 60.2% / 3.25→52.0%。
       故 OU 只在中线位的**非整数线**上出手（.25/.5/.75 结尾永无走水），两头亏钱带与整数线都不出方向。 */
    const _intLine = (v) => Math.abs(v - Math.round(v)) < 1e-9;
    /* ⚠ 十六修（2026-10-05）：大球线区由 [−∞, 2.75] 收到 **只留 2.75 一格**。
       依据 _ou_gate2.cjs —— 首次把「真全库无条件基准」当 alpha 的对照系
       （_7m_db 56914 场，无选择偏差；判据 d=goals−line，走水不计）：
         line 方向   n    模型命中  全库基准   alpha    ROI@1.90
         1.5  大球   25    60.0%     78.5%    −18.5pp   —
         2.5  大球   390   50.0%     57.5%    −7.5pp    −5.0%   ← 显著负 EV（3σ）
         2.75 大球   352   60.2%     57.5%    +2.7pp    +14.4%
         合并大球 n=814 命中 55.8% vs 加权基准 57.7% → **alpha −1.9pp，模型≈市场**
       关键在 2.5 那格：模型判「大球」的场实际只有 50% 过线，比同线全库平均低 7.5pp
       —— 说明引擎在 2.5 线选出来的是**低进球倾向**的场（ou_stable 贴线判定），
       与市场定价相反，属于自造的负 EV。只留 alpha 唯一为正、且 n=352 够大的 2.75 格。
       上限 3.0 是防手：高线（3.25+）在旧门记录里全是旧产物，且无条件基准只有 24.8~36.5%，
       放出大球必亏，故线区锁死在 [2.75, 3.0] 再叠 !_intLine ⇒ 实际只有 2.75 合法。 */
    const _bigOK  = _lineOK(_line) ? (_line >= 2.75 - 1e-9 && _line <= 3.0 + 1e-9 && !_intLine(_line)) : true;   // 线缺失时不额外收紧
    /* ⚠ 十四修：小球线区由 [2.25,3.25] 收到 [2.5,3.0]。
       依据 _gate_validate.cjs（live_log，走水不计，train/test 双段）：
         小球整体        n=1295  命中 51.5%  train 52.3 / test 49.6  ← 低于盈亏线 54.1%，整侧负 EV
         line=2.25 小球 n=275   命中 51.6%  train 47.7 / test 61.8  （差 14.1pp，极不稳 → 收）
         line=2.5  小球 n=102   命中 53.9%  train 54.2 / test 50.0  （差 4.2pp，最稳 → 留）
         line=3.25 小球 n=279   命中 52.0%  train 56.3 / test 43.8  （差 12.5pp，极不稳 → 收）
       只留 line∈[2.5,3.0] 的非整数线（2.5、2.75；3.0 是整数线已被 !_intLine 禁掉）。 */
    const _smallOK= _lineOK(_line) ? (_line >= 2.5 - 1e-9 && _line <= 3.0 + 1e-9 && !_intLine(_line)) : true;
    if (op >= OU_OVER_MIN && _bigOK) ou_stable = '大球';
    else if (op <= OU_UNDER_MAX && _smallOK) ou_stable = '小球';
    else ou_stable = '无稳定方向';
    ou_dir = ou_stable;                     // verdict 一律同源, 永不与比分矛盾
    /* ⚠ 2026-10-05 十一修：**让球方向（受让方）** —— 本轮审计里唯一找到的真 alpha（_audit_asia.cjs）。
       判据（live_log 已结算 rows 逐场用 hcap + 真比分判盘，走水单独计，train<true>/test 双段核对）：
         |hcap|=0.25  受让方去走水覆盖 61.9%(n=811) train 62.6 / test 57.8  ROI@0.90 +17.6%
         |hcap|=1.25  受让方去走水覆盖 62.1%(n=261) train 60.8 / test 64.4  ROI@0.90 +17.9%
         合并 ±0.25 & ±1.25：受让覆盖 61.9%(n=1072) train 62.2 / test 60.7，二项 z=7.79，按月 61.7/63.1
       对照：其余盘口买受让全亏（|hcap|=0.5→45.0% / 0.75→46.6% / 1→47.3% / 1.75→43.1% / 2→42.2%），
             走水重灾的 |hcap|=1(28.6%) 与整数线同理是纯成本。
       机制：0.25/1.25 是"半档/一档obo"盘，市场把让球方定价偏强，受让侧系统性被低估 —— 典型 favorite-longshot 偏差。
       只在这两格出手；其余盘口一律「无方向」（此前整个让球板块都只展示盘口、不给方向，等于零贡献）。

       ⚠ 十二修（2026-10-05）：上述旧门已被 _gate_validate.cjs 证伪，见下方「十二修」块。

       ⚠ 十二修已被十五修撤回（符号笔误，见下方「十五修」块），理由与正确数字都记在十五修里。

  /* ===== 十五修（2026-10-05）：让球门撤回为「无方向」🔴 纠错 =====
     十二修（{|hcap|=1.25 或 |hcap|>=1.75} 买受让方，声称 72.8% / ROI +34.7%）是错的，根因是
     _gate_validate.cjs:17 的**符号笔误**：它写的是 stripe((hs-as) + hcap)（错），
     正确判据应为 d = (hs-as) - hcap，因为
        · hcap>0（主队让 hcap）    → 受让方=客队，受让赢盘 ⟺ net < hcap
        · hcap<0（主队受让 k=-hcap）→ 受让方=主队，受让赢盘 ⟺ net > -k = hcap
     两式统一为「受让方赢盘 ⟺ net - hcap < 0」；旧式 net + hcap 判的是 net > -hcap，差一个负号，
     所以那个 72.8% / 逐格 79.8% 根本不是受让覆盖，全站在此之上。
     _hcap_fix.cjs 用正确判据重算（live_log 3623 场，带符号 hcap + 真比分，train/test 双段）：
        |hcap|  0.25   0.5    0.75   1.0    1.25   1.5    1.75   2.0    >2     2.5+
        受让覆盖 57.3%  49.6%  50.2%  44.7%  51.7%  44.8%  44.0%  48.2%  51.4%  —
        现门 {1.25}∪[1.75,∞)  n=700 → 50.0%（train 50.9 / test 48.7，Δ−2.1pp）
        旧门 {0.25,1.25}       n=1072→ 56.0%（train 59.5 / test 43.1，Δ−16.4pp）
        全放行                n=3623→ 51.2%（train 53.0 / test 45.7，Δ−7.4pp）
     逐格 44~57%，**全线低于 decimal 1.85 的盈亏线 54.1%** → 受让侧无 alpha。
     判据自证：hcap>0 组受让 50.4% vs 让球方 45.3%；hcap<0 组让球方 50.9% vs 受让 46.1%
              —— 两侧都≈50%，即市场已把盘口定价到平衡，模型没有任何边可赚。
     为什么不用 7m 真全库（27907 场）复核：7m 的 pk 字段**丢了符号**（0 个负值），
     配对样本（live_log hcap=-0.5 ↔ 7m pk=0.75）可证；无符号就只能算混合口径，
     而实际下注时哪一方受让是已知的 → 必须以带符号的 live_log 为准。
     结论：让球板块回到「只展示盘口、不给方向」（即十二修之前的状态），
     但保留 _hc（UI 仍显示盘口数值）。 */
    asia_dir = '无方向'; asia_cov = null;
    /* 想再开门时唯一有希望的候选是 |hcap|>=2.5，但 live_log n=223 覆盖仅 51.4%
       （train 49.6 / test 53.4，Δ3.8pp），仍未过 54.1% 盈亏线 —— 目前没有任何一格值得出手。 */

      /* ── 十二修旧证据存档（判据 net+hcap 已由十五修证错，勿据以改门）──
      旧门 {|hcap|=0.25, 1.25} 的分格错得很明显：
       |hcap|=0.25 去走水仅 52.7%(n=867)，而 decimal 1.85 的盈亏线是 54.1% → **整格是负 EV**，
                    却占旧门 867 场里的绝大部分（旧门 n=1072 是被 0.25 拖累的 58.3%）；
       |hcap|=1.25 去走水 75.0%(n=228) → 真 alpha，必须留；
       |hcap|>=1.75 逐格 1.75→79.8 / 2.0→75.3 / 2.25→71.7 / 2.5→73.1 / 3.0→76.9 —— 全高于盈亏线，
                    却被旧门整段封死（旧门连门外合计都只有 61.0%，还高于自己的门内 58.3%）。
     分层控制（同 tier×conf 层内比较后再按层加权，排除"模型越有信心越容易高 |hcap|"的选择偏差）：
       现状 {0.25,1.25}  n=1059  58.3%  ROI +7.8%
       仅 1.25          n=228   75.0%  ROI +38.8%
       |hcap|>=0.75     n=1727  67.7%  ROI +25.3%
       1.25 或 >=1.75   n=692   72.8%  ROI +34.7%   ← 采用
       >=1.75           n=420   73.1%  ROI +35.2%
     train/test 双段（train predDay<20260926 / test>=）：
       现状 {0.25,1.25}  train 62.2% / test 52.3%（差 9.9pp，test 段掉到盈亏线以下）
       1.25 或 >=1.75   train 81.6% / test 66.6%（两段都 >66%，方向稳健）
     采用「|hcap|=1.25 或 |hcap|>=1.75」：命中 58.3%→72.8%，ROI +7.8%→+34.7%，
     覆盖由 29.6% 收到 19.3%（更精选而非更宽）。asia_cov 同步改为新口径的 72.8。
     注意 hcap 语义：>0 = 主队让球（受让=客队），<0 = 客队让球（受让=主队）；本门只认「受让」这侧，与符号无关。── */
    /* 十五修后：不再给受让方向，_hc 仅用于 UI 展示盘口（见上方十五修块） */
    if (op <= 50 - OU_VALUE_K){
      ou_value = true;
      ou_conf = Math.round(Math.min(82, 52 + (50 - OU_VALUE_K - op) * 1.5));
      ou_text = `模型大球P ${op}%(≤${50-OU_VALUE_K}%→价值小球·与比分同源) 盘口线${aggBs.c_line}`;
    } else if (op >= OU_OVER_MIN){
      // 大球侧仅当 op≥60 才翻正（校准曲线 60~65→58.9%、65+→61.5%，均高于盈亏线 52.6%）
      ou_value = true;
      ou_conf = Math.round(Math.min(78, 54 + (op - OU_OVER_MIN) * 1.1));
      ou_text = `模型大球P ${op}%(≥${OU_OVER_MIN}%→价值大球·与比分同源) 盘口线${aggBs.c_line}`;
    } else {
      ou_value = false; ou_conf = 0;
      ou_text = `模型大球P ${op}% · 偏离${ou_lean>0?'+':''}${ou_lean}pp ${ou_stable==='无稳定方向'?'（未达稳定阈值'+OU_STABLE_MARGIN+'pp, 不下方向结论, 与比分不矛盾）':'（模型同源, 与比分一致）'} 盘口线${aggBs.c_line}`;
    }
  }
  try {
    ppiInfo = ppiInput ? computePPI(ppiInput, agg) : computeHeat(agg, { mv_h, mv_d, mv_a, p1, h1 });
  } catch(e){ ppiInfo=null; }
  // 进球数盘口价值分歧：模型 P(Over) vs 盘口隐含（由大/小球水）—— 庄家视角跨市场分歧
  if (aggBs && score && score.overProb!=null){
    const ow = (aggBs.c_ow!=null)?aggBs.c_ow:aggBs.o_ow;
    const uw = (aggBs.c_uw!=null)?aggBs.c_uw:aggBs.o_uw;
    if (ow && uw){
      const mO = (1/(1+ow)) / (1/(1+ow) + 1/(1+uw));   // 盘口隐含大球概率
      const edge = score.overProb/100 - mO;             // 模型 − 盘口
      valueOU = { modelOver:score.overProb, marketOver:+(mO*100).toFixed(1), edge:+(edge*100).toFixed(1),
                   dir: edge>0.03 ? '大球' : (edge<-0.03 ? '小球' : '均衡'),
                   note:'模型大球概率相对盘口隐含概率的偏差（DC 低比分修正所致）；仅作庄家视角分歧提示，非投注建议' };
    }
  }

  /* ====== 洋哥盘赔框架（工程化自《职业操盘手自传之盘赔我见》）======
     核心：站在庄家角度，找"问题盘/不合理盘"，站在热门注码对面（与庄共舞）。
     ① 北单赔率池热度：北单先有资金后有赔率 → 赔率100%反映真实资金占比；
        本工具无北单直连，用欧赔反推的"庄家热度(PPI)"近似同一逻辑（资金占比代理）。
        大热判定：最热方资金占比 − 其公平胜率 ≥ 阈值，且最热方=基本面看好方 → 真热，站对面。
     ② 盘级实力/预设盘偏差：pan_gap(实际初盘−预期盘) 即洋哥"问题盘"信号；|pan_gap|≥1.0=错盘。
     ③ 驱动力：被动(资金博弈,正常) vs 主动异常(看好方赔率不降反升=真热信号)。
     ④ 吃水盘：无错盘+无大热+盘口正常移动 → 纯运气，不分析，观望。
     ⑤ 三盘分析法：一盘(竞彩/本源资金趋势)·二盘(365/major 操盘异动)·三盘(北单热度池) 一致性。 */
  let yg = null;
  try {
    /* ⑥ 北单赔率池真值（2026-09-23 接入）——洋哥「北单热度系统」。
       北单=赔率池玩法（先有资金、后有赔率）→ 三项赔率归一化即 100% 真实资金买入占比，
       权威性远高于 PPI 代理。有北单行时优先用真值，否则退回 PPI 代理。 */
    let bd = null;
    try {
      const bdRow = (typeof getBeidan === 'function') ? getBeidan(home, away, league) : null;
      if (bdRow && Array.isArray(bdRow.sp) && bdRow.sp.length === 3 && bdRow.sp.every(v => v > 1)) {
        let pct = bdRow.sp.map(v => 1 / v);
        const s = pct[0] + pct[1] + pct[2];
        pct = pct.map(v => +(v / s * 100).toFixed(1));
        if (bdRow.swapped) pct = [pct[2], pct[1], pct[0]];          // 北单主客与页面相反 → 交换 胜/负
        /* ★ 2026-10-29 坏行护栏（实测踩坑：丹麦杯 阿尔胡vs哥本哈 sp=[1.02,162.36,46.27] → 归一 W=97.2%，
           与欧赔客胜 1.18 完全反向，配对后 heatExcess=+88.2 假大热，且因该场 o1h/o1a 缺失致 bdDirOk 默认放行）：
           北单 sp 为已归一赔率池（实测 58 标准行 Σ(1/sp) 全部 ≈1.00），单边占比 >92% 物理上不可能是
           真实胜平负资金分布（足坛真实极限约 85~90%）→ 一律判坏行弃用，宁缺毋滥。 */
        if (Math.max(pct[0], pct[1], pct[2]) > 92) { bd = null; }
        else bd = { W: pct[0], D: pct[1], L: pct[2],
               rq: (bdRow.rq == null ? null : +bdRow.rq * (bdRow.swapped ? -1 : 1)),   // 让球（对齐页面主客）
               swapped: !!bdRow.swapped,                        // ★ 盘级差换算需要原序标记
               sp: bdRow.sp.slice() };
      }
    } catch(e){ bd = null; }
    /* ★ 2026-10-14 #319：三盘·流速差（参照外部模型：北单SP隐含 vs 欧赔(Bet365即时)隐含）
       北单隐含 P = [bd.W, bd.D, bd.L]（已由 sp 归一化，%）；欧赔隐含 Q = (1/o)/Σ(1/o)*100（核心即时盘 c_h/c_d/c_a = 主/平/客）；
       流速差_i = P_i − Q_i (pp)；最大侧 = argmax(flow)。
       危险盘 maxFlow≥15（大热必死，洋哥① +15.54）/ 问题盘⚠ maxFlow≥8（外部模型样例 +8.64/+10.18 均打此徽章）。
       口径与外部模型截图数字完全吻合（朗斯 vs 里斯 客胜 +8.64pp 等）。 */
    let triFlow = null;
    if (bd) {
      const P = [bd.W, bd.D, bd.L];
      const oco = (agg && agg.eu_valid != null && agg.eu_valid >= 3 && agg.c_h != null && agg.c_d != null && agg.c_a != null)
        ? [agg.c_h, agg.c_d, agg.c_a] : (agg ? [agg.o_h, agg.o_d, agg.o_a] : null);
      if (oco && oco.every(v => v > 1)) {
        const q = oco.map(v => 1 / v); const qs = q[0] + q[1] + q[2];
        const Q = q.map(v => +(v / qs * 100).toFixed(1));
        const flow = P.map((p, i) => +(p - Q[i]).toFixed(1));
        const maxIdx = flow.indexOf(Math.max(...flow));
        const minIdx = flow.indexOf(Math.min(...flow));
        const lowIdx = bd.sp.indexOf(Math.min(...bd.sp));
        const maxFlow = flow[maxIdx];
        /* ★ 2026-10-28 数据护栏（用户：板子 +N 出现 +62/+73 物理不可能值 = 北单/365 错配）：
           洋哥方法「差值」>15pt 即大热、>~16 为其旗舰案例上限；超过 25pt 物理上不可能
           （意味一边占比 80%+ 而 365 隐含 <10%，真实比赛不会如此背离）→ 判定为数据异常，
           三盘流速差整体置空：本板/过热板/问题盘徽章一律不出值，对齐参考软件"只对干净配对出值"。 */
        const _FLOW_SANE_CEIL = 25;
        const _sane = Math.abs(maxFlow) <= _FLOW_SANE_CEIL;
        triFlow = _sane ? {
          P, Q, flow,
          maxSide: ['W', 'D', 'L'][maxIdx], minSide: ['W', 'D', 'L'][minIdx], lowSide: ['W', 'D', 'L'][lowIdx],
          maxFlow: +maxFlow.toFixed(1), minFlow: +flow[minIdx].toFixed(1),
          euSrc: (agg && agg.euSrc) || null, sp: bd.sp.slice(),
          isDanger: maxFlow >= 15, isWarn: maxFlow >= 8
        } : null;
      }
    }
    /* ★ 2026-10-10 方向①扩展（用户授权"全做"）：破洋哥必发禁令 + 赔率vs模型背离
       - 必发真投注占比源（heatSrc='betfa'）：本系统 betfa.pct 是**净买盘方向占比**（真投注占比），
         非洋哥批评的"买卖双向成交额"，故可谨慎启用；与北单同口径参与大热判定。
       - 模型回归源（excessModel）：对赔率隐含概率做轻度均值回归得到"保守模型概率"，
         若赔率隐含占比远超回归模型 ≥ 阈值 → "市场/资金比模型更看好该方"型大热（破洋哥原"资金背离"定义，用户授权）。
       两者任一达标即判大热；取超额更大者为主信号，heatKind 标注来源以便回测/面板区分。 */
    let bf = null;
    try {
      if (betfa && betfa.W && betfa.D && betfa.L && [betfa.W.pct, betfa.D.pct, betfa.L.pct].every(v => v != null && v >= 0)) {
        bf = { W: +betfa.W.pct, D: +betfa.D.pct, L: +betfa.L.pct };
        // ★ 2026-10-16：澳客真实冷热指数（资金热度真值，用户看板直接引用），一并挂载
        if (betfa.W.hot != null || betfa.D.hot != null || betfa.L.hot != null){
          bf.hot = { W: betfa.W.hot!=null?+betfa.W.hot:0, D: betfa.D.hot!=null?+betfa.D.hot:0, L: betfa.L.hot!=null?+betfa.L.hot:0 };
        }
      }
    } catch(e) { bf = null; }
    /* ★ 2026-10-22 修复（用户实测·里尔漏标）：北单/必发均为真实资金源；当双方都在时，取「超买更极端」者为主信号，
       避免北单温和(里尔45.6%)掩盖必发暴热(61.72%)导致大热必死漏判。
       双源热门方一致 → 取更极端者；双源热门方分歧 → 保守取较小超买一方（不放大矛盾信号，防误触发）。 */
    const _idxOf = { W:0, D:1, L:2 };
    const _fairFor = (side) => (mk && mk[_idxOf[side]] != null) ? mk[_idxOf[side]] * 100 : null;
    const _maxSide = (o) => (['W','D','L'].reduce((b,k)=> (o[k]||0) > b.v ? {k,v:o[k]||0} : b, {k:'W',v:-1}).k);
    let heat = null, _heatSel = null;
    if (bd && bf) {
      const bs = _maxSide(bd), fs = _maxSide(bf);
      const be = (bd[bs]||0) - (_fairFor(bs)||0), fe = (bf[fs]||0) - (_fairFor(fs)||0);
      if (bs === fs) { if (fe >= be) { heat = { W:bf.W, D:bf.D, L:bf.L }; _heatSel='betfa'; } else { heat = { W:bd.W, D:bd.D, L:bd.L }; _heatSel='beidan'; } }
      else { if (Math.abs(fe) <= Math.abs(be)) { heat = { W:bf.W, D:bf.D, L:bf.L }; _heatSel='betfa'; } else { heat = { W:bd.W, D:bd.D, L:bd.L }; _heatSel='beidan'; } }
    } else if (bd) { heat = { W:bd.W, D:bd.D, L:bd.L }; _heatSel='beidan'; }
    else if (bf) { heat = { W:bf.W, D:bf.D, L:bf.L }; _heatSel='betfa'; }
    else if (ppiInfo && ppiInfo.heat) { heat = ppiInfo.heat; _heatSel='ppi'; }
    else heat = null;
    // 模型回归概率（轻度均值回归，仅用于"赔率vs模型背离"型大热，破洋哥原定义·用户授权）：
    //   对赔率隐含概率做均值回归得到"保守模型概率"，回归后概率若显著低于赔率隐含 → 市场/资金比模型更看好该方 = 反向大热信号。
    const MK_REVERT = 0.35;   // 回归强度（越高越保守）
    const mkModel = mk ? mk.map(p => +(p + (0.5 - p) * MK_REVERT).toFixed(4)) : null;
    // 热门方：优先真实资金源(北单/必发/代理)，否则取赔率隐含最大方（供模型背离源使用，无需资金源）
    const mkSide = (mk && mk.length === 3) ? (['W','D','L'].reduce((b,k,i)=> mk[i] > b.v ? {k, v: mk[i]} : b, {k:'W', v:-1}).k) : null;
    const heatSide = heat ? (['W','D','L'].reduce((b,k)=> (heat[k]||0) > b.v ? {k,v:heat[k]||0} : b, {k:'W',v:-1}).k) : (mkSide || null);
    const _hsIdx = heatSide ? { W:0, D:1, L:2 }[heatSide] : null;
    /* ★★ 2026-11-04 修正（洋哥原文重新定性）：北单 1/sp 归一 = 洋哥承认的资金占比（返还率100%），
       北单源**有效**。此前我误加 pctIsReal 剔除了北单——现撤销，北单/必发都是真实资金源。
       ★ 但主判定口径改为**洋哥差值%**：北单赔率换算成365标准盘后的未归一赔率差值，>15% 判大热。
       （详下方 yanggeDiff 实现；heatExcess 仅作展示，不单独作判档主量。） */
    const heatShare0 = heat ? (heat[heatSide]||0) : 0;                       // 资金占比（北单/必发 均为真实）
    const oddsShare  = (mk && _hsIdx != null && mk[_hsIdx] != null) ? +(mk[_hsIdx]*100).toFixed(1) : null;  // 赔率隐含占比（热门方）
    const heatShare  = heat ? heatShare0 : (oddsShare != null ? oddsShare : 0);    // 展示用：有资金用资金，无则用赔率隐含
    const fairProb = (mk && _hsIdx != null && mk[_hsIdx] != null) ? mk[_hsIdx] : null;
    let heatExcess = (fairProb != null) ? (heatShare0 - fairProb*100) : null;   // 资金背离（展示量，不作主判档）
    /* ★ 2026-10-29 真实资金源超买物理上限护栏（与 triFlow _FLOW_SANE_CEIL=25 同口径，纵深防御）：
       北单/必发为真实资金占比，|占比−公平|>25pt 物理不可能（洋哥旗舰案例上限 ~15.5）→ 判错行/坏行置空。
       注：ppi 代理与模型背离源不受此限（bd/bf 均空时 heat 来自代理，不进本护栏）。 */
    if (heatExcess != null && (bd || bf) && Math.abs(heatExcess) > 25) heatExcess = null;
    /* ★ 2026-10-21 洋哥④「深盘热度偏移+1级」工程化：
       实盘为一球及以上深盘(|p1|≥1.0)且热方=让球方时，热度读数 +1级 再判档——
       洋哥原话："深盘要修正，一球盘热度偏移+1"（深盘里同样%的资金代表更极端的追捧，受让方价值被进一步低估，
       与其实战 24/27 买受让方一致）。
       级→pt 换算锚定：洋哥大热判据「盘级偏差≥2级(0.25球/级)」对应本系统大热线 15pt ⇒ 1级 = 7.5pt。
       判定用 heatExcessEff（含修正）；yg.heatExcess 仍存**原始值**（标定回测拆账用），deepHeat 存修正明细。 */
    const YG_LVL_PT = 7.5;   // 1盘级 = 7.5pt（锚定：洋哥"盘级偏差≥2级"=大热线15pt）
    const deepPlate = (p1 != null && Math.abs(p1) >= 1.0);
    /* ★ 深盘修正（洋哥原文第20行"三盘热度偏移增加一个"）：深盘且热方=让球方时 +1级。
       北单/必发均为真实资金源（洋哥原文第3/8行确认），深盘修正对两者都适用。 */
    const deepAdj = (deepPlate && heatSide && ((p1 > 0 && heatSide === 'W') || (p1 < 0 && heatSide === 'L'))) ? YG_LVL_PT : 0;
    const heatExcessEff = (heatExcess != null) ? +(heatExcess + deepAdj).toFixed(1) : null;
    /* ★ 2026-10-22 对齐洋哥《北单赔率池》「偏差>返还率缺口」相对口径：
       返还率缺口 = (1 − R365)×100（R365=1/Σ(1/即时赔率)，即365含返还率）；洋哥原文"差值超过返还率缺口即可能大热"。
       动态门槛 = 缺口 + YG_HOT_BUFFER_PT(12)；无365即时赔率(agg缺失)时回退固定 YG_HOT_EXCESS_PT(18)。
       作用：高返还率比赛(缺口小)门槛降低、低返还率(缺口大)门槛抬升，自适应且贴合洋哥精神；
             回测 gap+12 在站对面 ROI(+16.8%) 优于固定18(+14.6%)。 */
    const _ocoR = (agg && agg.eu_valid != null && agg.eu_valid >= 3 && agg.c_h != null && agg.c_d != null && agg.c_a != null)
      ? [agg.c_h, agg.c_d, agg.c_a] : (agg ? [agg.o_h, agg.o_d, agg.o_a] : null);
    const _R365 = (_ocoR && _ocoR.every(v => v > 1)) ? (1 / _ocoR.map(v => 1/v).reduce((a,b)=>a+b,0)) : null;
    /* ★ 2026-10-29 洋哥「双判据」显示量工程化（精读自传《盘赔我见》174行 + 北单赔率池网址.txt 11行算例复核）：
       判据一（已有）差值>返还率缺口；判据二（本块新增）「换算亚盘数据后达到两个盘级的偏差（0.25为一个盘级）」。
       实现：北单三项赔率 ×R365 换算 → expectedHcap 同款映射(0.25+2.5×(pH−pA)) → 北单隐含盘口 bdExpHcap；
       与 365 即时欧赔期望盘口 euExpHcap 比较，bdLvlDiff=(bd−eu)/0.25（正=北单把主队方向买深了 N 级）。
       洋哥莫尔德案例自洽：公平平手盘、北单资金打到半球中水 → |差|=2级 → 异常大热。
       ⚠ 仅作展示/印证（进 ygMin 面板可读），不进触发条件——新判据未经本队真值标定回测前不改信号口径。 */
    let bdLvlDiff = null, bdExpHcap = null, euExpHcap = null;
    /* ★ 2026-10-29 洋哥查表法三口径盘级差（与线性映射并列，互不取代）：
         table  = 北单查表等级 − 365查表等级（两侧同法，可比性最好）
         vsReal = 北单查表等级 − 365「真实亚盘盘口」等级 ← 洋哥 Excel 原图口径（有 p1 才有）
         linear = 现有连续线性映射（expectedHcap），保留作对照
       ★ 北单偏差第二口径 heatExcessAlt = 换算后隐含 − 365不归一隐含（洋哥 Excel 表口径）；
         与引擎现用 heatExcess（归一 vs 归一，自传美伊 15.54 口径）并列，两者差约 1pt。 */
    let bdLvlTbl = null, euLvlTbl = null, lvlDiffTable = null, lvlDiffVsReal = null, lvlFlip = null;
    let bdTblTag = null, euTblTag = null, euRealLvl = null;
    let heatExcessAlt = null, heatExcessAltSide = null;
    if (bd && _ocoR && _ocoR.every(v => v > 1) && _R365 != null){
      const _spAdj = bd.swapped ? [bd.sp[2], bd.sp[1], bd.sp[0]] : bd.sp;
      if (_spAdj.every(v => v > 1)){
        const _bdC = _spAdj.map(v => v * _R365);
        bdExpHcap = +expectedHcap(_bdC[0], _bdC[1], _bdC[2]).toFixed(3);
        euExpHcap = +expectedHcap(_ocoR[0], _ocoR[1], _ocoR[2]).toFixed(3);
        bdLvlDiff = +((bdExpHcap - euExpHcap) / 0.25).toFixed(2);
        // 上盘胜赔 = min(主胜, 客胜)；上盘是主队 → 盘口符号为正
        const _bdUp = Math.min(_bdC[0], _bdC[2]), _euUp = Math.min(_ocoR[0], _ocoR[2]);
        const _bdHome = _bdC[0] <= _bdC[2],       _euHome = _ocoR[0] <= _ocoR[2];
        const _bdL = yanggeHcapLevel(_bdUp, false), _euL = yanggeHcapLevel(_euUp, false);
        /* ★ 方向翻转护栏（实测踩坑·2026-10-29 奥胡斯费马）：北单上盘与365上盘不是同一方时，
           带符号级差 = 两侧等级绝对值之和（如北单主+4 vs 365客−3 → +7），会被误读成"买深7级"。
           实为【方向完全相反】（错行/坏行典型特征），单独标 flip 供 UI 提示，不冒充盘级偏差。 */
        lvlFlip = (_bdHome !== _euHome);
        if (_bdL && _euL){
          bdTblTag = _bdL.tag; euTblTag = _euL.tag;
          bdLvlTbl = _bdL.lvl * (_bdHome ? 1 : -1);
          euLvlTbl = _euL.lvl * (_euHome ? 1 : -1);
          lvlDiffTable = bdLvlTbl - euLvlTbl;
        }
        if (bdLvlTbl != null && p1 != null && isFinite(+p1)){
          euRealLvl = Math.round(Math.abs(+p1) / 0.25) * (+p1 > 0 ? 1 : -1);
          lvlDiffVsReal = bdLvlTbl - euRealLvl;
        }
        // 第二口径（Excel 表）：换算后隐含 − 365不归一隐含，取绝对差最大方
        const _Rbd = 1 / _spAdj.map(v => 1/v).reduce((a,b)=>a+b,0);
        const _bdImp = _bdC.map(v => (1/v) * _Rbd);   // 图上 46.17/27.06/32.29
        const _euImp = _ocoR.map(v => 1/v);           // 365 不归一 64.52/…
        const _dv = [0,1,2].map(i => (_bdImp[i] - _euImp[i]) * 100);   // ★ ×100 转 pt（漏乘会让值恒为 0.x，实测踩坑）
        /* ★ 取方必须与 heatExcess(归一差) 同为「北单热门方 heatSide」，两口径才能逐场对账；
           否则一个取热门方、一个取绝对差最大方 → 押冷门时两者落在不同方，数值/符号都不可比（实测踩坑）。
           无热门方（heatSide 为空）时才回退绝对差最大方。 */
        let _bi = (_hsIdx != null && _hsIdx >= 0) ? _hsIdx : 0;
        if (_hsIdx == null){ for (let i = 1; i < 3; i++) if (Math.abs(_dv[i]) > Math.abs(_dv[_bi])) _bi = i; }
        heatExcessAlt = +_dv[_bi].toFixed(1);
        heatExcessAltSide = ['W','D','L'][_bi];
      }
    }
    /* ★ 2026-10-29 一盘·竞彩偏差（洋哥三盘法"一盘=竞彩官方资金趋势" + 资金流速详解的返还率换算法）：
       竞彩三项赔率 ×(R365/Rjc) 换算到 365 返还率 → 与 365 原始隐含（1/即时赔率）在竞彩热门方上做差（pt）。
       正 = 竞彩资金比 365 更看好该方；对照缺口判断倾斜。jc 行在本函数后段才解析（jcOdds 变量），
       故 jcDev 在 jc 解析之后计算（见下方 yg 组装前）。 */
    const _heatGap = (_R365 != null) ? +((1 - _R365) * 100).toFixed(1) : null;     // 洋哥「返还率缺口」
    const _hotThr  = (_heatGap != null) ? +(_heatGap + YG_HOT_BUFFER_PT).toFixed(1) : YG_HOT_EXCESS_PT;   // 动态大热门槛（UI「正式过热」强调档，保留稀有性）
    const _warnThr = (_heatGap != null) ? +(_heatGap + YG_HOT_WARN_BUFFER_PT).toFixed(1) : YG_HOT_WARN_PT; // 动态预警门槛
    /* ★★ 2026-10-31 致命修复（用户质问"哪来那么多10几pt、5以上大把"→ 跑全量分布查证）：
       此前 netPt 直接 = heatExcessEff（**绝对偏差**，未扣返还率缺口），而全板标尺/文案/参考软件锚点
       （里尔 +7、毕尔巴鄂 +4）用的都是**净超买** = 绝对偏差 − 返还率缺口。缺口典型 6.5~11.4pt（中位 8.0）
       → 每个显示值系统性虚高约 8pt，判档门槛被实际放松 8pt，于是"5 以上大把、10 几成堆"。
       实测（北单干净样本 140 场）：绝对偏差 p50=+3.9 / ≥+10 共 50 场；扣缺口后 p50=−4.4 / ≥+10 仅 11 场。
       现两个量彻底分离，永不再混用：
         excessPt = 绝对偏差（占比 − 公平胜率 + 深盘修正）→ 仅供洋哥判据一「差值 > 缺口」(daHot) 使用；
         netPt    = 净超买（excessPt − 缺口）            → 唯一显示量 + 唯一判档量（对齐参考软件 +4/+6/+7）。
       --force--（第 2 刀）：非真实资金源(heatUsable≠true)的 netPt 一律 null ——
       ppi 代理源 2506 场带着 netPt 数字（中位 +21.4、最大 +89.8）是纯噪声，任何读数/排序都会被它污染。 */
    const excessPt = (heatExcessEff != null) ? +heatExcessEff.toFixed(1) : null;                       // 绝对偏差（洋哥判据一用）
    /* ⚠ netPt 不在这里定义！heatUsable 在下方 4662 行才声明（const 有暂时性死区），
       2026-10-31 初版在此处引用 heatUsable → ReferenceError → 整个分析函数抛异常 → an.yg 恒空
       （线上 2672/2690 场 yg 被清空，只剩 18 场）。netPt 已移至 heatUsable 声明之后（见下）。 */
    /* ★ 2026-10-22 二次精读自传174行修正：洋哥大热定性 = 「差值 > 返还率缺口(1−R365)」，**无 +12 缓冲**。
       上一轮用 gap+12 作 yg.heatTier（正式过热展示档）门槛，会把洋哥旗舰案例（莫尔德13.6% vs 缺口5.21、美伊15.54% vs 缺口~10）排除在"正式过热"之外 → 误判；
       故新增 yg.daHot = 严格按洋哥相对口径（差值>缺口）的定性大热标记，作 PICK「大热必死」线索的入门条件（见 stakePlan）。
       注意：stakePlan 在「二盘无设防异常确认」时，仍以「超买≥动态缺口+12缓冲 或 固定18」作极端档兜底(_extreme)，保留稀有大热必死的回测 ROI(+16.8%，优于固定18的+14.6%)；
       这并非"回到 gap+12 作主门槛"，而是极端情形下的安全网。 */
    const _realSrc = (_heatSel === 'beidan' || _heatSel === 'betfa');   // ★ 记忆铁律：代理 ppi 禁用于大热判定（旧版未校验→1023场ppi假+89pt灌满PICK）
    const _daHot = (_realSrc && heatExcessEff != null)
      ? (_heatGap != null ? heatExcessEff > _heatGap : heatExcessEff > YG_HOT_EXCESS_PT)
      : false;
    const excessModel = (oddsShare != null && mkModel && _hsIdx != null && mkModel[_hsIdx] != null) ? +(oddsShare - mkModel[_hsIdx]*100).toFixed(1) : null;  // 赔率vs模型背离（不依赖资金源）
    /* 大热判定 —— 阈值取自《洋哥自传》真实案例的实测复算（不是拍脑袋）：
       案例① 2022世界杯 美国vs伊朗（洋哥定性"太夸张""可遇不可求的机会"）：
              亚洲365: 1.91/3.40/4.20 → 隐含 49.59/27.86/22.55
              北单池 : 2.88/3.30/2.50 → 真实 33.06/28.85/38.09
              热门方(伊朗) 超出 = 38.09 − 22.55 = +15.54pt；不败资金(伊朗+平) = 66.9%
              → 与原文"购入伊朗不败的资金接近7成"完全吻合，口径确认无误。
              关键：该场最热方资金占比仅 38.1%，故"资金占比≥45%"这类绝对门槛
                    会把洋哥定义的顶级大热漏判（实测现行判据正是漏判）→ 必须删除。
       案例② 2025-02-18 西甲 巴萨vs巴列卡诺（洋哥定性"非常危险""大热倒灶"）：
              1.18(覆盖84.7%) → 临场1.40(覆盖71.4%)，资金约80% → 超出约 +9pt
              → 赔率抬升型大热（降赔付却仍吸金），与①的资金池型同源。
       取①为标定基点：HOT_EXCESS_PT = 15（洋哥极端案例实测 15.54）。
       注：② 的 +9pt 属"危险"级而非"可遇不可求"级，故另设 HOT_WARN_PT = 9 作预警档。 */
    const HOT_EXCESS_PT = _hotThr;
    const HOT_WARN_PT   = _warnThr;
    const heatDomain = heatDomainOf(league);
    /* 热度源可信度（2026-10-10 方向①扩展·用户授权"全做"，实测后收紧）：
       - 'beidan' 北单赔率池 = 先有资金后有赔率 → 三项赔率归一化即真实资金买入占比（本 feed 的 pct 由 sp 归一化得到，正是赔率池资金占比）。
                  与共识 mk（澳客/威廉等跨公司隐含）做差 = 资金vs精算背离 = 洋哥①真信号（实测 heatExcess 可达 +80pt，非恒≤0）。
                  ⚠ 2026-10-10 修串场：同两队既踢联赛又踢杯赛时，纯队名匹配会把唯一一条联赛赔率池行误贴到杯赛场 → 杯赛场拿到错配热度；
                  已加 _cupOk 杯赛/联赛一致性守卫消除（实测 3086990 杯赛场剔除）。
       - 'betfa'  必发真投注占比（净买盘方向占比，≠洋哥批评的"买卖双向成交额"）→ **2026-10-10 破洋哥必发禁令启用**（用户明确授权）。
                  注：必发数据 live-only（历史不可回补），离线 bake 仅能匹配对得上的场次（okooo mid↔体彩 id 映射待建，当前精确队名匹配约 0.5%）。
       - 'model'  模型均值回归背离（excessModel）：实测为"强队必触发"的数学假象（赔率隐含≥85%的强队几乎全中），并非洋哥"资金背离"真信号，
                  故**仅作展示信息，不再触发大热/PICK**（2026-10-10 修正）。
       - 'ppi'   代理热度 → 仍不用于大热判定（不可信），保持关闭。
       - 'low'   低级别域 → 资金池过小，热度系统不适用。
       关键修正（2026-10-09 ①打通根因B，保留）：heatUsable 对 beidan 真值开放——北单命中即不受 low 域抑制。
       2026-10-10 收紧：heatUsable 仅开放 beidan 与 betfa（真实资金源）；model 背离不再作为大热源。 */
    const heatSrc = _heatSel || (bd ? 'beidan' : (bf ? 'betfa' : (heat ? 'ppi' : 'na')));   // ★ 2026-10-22 取超买更极端真实资金源（北单/必发分歧时取更极端者）
    /* ★ 2026-10-17 流动性下限（四十八修·实测踩坑）：极低成交量市场的 pct/澳客冷热纯属噪声，
       会产生虚假超买/正式过热——回溯 82 场已结算：旧版 21 个正式过热里 10 个来自总成交量<5万 的迷你场
       （最低 71/88/878/3452），其中金泉尚武 总成交量878 却标"平局占80%·正式过热"、枥木Uva 88 量 hot=366。
       这类噪声场必须把热度系统整个关掉（heatUsable=false 且 heatTier 强制 normal），否则把平局/随机错判成"正式过热"。 */
    const BETFA_LIQ_FLOOR = 30000;   // 必发/澳客 三向总成交量下限（feed原始额度单位）
    let _liqOk = true;
    if (heatSrc === 'betfa' && betfa && betfa.W && betfa.D && betfa.L){
      const _vol = (+betfa.W.amount||0) + (+betfa.D.amount||0) + (+betfa.L.amount||0);
      _liqOk = _vol >= BETFA_LIQ_FLOOR;
    }
    /* ★ 2026-10-21 北单行「方向一致性」护栏（用户拍板要加）：
       北单自己开出的最低赔方(它认定的热门方) 必须与欧赔隐含热门方(mkSide) 同侧，否则该行就是**错行/脏数据**。
       实测踩坑：马竞场(西班牙人vs马竞) 北单 sp 主1.16 ↔ 欧赔客1.67；斯图加特场(汉堡vs斯图加特) 北单主1.91 ↔ 欧赔客1.67
         —— 两边热门方完全相反，却算出 heatExcess +65.2 / +30.2pt 的"超级大热"，纯属错行放大出的假信号。
         （对照：科特布斯vs纽伦堡 北单客1.62 ↔ 欧赔客2.00，两侧一致 → +15.3pt 才是真信号。）
       此类行必须判不可信(heatUsable=false)，热度改由「市场大热/赔率抬升型」等不依赖北单的线索承担。 */
    let _bdFav = null, _euFav = null, _bdDirOk = true, _bdFlip = false, _bdFlipSane = false;
    if (bd && heatSrc === 'beidan' && bd.W != null && bd.D != null && bd.L != null){
      /* 北单热门方：用 bd.W/D/L（该 pct 已按页面主客对齐，swapped 行在 4207 已交换过），
         不要用 bd.sp 原始值比方向（swapped 行主客相反，会误判）。 */
      let _mx = -Infinity;
      const _m = [['W', +bd.W || 0], ['D', +bd.D || 0], ['L', +bd.L || 0]];
      for (let i = 0; i < 3; i++){ if (_m[i][1] > _mx){ _mx = _m[i][1]; _bdFav = _m[i][0]; } }
      /* 欧赔热门方：临盘主/客胜赔率低者（不用 mkSide——实测其为 null，mk.length 不满足）；
         ★ 2026-10-29 补洞：o1h/o1a 缺失时（如丹麦杯 tid3094517 两值全 null）旧代码 _euFav=null → bdDirOk 默认 true 放行，
           坏行直接灌进 heatExcess=+88.2。现用 mk 概率兜底判方向（mk=[pW,pD,pL]，概率大者为热门方）。 */
      _euFav = (o1h != null && o1a != null) ? (o1a < o1h ? 'L' : 'W')
             : ((Array.isArray(mk) && mk.length === 3 && mk[0] != null && mk[2] != null) ? (mk[2] > mk[0] ? 'L' : 'W') : null);
      /* ★★ 2026-10-31 六修·把洋哥的旗舰案例从"错行"里救回来（本轮最重要的修正）
         洋哥原文 174/197 行的原型案例就是「北单把上盘打到翻方向」：
           2022 世界杯 美国vs伊朗——365 美国让半球中高水(1.91)，北单临场把伊朗买到平手略低水(2.50)，
           购入伊朗不败资金接近7成，他自己称"太夸张了"，最终美国 1-0。
         ⚠ 旧逻辑把这种"北单热门方 ≠ 欧赔热门方"一律判错行(heatUsable=false)直接丢弃——
           于是本系统永远看不到洋哥体系里最强的信号，只剩下"方向一致"的普通超买（那本来就不是问题盘）。
         但错行(两场不同比赛被队名误配)确实也长这个样，必须用**数据质量**区分，不能只看方向：
           真翻转 = ①北单三项占比分布健康（无单边爆表：max≤62%、min≥6%，错行常见 >90% 或 <3%）
                  ②换算后与 365 真实亚盘形成 ≥2 个盘级的方向翻转（lvlFlip 且 |lvlDiffVsReal|≥2）
         三条同时成立才放行；任一不成立仍判不可信（宁缺毋滥）。 */
      let _pmax = -Infinity, _pmin = Infinity;
      for (const _v of [+bd.W||0, +bd.D||0, +bd.L||0]){ if (_v > _pmax) _pmax = _v; if (_v < _pmin) _pmin = _v; }
      _bdFlip = (_bdFav !== _euFav);
      if (!_bdFlip) _bdDirOk = true;
      else {
        /* 第四条：洋哥原话"购入伊朗不败的资金接近7成"——真翻转必然伴随热门方**不败**资金堆到 65% 以上；
           错行是不可能系统性满足这条的（实测翻转样本的 flip 方不败占比集中在 68~79%，正是这个成因）。
           四条全中才放行；缺一条仍判错行（宁缺毋滥，避免把配错的野鸡场灌进大热板）。 */
        const _unb = (+bd[_bdFav] || 0) + (+bd.D || 0);
        _bdFlipSane = (_pmax <= 62 && _pmin >= 6) && (_unb >= 65)
                   && (lvlFlip === true)
                   && (lvlDiffVsReal != null && Math.abs(lvlDiffVsReal) >= 2);
        _bdDirOk = _bdFlipSane;
      }
    }
    /* ★★ 2026-11-04 修正（用户给洋哥原文《北单赔率池赔率查询网址.txt》后重新定性）：
       洋哥原文第3行明确"北单是赔率池形式，先有资金后有赔率，三项赔率100%反映资金买入比例"，
       且第8行"北单赔率返还率是100%"——故**北单 1/sp 归一 就是洋哥承认的资金占比**，北单源**有效、不该剔除**。
       我此前误判"北单 pct 是赔率隐含"并剔除——错在**误读了洋哥原法**：洋哥要的对比基准是
       "北单赔率换算成 365 标准盘后的**未归一赔率差值%**（>15% 判大热）"，不是我的 netPt(归一概率差−缺口)。
       ⇒ 恢复北单源为可用（_srcOk 含 beidan），但**主判定口径改为洋哥差值%**（见下方 yangge 实现）。 */
    const _srcOk = (heatSrc === 'beidan' ? _bdDirOk : (heatSrc === 'betfa'));
    const heatUsable = _srcOk && _liqOk;
    /* ★★ netPt（净超买·唯一显示+判档量）必须定义在 heatUsable 之后 —— const 有暂时性死区(TDZ)，
       2026-10-31 初版把它写在 heatUsable 声明之前 → ReferenceError → 分析函数中抛 → an.yg 恒空（2672 场受害）。
       铁律：凡引用 heatUsable/_srcOk/_liqOk 的量，一律在其声明之后再定义。 */
    const netPt = (excessPt != null && heatUsable === true) ? +(excessPt - (_heatGap != null ? _heatGap : 0)).toFixed(1) : null;
    // 注：excessModel（赔率vs模型回归背离）实测为"强队必触发"的数学假象（赔率隐含≥85%的强队几乎全中），
    //     并非洋哥"资金背离"真信号，故**仅作展示信息，不再触发大热/PICK**（2026-10-10 修正）。
    /* ★ 2026-10-16：统一资金热度分档（供三盘板/热度榜/复盘 一致使用，不再"每次都是大热"模糊说法）。
       主信号 = 澳客真实冷热指数 hot（必发源直接持有；用户看板即引用该值）：
         hot>=50 → 正式过热（强过热·拥挤·中性提示：看赔率价值，不机械反买也不追高；21场回测证伪"价值被吃光"——过热方胜率≈隐含）。
                   UI 层在此档注入"动作建议"（heatActionHint）：结合模型方向+引擎价值分——模型同向→可小注/轻仓顺势、模型反向→回避、无方向→勿重仓。
         hot>=15 → 中热（偏热·谨慎）
         hot>=5  → 小热（微热·顺势）
         <5      → 正常热
       无澳客 hot（仅北单源）时退回 heatExcess（投注占比−公平胜率）口径：>=15(YG_HOT_EXCESS_PT) 正式过热 / >=9 中热 / >=3 小热（与 betfa 源统一到洋哥 15pt 大热标准）。
       大热触发（isHot）= 仅「正式过热」档 → 稀有且有意义；中热/小热只作提示，不机械反买。 */
    const hotIdx = (bf && bf.hot) ? Math.max(bf.hot.W, bf.hot.D, bf.hot.L) : null;
    const hotSideIdx = (bf && bf.hot) ? (['W','D','L'].reduce((b,k)=> bf.hot[k] > b.v ? {k,v:bf.hot[k]} : b, {k:'W',v:-999}).k) : null;
    /* ★ 2026-10-17 修正「真实超买被澳客冷热指数低估」：betfa 冷热指数(hot)与超买pt(heatExcess)双口径
       统一以「超买pt ≥ YG_HOT_EXCESS_PT(15)」定正式过热档（洋哥大热标准），hot≥50 仅作辅助升档。
       旧逻辑：betfa 源只看 hot≥50 → 科特布斯客队 70%资金/超买+17.5pt 仅因 hot=41<50 被判中热，真实超买被漏；
       北单源要超买≥25 才正式过热（比洋哥 15pt 标准更严）。两源阈值不一致，统一到 15pt 标准。 */
    /* ★ 2026-10-31 致命修复：以上判档**从未校验 heatUsable/heatSrc** —— 代理 ppi 源 2461 场（假大热，
       中位数 +22.2pt、最大 +89.8pt）被无条件判成 'hot'(正式过热)，把真实北单源(133 场)彻底淹没。
       这正是"板上一片10几、动不动就过热"的根因。铁律：热度分档必须在 heatUsable 之内进行。 */
    /* ★★ 2026-11-04 洋哥原文《北单赔率池赔率查询网址.txt》主判定口径：
       ①北单返还率 R_bd = 1/Σ(1/sp)（≈100%，洋哥原文第8行"北单赔率返还率是100%"）；
       ②换算成365标准盘：sp_conv = sp × (R_365 / R_bd)；
       ③未归一赔率差值%：diff_i = (sp_conv_i − 365赔率_i)/365赔率_i × 100；
       ④maxDiff > 15% → 大热门倾斜（原文"如果差值超过15%，即有可能产生大热门倾斜"）；
       ⑤差值越大把握越高；站大热门资金对面（受让方）。
       ★ 此为主判档通道（洋哥判据一）；盘级差≥2（判据二）与竞彩流速(①盘)为辅助/验证。 */
    let ygDiff = null;   // 洋哥差值% pp（主判档量）
    /* ★★ 2026-11-04 校正：洋哥方法 = 北单赔率池 vs 365赔率对照，只要两方有数据就算，
       不依赖 heatSrc（heatSrc 是系统选哪个源做热度，跟差值无关）。
       旧条件 heatSrc==='beidan' 导致：只有 heatSrc 恰好选 beidan 的场才算，而 getBeidan 匹配率低
       （53 场 vs 2570 场 → 27 场命中 → 但 heatSrc 常选 ppi/betfa）→ ygDiff 恒 null。
       改：只要 bd.sp 三项 + _oco 三项都有，就算 ygDiff，不管 heatSrc 是谁。 */
    if (bd && bd.sp && bd.sp.length === 3){
      try{
        const _sp = bd.swapped ? [bd.sp[2], bd.sp[1], bd.sp[0]] : bd.sp;
        /* ★★ 2026-11-04 修复·取365初盘对齐北单开盘态（CVM dump 实测根因）：
           北单赔率池"先有资金后有赔率"、随资金滚动，抓到的 sp 是**当日开盘后不久**的态；
           而 365 临盘(c_h)已充分反应到临赛，与北单开盘态**时点错配** → 客队项差值被放大到
           143%（圣保罗 4.52 vs 临盘3.7）→ 被 max≤60 护栏整场过滤 = ygDiff 恒 0。
           dump 实据：圣保罗 bd.sp=[2.11,3.26,4.52]，365初盘o=[2.38,3.1,3.25] vs 临盘c=[2.05,3.1,3.7]
           —— 北单主项2.11 明显贴近 365 初盘2.38，远非临盘2.05。
           洋哥原文第11行实例(北单2.15/3.42/4.08 vs 365即时1.96/3.3/3.4)三项差值均<8%，说明
           对比的365价是**接近初盘的即时**价。故 _oco 优先级：**365初盘o → 临盘c → o1h → _ocoR**。 */
        const _co365 = (agg && agg.coLive && agg.coLive.Bet365) || null;
        const _oOK = v => (Array.isArray(v) && v.length===3 && v.every(x=>+x>1));
        const _oco = (_oOK([agg.o_h,agg.o_d,agg.o_a]))
          ? [+agg.o_h, +agg.o_d, +agg.o_a]
          : ((_co365 && _co365.o && +_co365.o.h>1 && +_co365.o.d>1 && +_co365.o.a>1)
              ? [+_co365.o.h, +_co365.o.d, +_co365.o.a]
              : ((_co365 && _co365.c && +_co365.c.h>1 && +_co365.c.d>1 && +_co365.c.a>1)
                  ? [+_co365.c.h, +_co365.c.d, +_co365.c.a]
                  : ((_oOK([o1h,o1d,o1a])) ? [o1h,o1d,o1a].map(v=>+v)
                      : ((_ocoR && _ocoR.every(v=>v>1)) ? _ocoR : null))));
          if (_sp.every(v=>v>1) && _oco){
            /* ★★ 2026-11-04 换算法校正（三个实例复算全部对上洋哥原文）：
               ① conv = bd × R365（原文178行"直接将三项赔率乘以365的返还率即可"，非 ×(R365/Rbd)）。
                 奥伊金斯 2.15×0.9031=1.94✓ 水晶宫 2.01×0.9398=1.89✓（原文1.88）
               ② 差值 = **隐含概率百分点差** (1/conv − 1/e365)×100（非赔率相对差）。
                 奥伊金斯三项 0.48/2.07/−2.27pp → 原文1.03/6.08/−7.61（洋哥近似取整）
                 水晶宫上盘 1/1.89−1/2=2.94pp → 原文3.19%（洋哥原文用 1/1.88 算，四舍五入差 0.25pp）
                 莫尔德 1/1.92−1/2.6=13.6pp → 原文13.6% ✓✓✓
               ③ 缺口 = 1−R365（各场专属）。
                 奥伊金斯 1−0.9031=9.69%✓ 水晶宫 1−0.9398=6.02%✓ 莫尔德 1−0.9479=5.21%✓
               ④ 大热判定 = 上盘方向（174行"只需考虑上盘一个方向"）的差值 > 缺口。
                 上盘 = 换算隐含概率最大项（资金涌入=赔率被压到比365低最多=1/conv 最大），
                 差值 = pconv_max − p365[同一项]（洋哥水晶宫只算上盘：2.94pp < 缺口6.02 → 合理盘放弃）。
               注意：洋哥近似 Rbd≈100%（北单赔率池返还率确实≈100%），故 ×R365 与 ×(R365/Rbd) 差异
                 仅 0.25%，实测奥伊金斯 Rbd=0.9974、水晶宫 Rbd=0.9979。洋哥原文直接 ×R365，故以原文为准。 */
            /* ★★ 2026-11-05 修：_Rb 此前从未定义（4765行 _Rb.toFixed 抛 ReferenceError 被外层 catch 吞
               → ygDiff 恒 null）。且 _R365 用 _ocoR（临盘中位数）算，而 _p365 用 _oco（初盘）算 → 口径混。
               统一：_R365y/_Rb 都用 _oco（初盘，对齐北单开盘态）算，conv/对比同一来源。 */
            const _R365y = +((1 / _oco.map(v => 1/v).reduce((a,b) => a+b, 0))).toFixed(4);
            const _Rb    = +((1 / _sp.map(v => 1/v).reduce((a,b) => a+b, 0))).toFixed(4);   // 北单返还率≈100%
            const _conv = _sp.map(v => v * _R365y);
            const _pconv = _conv.map(v => 1/v);
            const _p365 = _oco.map(v => 1/v);
            /* 上盘 = 365隐含概率最大项（=365最低赔方向，洋哥174行"只需考虑上盘一个方向"），
               hotDiff = (1/(bd×R365) − 1/e365)×100 同项之差。正值=北单换算后更看好该方=资金涌入该方。 */
            let _hotI = 0;
            for (let i = 1; i < 3; i++) if (_p365[i] > _p365[_hotI]) _hotI = i;
            const _hotDiffPP = +((_pconv[_hotI] - _p365[_hotI]) * 100).toFixed(2);   // 上盘方向概率百分点差（洋哥口径）
            const _gap = +((1 - _R365y) * 100).toFixed(2);                             // 该场专属缺口 1−365R（用初盘）
            const _maxHot = Math.abs(_hotDiffPP);
            if (_maxHot <= 40){                                   // 概率百分点差物理上限（>40pp 必为脏数据/时间错配）
              ygDiff = {
                diffs: _pconv.map((v,i) => +((v - _p365[i]) * 100).toFixed(2)),  // 三项概率百分点差
                max: +_maxHot.toFixed(2),
                conv: _conv.map(v=>+v.toFixed(3)),
                Rb: +_Rb.toFixed(4), R365: +_R365y.toFixed(4),
                hotSide: ['W','D','L'][_hotI],
                hotDiff: _hotDiffPP,                                 // 上盘方向概率百分点差（洋哥主判量）
                over15: _maxHot > 15,                                // 粗筛线（洋哥第8行）
                gap: _gap,
                overGap: (_hotDiffPP > _gap),                        // ★ 主判：上盘差值 > 该场专属缺口
                overGapX: +(_hotDiffPP / _gap).toFixed(2),           // 超缺口倍数（>1=破缺口）
              };
            }
          }
      }catch(e){ ygDiff = null; }
    }
    /* ★★ 2026-11-04 TDZ 修复·三盘合流门控前置提取：
       判档段（下方 heatTier beidan 分支）需 pan2/jcHotSide/jcDev，但这三个在 4912+ 行才正式定义
       （let 声明后才能用，否则 ReferenceError 静默吞掉整个 yangge 判档）。
       此处轻量提取一份，**只算判档需要的字段**（不重复 stakePlan 完整逻辑），
       正式定义仍在 4912+ 行保持不动（stakePlan 那份用于 plan 线索，这里这份用于 heatTier 判档）。 */
    let _preJcHotSide = null, _prePan2 = null, _preJcDev = null;
    try {
      // ①盘·竞彩热门方 + 偏差
      const _jcRow = (JC_ROWS || []).find(r => _jcNameEq(home, r.home) && _jcNameEq(away, r.away));
      if (_jcRow && _jcRow.had && _jcRow.had.h && _jcRow.had.a && _jcRow.had.d){
        const _jo = { W: +_jcRow.had.h, D: +_jcRow.had.d, L: +_jcRow.had.a };
        if (_jo.W > 1 && _jo.D > 1 && _jo.L > 1){
          const _arr = [['W',_jo.W],['D',_jo.D],['L',_jo.L]];
          _preJcHotSide = _arr.reduce((b,x)=> x[1] < b[1] ? x : b, _arr[0])[0];
          // 竞彩偏差（_ocoR/_R365 在 4497/4499 行已定义）
          if (_ocoR && _ocoR.every(v=>v>1) && _R365 != null){
            const _jcArr = [_jo.W, _jo.D, _jo.L];
            if (_jcArr.every(v=>isFinite(v) && v>1)){
              const _inv = _jcArr.map(v=>1/v), _Rjc = 1 / _inv.reduce((a,b)=>a+b,0);
              const _jcF = _jcArr.map(v=>_Rjc/v);
              const _euF = _ocoR.map(v=>_R365/v);
              const _i = _preJcHotSide==='W'?0:(_preJcHotSide==='D'?1:2);
              _preJcDev = +((_jcF[_i]-_euF[_i])*100).toFixed(1);
            }
          }
        }
      }
      // ②盘·365不顺应资金
      const mm = agg && agg.mktMv, b3 = agg && agg.b365;
      if (mm && mm.n >= 3){
        const _mv = [['W',mm.h],['D',mm.d],['L',mm.a]].filter(x=>x[1]!=null&&isFinite(x[1]));
        if (_mv.length===3){
          const _lo = _mv.reduce((b2,x)=>x[1]<b2[1]?x:b2,_mv[0]);
          const flowSide = _lo[0], flowDv = +(+_lo[1]).toFixed(2);
          const hot1 = flowDv <= -0.13;
          let b365Dv = null, def = null;
          if (b3 && b3.o_h != null && b3.c_h != null){
            const _bo = {W:+b3.o_h,D:+b3.o_d,L:+b3.o_a}, _bc = {W:+b3.c_h,D:+b3.c_d,L:+b3.c_a};
            if (isFinite(_bo[flowSide]) && isFinite(_bc[flowSide])){
              b365Dv = +(_bc[flowSide]-_bo[flowSide]).toFixed(2);
              def = (b365Dv<=-0.05)?'follow':((b365Dv>=0.03)?'fade':'flat');
            }
          }
          _prePan2 = { side:flowSide, hot1, def };
        }
      }
    } catch(e){ _preJcHotSide = null; _prePan2 = null; _preJcDev = null; }
    let heatTier = 'normal';
    // ★ 2026-10-21：判档统一用 heatExcessEff（含洋哥④深盘+1级修正）；展示/入账仍用原始 heatExcess。
    if (!heatUsable){
      heatTier = 'normal';              // ★ ppi代理源/方向护栏失败/流动性不足 → 一律不标过热
    } else if (heatSrc === 'beidan'){
      /* ★★ 2026-11-04 洋哥主判定·对照原文逐条校正（自传174/178行 + 《北单赔率池》第8行）：
         主判线 = 差值 > **该场专属返还率缺口**（动态，1−365R），不是固定 15%——15% 是第8行**粗筛线**，
         174行精算线是缺口。故 ygDiff.overGap（差值>缺口）= 破缺口，ygDiff.overGapX = 超缺口倍数。
         ★ 三盘合流门控（自传199行"切勿从三盘起步"）：破缺口 只是③盘现象，必须 ①盘资金趋势同指
           + ②盘365不顺应资金(flat|fade) 才判 hot（大热必死）；缺一降级 warn（不判过热）。
         ★ 上盘方向简化（174行"只需考虑上盘一个方向"）：差值>缺口 或 换算亚盘盘级差≥2，任一满足即可。 */
      const _ygBreak = !!(ygDiff && ygDiff.overGap);                       // ③盘破缺口（洋哥精算主判线）
      const _ygBreakX = (ygDiff && ygDiff.overGapX != null) ? +ygDiff.overGapX : 0;
      const _ygLv2   = !!(ygDiff && ygDiff.max >= 15);                      // 粗筛线（第8行）保留为快速过滤
      /* 三盘合流 ①盘：资金趋势同指（真实流速热方 + 竞彩倾斜印证）——复用 stakePlan 同款判据 */
      const _sideOk1 = (_prePan2 && _prePan2.side && heatSide && _prePan2.side === heatSide && _prePan2.hot1)
                    || (_preJcHotSide && heatSide && _preJcHotSide === heatSide && ((_preJcDev != null && _preJcDev > 0)));
      /* 三盘合流 ②盘：365 不顺应资金（flat 纹丝不动 | fade 升水）= 异常；follow=顺应=正常吃水盘 */
      const _noDefend2 = !!(_prePan2 && (_prePan2.def === 'flat' || _prePan2.def === 'fade'));
      const _follow2   = !!(_prePan2 && _prePan2.def === 'follow');
      const _has2      = !!_prePan2;                                        // 有无②盘数据
      const _triFlow   = _sideOk1 && _noDefend2;                            // 三盘合流 = ①同指 + ②不顺应
      /* 判据二：换算亚盘盘级差 ≥2 级（洋哥174行"或"）—— bd 主口径=vsReal优先→table→linear，含 flip 方向护栏
         ★ 2026-11-05 TDZ 修复：lvlDiff 对象在 yg 构造(5067)才建，4852 前引用它=ReferenceError 被外层 catch 吞
         → an.yg 恒 null（牛津联等 19 场受害）。此处直接用 lvlDiff 构成变量（bd 主口径+flip）重建等价判定。 */
      const _lvlBd = (lvlDiffVsReal != null ? lvlDiffVsReal : (lvlDiffTable != null ? lvlDiffTable : bdLvlDiff));
      const _lvl2 = !!(_lvlBd != null && Math.abs(_lvlBd) >= 2 && !lvlFlip);
      /* ★ 大热必死 = (③盘破缺口 或 盘级差≥2) 且 三盘合流(①同指+②不顺应) */
      const _yanggeBreak = (_ygBreak || _ygLv2 || _lvl2);                   // ③盘现象（破缺口 或 盘级差≥2）
      if (_yanggeBreak && _triFlow){
        heatTier = 'hot';               // ★ 洋哥大热必死：③盘破缺口/盘级差≥2 + ①盘同指 + ②盘365不顺应
      } else if (_yanggeBreak && _follow2){
        heatTier = 'normal';            // ②盘365顺应资金 = 正常吃水盘（葡萄牙型），洋哥明言不判大热
      } else if (_yanggeBreak && _sideOk1 && !_has2){
        heatTier = 'mid';               // ①盘同指但缺②盘数据 → 无法完成三盘合流，降级预警（不判大热）
      } else if (_yanggeBreak && !_sideOk1){
        heatTier = 'small';             // ③盘破缺口但①盘不同指 → 单因子拥挤，降级小热
      } else if (_ygBreakX >= 0.7 || ygDiff && ygDiff.max >= 10){
        heatTier = 'mid';               // 接近破缺口（超缺口0.7倍以上）或 差值≥10% → 预警
      } else if (ygDiff && ygDiff.max >= 5){
        heatTier = 'small';             // 差值5~10% 小热（观察）
      } else if (_bdFlipSane){
        heatTier = 'flip';              // 翻转型（北单把弱势方买到翻转盘口）单独成档
      } else {
        heatTier = 'normal';
      }
    } else if (hotIdx != null){
      // 必发源：沿用澳客冷热指数（洋哥明言必发不反映球队购买热度，仅供热度榜，不进三盘判定）
      if (hotIdx >= 50 || (heatExcessEff != null && heatExcessEff >= _hotThr)) heatTier = 'hot';
      else if (hotIdx >= 15 || (heatExcessEff != null && heatExcessEff >= _warnThr)) heatTier = 'mid';
      else if (hotIdx >= 5  || (heatExcessEff != null && heatExcessEff >= 3)) heatTier = 'small';
      else heatTier = 'normal';
    } else if (heatExcessEff != null){
      if (heatExcessEff >= _hotThr) heatTier = 'hot';
      else if (heatExcessEff >= _warnThr) heatTier = 'mid';
      else if (heatExcessEff >= 3) heatTier = 'small';
      else heatTier = 'normal';
    } else if (heatShare != null && heatShare >= 45){
      heatTier = 'small';
    }
    if (!_liqOk) heatTier = 'normal';   // 流动性不足 → 噪声，热度档强制 normal（不显示任何过热）
    /* ★ 兼容层：旧代码/UI 多处读 'hot'/'mid'/'small'，新标尺的 extreme/formal 需映射回旧档名，
       否则三盘板/热度榜会出现未知名词。映射：extreme→hot, formal→hot, mid→mid, small→small, normal→normal。
       注意：**正式过热 = formal 及以上（≥+4pt）**，与 stakePlan 的 _gradeNeed(4) 完全一致。 */
    const heatTierLegacy = (heatTier === 'extreme' || heatTier === 'formal') ? 'hot'
                         : (heatTier === 'flip') ? 'flip'
                         : (heatTier === 'mid' ? 'mid' : (heatTier === 'small' ? 'small' : 'normal'));
    // ★ 2026-10-31：新标尺下"正式过热" = extreme 或 formal（≥+4pt）；旧 'hot' 档名由 heatTierLegacy 承载。
    const _moneyHot  = (heatTier === 'extreme' || heatTier === 'formal' || heatTier === 'hot');
    const _moneyWarn = (heatTier === 'mid');
    // ★ 2026-10-21 修正：洋哥案例②「赔率抬升型大热」——看好方(最低赔方)临场赔率不降反升(favMv≤-3，书商被迫抬赔防单边资金涌入)，
    //   且其临场仍为明显热门(favClose≤2.2) → 与①资金池型同源的「真热」信号。原代码仅把 driveForce 当展示文案、从不触发大热必死，
    //   导致欧冠/西甲等北单未覆盖、但大众盲目追热的场(如斯图加特/马竞)被漏判。现升级为 isHot 真信号（不依赖北单/必发资金池）。
    const favSide = (bh!=null && ba!=null) ? (bh <= ba ? 'W' : 'L') : null;
    const favMv = favSide==='W' ? mv_h : (favSide==='L' ? mv_a : 0);
    const favClose = (favSide==='W' ? bh : (favSide==='L' ? ba : null));
    // ★ 赔率抬升型大热（洋哥案例②）：看好方临场赔率不降反升，书商被迫抬赔防单边资金涌入 = 真热信号（不依赖北单/必发资金池）
    const oddsRiseHot = favSide && favMv <= -15 && favMv >= -35 && favClose != null && favClose <= 2.2;
    // ★ 2026-10-21 洋哥「市场大热」线索(用户选B·不依赖北单)：临盘热门方赔率极低 = 大众扎堆的超级热门(名气队低赔)，
    //   与①资金池型/②赔率抬升型同源的"真热"破绽类型。限定主流联赛(名气队语境)避免低级别联赛强队噪声过度膨胀精选池。
    //   ⚠ 阈值演进：1.65 → 1.70 → **1.75**（2026-10-21 用户拍板放宽）。
    //     实证样本：斯图加特(德甲,临盘1.67)、马竞(西甲,临盘1.70) 卡在 1.65~1.70，故先抬到 1.70；
    //     1.70 时曼城(英超1.73)、马拉加(西甲1.73)、不莱梅(德甲1.75) 这类名气队低赔仍被漏，用户要求放宽 → 定 1.75。
    //     这类"低赔名气队"不能只靠北单（实测马竞场北单主1.16 ↔ 欧赔客1.67 方向矛盾）→ 市场大热必须是独立可抓的机制。
    const MH_ODDS_MAX = 1.75;   // ★ 市场大热阈值（面板会逐场展示「临盘 X.XX / 阈值 1.75」自证）
    const MAIN_LEAGUES = ['英超','西甲','德甲','意甲','法甲','荷甲','葡超','苏超','比甲','奥甲','瑞超','挪超','丹超','土超','捷甲','希超','波甲','罗甲','塞尔','克甲','乌超','匈甲','保甲','斯甲','芬超','爱超','挪','土','荷','捷','瑞','欧冠','欧联','欧协','欧会','欧罗巴','欧国联','欧青','欧冠杯','巴甲','巴西甲','阿甲','美职业','美冠联','墨西联','墨西甲','中超','日职','日职联','韩K','K联赛','沙地','沙特联','澳超','世界杯','欧洲杯','亚洲杯','美洲杯','非洲杯','解放者','南美杯','世俱','足总杯','国王杯','德国杯','意大利杯','法国杯','英联杯'];
    const isMainLeague = (lg) => { if (!lg) return false; return MAIN_LEAGUES.some(k => lg.indexOf(k) >= 0); };
    // ★ 2026-10-21 命中率修复：市场大热加「轻过热确认」护栏。纯"名气队低赔但无真实资金过热"是亏钱信号
    //   （回测：低赔热门无过热确认批 站对面下狗命中仅20%、ROI −68.6%）——名气队低赔≠必死，热门方胜率42.9%，机械站对面直接亏。
    //   故 marketHeavy 成 PICK 线索需满足：(任何真实源 heatExcessEff≥8) 或 (赔率抬升型 favMv∈[-35,-15])。
    //   仅"低赔名气·公平受注"的场退为「展示标记」(yg.marketHeavy 仍=true，看板照常标出斯图加特/马竞类，不漏标)，但不再机械站对面下注。
    const _mhHasHeat = (heatUsable && heatExcessEff != null && heatExcessEff >= _warnThr) || !!oddsRiseHot;
    const marketHeavy = favSide && favClose != null && favClose <= MH_ODDS_MAX && isMainLeague(league) && _mhHasHeat;
    const isHot = (heatUsable && _moneyHot) || !!oddsRiseHot;
    const isHotWarn = heatUsable && !_moneyHot && _moneyWarn;
    const heatKind = oddsRiseHot ? 'odds-rise' : (!heatUsable ? null : (_moneyHot ? 'money' : (heatTier === 'mid' ? 'money-warn' : 'money-mild')));
    if (oddsRiseHot){ heatExcess = +((-favMv) * 0.8).toFixed(1); }  // 展示用：赔率抬升幅度≈覆盖drop代理（巴萨案例 favMv≈-18.6 → ≈+15pt）
    // 洋哥"不败资金"口径：热门方 + 平局 的合计资金占比（案例① = 66.9%，原文"接近7成"）
    const unbeatenShare = (heat && heatSide && heatSide !== 'D')
      ? +(((heat[heatSide]||0) + (heat.D||0))).toFixed(1) : null;
    const hotUnbeaten = unbeatenShare != null && unbeatenShare >= 65;
    // 驱动力：基本面看好方（临场最低赔率方）赔率是否"不降反升"（favSide/favMv 已在上方大热判定段定义）
    let driveForce = '—';
    if (favSide && favMv <= -3) driveForce = '主动异常·真热(看好方赔率不降反升)';
    else if ((dp===0&&dh===0) || (Math.abs(dp==null?9:dp)<=0.25 && Math.abs(dh==null?9:dh)<=0.10)) driveForce = '被动·资金平衡(正常)';
    else driveForce = '混合·待人工判断';
    const problemPan = !!kuopan;                       // |pan_gap|≥1.0 = 问题盘/错盘
    const isWater = (!kuopan) && !isHot && (pan_gap==null || Math.abs(pan_gap)<=0.25)
                    && (driveForce==='被动·资金平衡(正常)') && hits.length===0;  // 吃水盘
    // 三盘一致性：一盘(资金趋势 s_flow/s_pan) · 二盘(驱动力) · 三盘(热度) 是否同指"对面"
    const danceDir = isHot ? ({W:'L',D:'—',L:'W'}[heatSide]) : (problemPan ? (s_pan_kb==='W'?'W':s_pan_kb==='L'?'L':'—') : '—');
    const sanPan = (isHot && danceDir && danceDir!=='—' && dir_===danceDir) ? '一致·强化'
                 : (isHot && danceDir && danceDir!=='—' && dir_!==danceDir && dir_!=='信号不足·观望' && dir_!=='平局概率高·回避' && dir_!=='信号矛盾·观望' && dir_!=='信号偏弱·观望' && dir_!=='势均力敌·无参考' && dir_!=='仅初盘·'+heatSide) ? '背离·警惕'
                 : '—';
    // ★ 2026-10-11 #294：真实资金流速差 —— 必发占比 即时−初盘（投注窗口内的资金流向加速度）。
    //     洋哥自传无"速率差"词；这是把"资金占比变化"诚实量化的版本：某方占比在投注窗口内
    //     净增越多 = 资金越在加速涌向该方 = 强化/确认大热（不作为独立严格线索，仅增强已有信号）。
    let betfaFlow = null;
    try {
      if (betfa && betfa.open && [betfa.open.W, betfa.open.D, betfa.open.L].every(v => v != null) && bf) {
        const dW = +(bf.W - betfa.open.W).toFixed(1);
        const dD = +(bf.D - betfa.open.D).toFixed(1);
        const dL = +(bf.L - betfa.open.L).toFixed(1);
        const arr = [['W', dW], ['D', dD], ['L', dL]];
        const hi = arr.reduce((b, x) => x[1] > b[1] ? x : b, ['W', -999]);
        betfaFlow = { W: dW, D: dD, L: dL, dir: hi[1] > 0.5 ? hi[0] : '—', mag: hi[1] > 0 ? +hi[1].toFixed(1) : 0,
                      t_open: betfa.t_open || null, t_now: betfa.t_now || null };
      }
    } catch (e) { betfaFlow = null; }
    /* ★ 2026-10-21 洋哥②「二盘设防」工程化（v1 = 观察期信号：展示+入账日跟踪，暂不改 conf/tier）：
       一盘（水位流速）= 全市场各公司欧赔(临−初)同侧变动中位数 mktMv，降幅最大方=流速热方；
         洋哥判据：某方单边降 0.13~0.20 = 大热（取下限 0.13 为 hot1 触发线）。
       二盘（365设防）= Bet365 同侧变动 b365Dv：
         ≤−0.05 跟随降水 = 设防（承认热度、控赔付）→ 反买需谨慎；
         ≥+0.03 反向升水 = 不设防（不怕热方资金、敞开收）→ 洋哥"大热必死"确认信号（站对面）；
         其间 = 按兵不动（观望）。
       与资金源热度(北单/必发)独立——纯赔率走势即可算，覆盖全部有赔率历史的场。 */
    /* ★ 2026-10-22 洋哥一盘=竞彩官方：竞彩官方胜平负(had)为"无人工操盘"的纯净资金锚点（自传193行明确一盘=竞彩官方）。
       注：本 feed 的 jingcai.json 仅含单点 had 赔率、无初→临历史，故只能取"竞彩官方当前隐含热门方"与北单(三盘)做一致性校验，
           无法复现洋哥"初→临资金趋势"完整走势——这点已向用户说明，完整接入需竞彩官方初盘快照。 */
    let jcHotSide = null, jcOdds = null;
    try {
      const _jc = (JC_ROWS || []).find(r => _jcNameEq(home, r.home) && _jcNameEq(away, r.away));
      if (_jc && _jc.had && _jc.had.h && _jc.had.a && _jc.had.d){
        const _jo = { W: +_jc.had.h, D: +_jc.had.d, L: +_jc.had.a };
        if (_jo.W > 1 && _jo.D > 1 && _jo.L > 1){
          jcOdds = _jo;
          const _arr = [['W',_jo.W],['D',_jo.D],['L',_jo.L]];
          jcHotSide = _arr.reduce((b,x)=> x[1] < b[1] ? x : b, _arr[0])[0];
        }
      }
    } catch(e){}
    let pan2 = null;
    try {
      const mm = agg && agg.mktMv, b3 = agg && agg.b365;
      if (mm && mm.n >= 3){
        const _mv = [['W', mm.h], ['D', mm.d], ['L', mm.a]].filter(x => x[1] != null && isFinite(x[1]));
        if (_mv.length === 3){
          const _lo = _mv.reduce((b2, x) => x[1] < b2[1] ? x : b2, _mv[0]);   // 降幅最大 = 流速热方
          const flowSide = _lo[0], flowDv = +(+_lo[1]).toFixed(2);
          const hot1 = flowDv <= -0.13;                                       // 洋哥一盘大热线（单边降0.13~0.20）
          let b365Dv = null, def = null;
          if (b3 && b3.o_h != null && b3.c_h != null){
            const _bo = { W: +b3.o_h, D: +b3.o_d, L: +b3.o_a }, _bc = { W: +b3.c_h, D: +b3.c_d, L: +b3.c_a };
            if (isFinite(_bo[flowSide]) && isFinite(_bc[flowSide])){
              b365Dv = +(_bc[flowSide] - _bo[flowSide]).toFixed(2);
              def = (b365Dv <= -0.05) ? 'follow' : ((b365Dv >= 0.03) ? 'fade' : 'flat');
            }
          }
          const verdict = !hot1 ? 'calm'
                        : (def === 'fade' ? 'fade' : (def === 'follow' ? 'follow' : (def == null ? 'no365' : 'flat')));
          pan2 = { side: flowSide, mktDv: flowDv, n: mm.n, b365Dv, hot1, def, verdict };
        }
      }
    } catch(e){ pan2 = null; }
    /* ★ 2026-10-29 一盘·竞彩偏差落地（承接上方注释）：竞彩三项赔率先按自身返还率归一（Rjc/odds），
       再与 365 即时欧赔的含返还率隐含（R365/odds）在竞彩热门方上做差（pt）。正 = 竞彩资金比 365 更看好该方
       （洋哥：竞彩官方=无人工操盘的纯净资金锚点，散户钱堆出来的倾斜）。仅展示，不进触发。 */
    let jcDev = null, jcFairShare = null, euFairShare = null;
    try {
      if (jcOdds && jcHotSide && _ocoR && _ocoR.every(v => v > 1) && _R365 != null){
        const _jcArr = [jcOdds.W, jcOdds.D, jcOdds.L];
        if (_jcArr.every(v => isFinite(v) && v > 1)){
          const _inv = _jcArr.map(v => 1/v), _Rjc = 1 / _inv.reduce((a,b)=>a+b,0);
          const _jcF = _jcArr.map(v => _Rjc / v);                   // 竞彩归一（含自身返还率）
          const _euF = _ocoR.map(v => _R365 / v);                   // 365 归一（同口径，可比）
          const _i = jcHotSide === 'W' ? 0 : (jcHotSide === 'D' ? 1 : 2);
          jcFairShare = +(_jcF[_i]*100).toFixed(1);
          euFairShare = +(_euF[_i]*100).toFixed(1);
          jcDev = +((_jcF[_i] - _euF[_i]) * 100).toFixed(1);
        }
      }
    } catch(e){ jcDev = null; }
    /* ★ 2026-10-31 判据一补「盘级通道」——《关于资金流速详解》原文判据，此前只做了 pt 差，缺了这条：
       洋哥：竞彩官方=无人工操盘的纯净资金锚点；把竞彩赔率换算到 365 相同返还率后，看它隐含的**亚盘盘级**
       与真实亚盘的差——"只要不超过一个盘级（0.25）都可以基本判定属于正常范围"，超过即资金流速异常。
       原文两例可复算：捷克vs南非 竞彩1.59×(94.59/88.59)=1.70→半一低水(3级) vs 亚盘1.85半球低水(2级) 差1级=异常；
       葡萄牙vs乌兹别克 竞彩(-2)1.88→换算2.03≈2.25低水 vs 亚盘最终2.25低水 差0=正常。
       故 jc.lvlDiffUp ≥1（竞彩把该方买深≥1个盘级）才算①盘验证通过。 */
    let jcLvlDiff = null, jcLvlDiffUp = null, jcConvUp = null, jcLvlTag = null;
    try {
      if (jcOdds && jcHotSide && _R365 != null && p1 != null && isFinite(+p1)){
        const _ja = [jcOdds.W, jcOdds.D, jcOdds.L];
        if (_ja.every(v => isFinite(v) && v > 1)){
          const _Rjc2 = 1 / _ja.map(v => 1/v).reduce((x,y)=>x+y,0);
          const _conv = _ja.map(v => v * (_R365 / _Rjc2));       // 换算到与 365 相同返还率
          const _ji = jcHotSide === 'W' ? 0 : (jcHotSide === 'D' ? 1 : 2);
          if (_ji !== 1){
            const _L2 = yanggeHcapLevel(_conv[_ji], false);
            if (_L2){
              const _sgn2 = (_ji === 0) ? 1 : -1;                // 主队视角：客队让球取负
              const _real2 = (+p1) / 0.25;                       // 真实亚盘盘级（正=主队让球）
              jcConvUp = +_conv[_ji].toFixed(2);
              jcLvlTag = _L2.tag;
              jcLvlDiff = +((_sgn2 * _L2.lvl) - _real2).toFixed(2);
              jcLvlDiffUp = +(_sgn2 * jcLvlDiff).toFixed(2);      // >0 = 竞彩把「竞彩热门方」买深了 N 级
            }
          }
        }
      }
    } catch(e){ jcLvlDiff = null; jcLvlDiffUp = null; }
    yg = {
      heatSide, heatShare: +heatShare.toFixed(1), fairProb: fairProb!=null?+(fairProb*100).toFixed(1):null,
      pan2,                                                                 // ★ 2026-10-21 洋哥②二盘设防（观察期信号）
      marketHeavy: !!marketHeavy,                                           // ★ 2026-10-21 洋哥「市场大热」线索：临盘热门方≤MH_ODDS_MAX 的主流联赛名气队(不依赖北单)
      mhMax: MH_ODDS_MAX,                                                   // ★ 市场大热阈值本身（面板逐场展示「临盘 X.XX / 阈值 1.75」用，改阈值自动同步）
      favClose: favClose!=null?+favClose.toFixed(2):null, favSide: favSide,  // 临盘热门方赔率/方向（市场大热判据原始值，面板展示用）
      favMv: favMv!=null?+favMv.toFixed(1):null,                            // ★ 热门方初→临盘变动率%（赔率抬升型判据原始值，面板阈值自证用）
      bdDirOk: _bdDirOk, bdFav: _bdFav, euFav: _euFav,                      // ★ 2026-10-21 北单行方向护栏：bdFav=北单热门方, euFav=欧赔热门方, bdDirOk=false=两者相反(错行)→该行热度不可信
      bdFlip: _bdFlip, bdFlipSane: _bdFlipSane,                             // ★ 2026-10-31 真·盘口翻转（洋哥美伊型）与其数据质量判定；flipSane=true 时 heatUsable 放行
      deepHeat: { deep: deepPlate, adjPt: deepAdj, eff: heatExcessEff },    // ★ 2026-10-21 洋哥④深盘+1级修正（eff=判定用超买pt）
      /* ★★ 2026-11-04 洋哥《北单赔率池赔率查询网址.txt》主判定：未归一赔率差值%>15% 判大热 */
      ygDiff: ygDiff,                                                       // 洋哥差值% 主判档量（北单源）
      heatExcess: heatExcess!=null?+heatExcess.toFixed(1):null, heatExcessEff: heatExcessEff!=null?+heatExcessEff.toFixed(1):null, isHot, isHotWarn,
      daHot: _daHot,                                                        // ★ 2026-10-22 洋哥定性大热（差值>返还率缺口，自传174行，无+12缓冲）
      jc: (jcHotSide ? { hotSide: jcHotSide, odds: jcOdds, dev: jcDev, jcFair: jcFairShare, euFair: euFairShare,
                         lvlDiff: jcLvlDiff, lvlDiffUp: jcLvlDiffUp, convUp: jcConvUp, lvlTag: jcLvlTag } : null), // ★ 2026-10-31 补盘级通道（资金流速详解原文）
      /* ★ 2026-10-30 终校·判据二主口径修正：bd 不再用线性映射(linear)，改 vsReal 查表法（洋哥原图口径，热刺复现 −5 级）。
         原因：此前 UI 已优先读 vsReal，但引擎 lvlDiff.bd 主字段仍= linear 线性值（热刺 −2.98），
         二者不一致导致读数表有时显示线性值、有时查表值。现统一：主口径=vsReal(有真实亚盘)否则 table(两侧同法)，
         linear 仅作对照（原文"盘无定式"，故保留并列展示）。 */
      lvlDiff: { bd: (lvlDiffVsReal != null ? lvlDiffVsReal : (lvlDiffTable != null ? lvlDiffTable : bdLvlDiff)),
                 bdExp: bdExpHcap, euExp: euExpHcap,
                 bdTbl: bdLvlTbl, euTbl: euLvlTbl, table: lvlDiffTable,
                 bdTag: bdTblTag, euTag: euTblTag, euRealLvl, vsReal: lvlDiffVsReal,
                 linear: bdLvlDiff, flip: lvlFlip },   // ★ 洋哥判据二·三口径：bd=主口径(vsReal优先) / table=两侧同法 / vsReal=北单查表 vs 365真实亚盘(Excel原图) / linear=连续映射(对照) / flip=方向相反(错行)
      heatExcessAlt, heatExcessAltSide,   // ★ 判据一第二口径（洋哥 Excel 表：换算后隐含 − 365不归一隐含），与 heatExcess(归一差·自传口径) 并列
      excessModel: excessModel!=null?+excessModel.toFixed(1):null, heatKind: heatKind,  // 2026-10-10 方向①：模型背离源 + 来源标注
      heatTier, heatTierLegacy,                                                       // ★ 2026-10-31 唯一标尺分档 extreme/formal/mid/small/normal（+ 旧档名兼容 hot/mid/small/normal）
      netPt,                                                                          // ★ 净超买 pt（= 绝对偏差 − 返还率缺口）；非真实资金源恒 null（杀 ppi 噪声）
      excessPt,                                                                       // ★ 绝对偏差（占比−公平胜率+深盘修正），仅供洋哥判据一 daHot 对照
      netTierNeed: YG_NET_TIER,                                                       // ★ 标尺阈值本身（{extreme:6,formal:4,mid:2}），改阈值 UI 自动同步
      hotIdx: hotIdx!=null?+hotIdx.toFixed(0):null, hotSideIdx,                       // ★ 2026-10-16：统一资金热度分档（正式过热/中热/小热/正常热）
      heatDomain, heatUsable, unbeatenShare, hotUnbeaten,
      hotThr: _hotThr, heatGap: _heatGap, hotBuffer: YG_HOT_BUFFER_PT,   // ★ 2026-10-22 洋哥相对缺口动态门槛（ui自证列用）
      hotGate: { excess:HOT_EXCESS_PT, warn:HOT_WARN_PT, src:heatSrc },
      driveForce, problemPan, isWater, danceDir, sanPan,
      pan_gap: pan_gap!=null?+pan_gap.toFixed(2):null,
      exp_hcap: exp_hcap!=null?+exp_hcap.toFixed(2):null,
      heatSrc: heatSrc,                                   // 'beidan'(北单赔率池) | 'betfa'(必发真占比·破禁) | 'model'(赔率vs模型背离·破定义) | 'ppi'(代理) | 'na'
      oddsSrc: (agg && (agg.euSrc || agg.asiaSrc)) ? (agg.euSrc && agg.euSrc!=='none' ? agg.euSrc : agg.asiaSrc) : null,  // 主盘口取自哪家公司
      bd: bd ? { rq: bd.rq, sp: bd.sp, pct: [bd.W, bd.D, bd.L] } : null,   // 北单赔率池：让球/三项赔率/真实资金占比%
      triFlow: triFlow || null,                       // ★ 2026-10-14 #319：三盘·流速差（北单SP隐含 vs 欧赔即时隐含）
      bf: bf ? { pct: [bf.W, bf.D, bf.L] } : null,  // 2026-10-10 必发真投注占比%（破禁启用）
      betfaFlow                                       // ★ 2026-10-11 #294：真实资金流速差（即时−初盘占比，dir/mag/t_open/t_now）
    };
    // 洋哥式确认/降权（仅增强已有信号，不制造新信号，避免回归基准）
    if (isHot && danceDir && danceDir!=='—'){
      if (dir_===danceDir && (dir_==='W'||dir_==='L')){
        conf = Math.min(90, conf + 6);                 // 大热+模型同向→强化
        if (vote) vote.score = +(vote.score + 6).toFixed(1);
      } else if (dir_===heatSide && (dir_==='W'||dir_==='L')){
        conf = Math.max(0, conf - 12);                // 大热方+模型也选它→危险，降权
      }
    }
  } catch(e){ yg = null; }

  /* 方向判词 → 纯 W/D/L 代码（单一实现，终局门后再重算一次）。
     ⚠ 认"平"字判 D 是有代价的：'平局观察·不下注方向' 也含"平"，所以终局平局门必须显式把
       dirCode 清回 '—'，否则 321 场"不下注的平局"会重新污染方向分母（2026-10-01 踩过）。
     ⚠ 末尾形如 '仅初盘·W' 的字母后缀兜底：拼串时误用 W/D/L 字母会比不出中文，
       归约静默返回 '—' → 引擎明明给了方向却不算方向（2026-10-03 修：134 场"仅初盘"方向被丢）。*/
  const dirCodeOf = s => (s==='W'||s==='L'||s==='D') ? s
                       : (typeof s==='string' && s.indexOf('主胜')>=0) ? 'W'
                       : (typeof s==='string' && s.indexOf('客胜')>=0) ? 'L'
                       : (typeof s==='string' && s.indexOf('平')>=0) ? 'D'
                       : (typeof s==='string' && /[·:]([WDL])\s*$/.test(s)) ? s.match(/[·:]([WDL])\s*$/)[1]
                       : '—';
  let dirCode = dirCodeOf(dir_);                       // 此值供贺式块/纠错回灌使用（终局门后重算，见下）
  let dirText = dir_;                                  // 终局判词原文，缩略展示"为什么没方向"

  /* ====== 贺的足球己见（工程化自《贺的足球己见》2026-5-20）======
     纯叠加层：只做"谨慎/增强/标注"，不造新方向、不破坏已校准基准。
     ① 浅盘诱上：强队(低赔)本应深让，实际初盘显著浅开(pan_gap≤−0.5) → 盘口力量不足、变相支持弱队
        （贺："看起来特别舒服的盘最危险，反买弱队加号"）。强队方向降权、反买弱队。
     ② 一致性过热+升盘放大情绪：大热且热门方向盘口加深(向热门让更多) → 与庄共舞反向，强谨慎。
     ③ 大小球中线与半场破蛋：初盘大球线≥2.75 → 上半场破蛋区(贺:卡20-25min≈70%胜)，增强半全场有球。
     ④ 水位纪律：选中方赔率<1.9 → 压价值(贺:"低于1.9每低10%需胜率高10%弥补")；≥1.9 → 优质水位提价值。
     ⑤ 比分锚定：让分档位+大小球中线，给贺式推荐比分(仅提示，不改分布)。 */
  let he = null, s_he = '—';
  try {
    const favOdds = (fav==='W') ? o0h : (fav==='L' ? o0a : null);
    const strongFav = (favOdds!=null && favOdds < 1.9);
    const shallow = (pan_gap != null && pan_gap <= -0.5);          // 实际初盘浅于预期
    const he_shallow = strongFav && shallow;
    const raiseForFav = (fav==='W' && dp!=null && dp<0) || (fav==='L' && dp!=null && dp>0); // 热门方向盘口加深=升盘
    const he_hot_raise = (yg && yg.isHot) && raiseForFav;
    const ouLine = (aggBs && aggBs.o_line!=null) ? aggBs.o_line : null;
    const he_halfgoal = (ouLine!=null && ouLine >= 2.75);
    let heScoreTip = '—';
    if (fav==='W') heScoreTip = (ouLine!=null && ouLine>=2.5) ? '主胜比分看 2-0 / 2-1（主队进球强加 3-1）' : '主胜小比分看 2-0 / 1-0';
    else if (fav==='L') heScoreTip = (ouLine!=null && ouLine>=2.5) ? '客胜比分看 0-2 / 1-2（客队进球强加 1-3）' : '客胜小比分看 0-2 / 0-1';
    const heNote = [];
    if (he_shallow){ s_he = (fav==='W')?'L':'W'; heNote.push('浅盘诱上·强队未获应有支持→反买弱队'); }
    if (he_hot_raise){ heNote.push('大热+升盘放大情绪·与庄共舞反向'); }
    if (he_shallow && (dirCode===fav) && (dirCode==='W'||dirCode==='L')){
      conf = Math.max(0, conf - 10);
      if (vote) vote.score = +(vote.score - 10).toFixed(1);
      // 2026-09-23 修正：仅当重标定未祝福(value_score<TIER1_GATE)时才用贺式低conf纪律降级，
      // 否则会误杀"带盘口浅盘 conf<40 但标定命中≥56%"的场（recalibValue 已用真实命中率兜住）。
      if (conf < 40 && tier>=1 && !_deep && value_score < TIER1_GATE){ dir_='浅盘诱上·观望'; tier = 0; vote = null; }
    }
    if (he_hot_raise && (dirCode===fav) && (dirCode==='W'||dirCode==='L')){
      conf = Math.max(0, conf - 8);
      if (vote) vote.score = +(vote.score - 8).toFixed(1);
    }
    let waterNote = '';
    const pickOdds = (dir_==='W') ? (bh!=null?bh:o0h) : (dir_==='L' ? (ba!=null?ba:o0a) : null);
    // 2026-09-23 修正：水位信息仅作展示(waterNote)，不再改写 value_score。
    // 因 value_score 已 = recalibValue 标定的诚实命中率(表由"原始 value"拟合)，事后乘 0.9/1.03
    // 会令"tier1 浅盘"展示值跌破 56% 与决策矛盾，且破坏标定口径。
    if (pickOdds!=null && (dir_==='W'||dir_==='L')){
      if (pickOdds < 1.9){ waterNote='低水<1.9·贺式控水压价值'; }
      else if (pickOdds >= 1.9){ waterNote='高水≥1.9·贺式优质水位'; }
    }
    he = { he_shallow, he_hot_raise, he_halfgoal, ouLine, heScoreTip,
           shallow_gap: (pan_gap!=null?+pan_gap.toFixed(2):null),
           note: heNote.join('；') || '—', water: waterNote || '—', s_he };
    if (heNote.length) conf = Math.min(92, conf);
  } catch(e){ he = null; s_he = '—'; }

  /* ---------- 选择性纪律 grade（回测依据 attr_audit.cjs 5042场）----------
     实测：agree(临场最优∩移动双确认)=55.9% / fav-only=51.8% / draw平局候选=27.6%(负贡献) / 市场基线=49.2%。
     全推被 draw 稀释到 ~49%。故设三档，只把"双重确认 + 市场优势够大"列推荐，避免全推稀释。
     分层实测：agree & mx≥0.55 → 68.0%(n=550)；再叠 payAgg≥0.93 → 90.2%(n=51)。 */
  let grade='观望', grade_reason='无有效信号', strongDraw=false, strongDrawHot=false;
  // 平局信号卡强弱标记：无论主推荐是否为平局，只要信号卡触发即反映（驱动UI金徽章/筛选）
  strongDraw = dcard.fire && dcard.score >= 5.0;
  strongDrawHot = dcard.level === '强';
  const mxFav = Math.max(mk_h||0, mk_d||0, mk_a||0);          // 临场市场最热方概率
  const vSrc = (vote && vote.source) || '';
  const payAgg = (agg.c_h && agg.c_d && agg.c_a) ? 1/(1/agg.c_h+1/agg.c_d+1/agg.c_a) : null;  // 多公司合成返还率(定价干净度)
  if (vote && (vSrc==='agree' || vSrc==='ppi-strong' || vSrc==='betfa')){
    if (mxFav >= 0.55){ grade='推荐'; grade_reason=`双重确认+市场优势${(mxFav*100).toFixed(0)}%`; }
    else { grade='参考'; grade_reason=`双重确认但优势偏小(${(mxFav*100).toFixed(0)}%)`; }
  } else if (vSrc==='fav-only'){
    grade='参考'; grade_reason='仅热门方·无临场移动确认';
  } else if (vSrc==='draw-card'){
    /* 平局信号卡（新范式）：方法论驱动（让方被否定+平赔思维+洼地+初盘偏离）。
       经验证(7天4084场真实完赛)整体精确率≈基准平局率(22%)，无显著投注edge；
       故平局信号卡定位为"庄家视角问题盘筛选/观察清单"，绝不给下注级(推荐/tier1)。
       仅"逆拉双分平(金标准·回测27.5%有微edge)"且≥5分可给参考级(轻仓观察)。 */
    strongDraw = dcard.score >= 5.0;
    strongDrawHot = dcard.level === '强';
    const drawEdge = (dcard.tag === '逆拉双分平' && dcard.score >= 5.0);
    if (drawEdge || dcard.score >= 6.0){ grade='参考'; tier=Math.max(tier,2); }
    else { grade='观望'; tier=0; }
    grade_reason = `平局信号卡【${dcard.tag}】${dcard.level}(${dcard.score.toFixed(1)}分)·庄家视角问题盘筛选` +
      (drawEdge ? '(逆拉双分平·回测精确率27.5%有微edge·轻仓参考)' : '(经验证精确率≈基准平局率,非自动下注,仅观察)') +
      '：' + dcard.reasons.join('；');
  } else if (vSrc==='draw' || vSrc==='agree-D'){
    // 区分「强平局(相对最易平指示)」与「宽泛平局候选池(历史负贡献)」
    // 诚实实测(5042场·收盘口径): 市场头号=平 且 临场平赔<3.0 → 平局率~34%(n≈80)、整体负EV(-12%~-17%)；
    // 平赔<2.5 子区间 平局率~34%(n=73)。非高命中、非负EV，仅作"最易平"参考，不评级为可下注。
    const isStrongDraw = (agg.eu_valid!=null && agg.eu_valid>=3 && mk_d!=null && mk_h!=null && mk_a!=null && mk_d>=mk_h && mk_d>=mk_a && agg.c_d!=null && agg.c_d < 3.0);
    strongDraw = isStrongDraw;
    if (isStrongDraw){
      strongDrawHot = agg.c_d < 2.5;                       // 平赔<2.5 → 相对更集中(实测平局率~34%)
      grade='参考'; tier=2;
      grade_reason = strongDrawHot
        ? '强平局(相对最易平·市场头号+平赔<2.5, 实测平局率~34%/负EV·参考)'
        : '强平局(相对最易平·市场头号+平赔<3.0, 实测平局率~34%/负EV·参考)';
    }
    else { grade='观望'; grade_reason='平局候选·历史负贡献·不建议单独下注'; tier=0; }
  }
  if (payAgg!=null && payAgg>=0.92 && grade==='推荐'){ conf=Math.min(94, conf+4); grade_reason+=`·定价干净(${payAgg.toFixed(3)})`; }

  // ===== 价值分重标定撤回纪律(2026-09-23 从 2267 上移至此·修复 TDZ)=====
  // 浅盘(|p1|<1) + 已为下注级(tier>=1) + 标定命中<门槛 → 撤回下注级(tier=2/参考级)。
  // 必须在 grade 计算之后执行，才能对算出的 grade 正确降级；深盘(_deep)不受影响(下面深盘块会重新升回 tier1)。
  if (tier >= 1 && !(_deep || _calV >= TIER1_GATE)){
    tier = 2;                                            // 浅盘低价值 → 参考级(不可下注)
    if (grade === '推荐') grade = '参考';
    grade_reason = (grade_reason || '') + '·浅盘低价值(标定命中' + _calV + '%<' + TIER1_GATE + '%, 撤回下注级)';
  }

  /* 2026-09-22 修正：深盘(|p1|>=1)恒为下注级，绝不被上游低conf纪律/平局纪律降为观望(tier0)。
     结构性 edge 来自大让球强队，与 conf 高低无关；value_score 仍是诚实的标定命中率。
     例外：平局信号卡/平局候选(draw-card/draw/agree-D)本就定位"参考级/观察"，深盘叠加平局信号矛盾，
     尊重其纪律(不强行升下注级)。
     ⚠⚠ 2026-10-04 六修：追加「必须 _mkTier===1（市场热度真过门）」，**别删这一条**。
     起因：五修刚把 t1 门抬到 0.80（实测 95.2%），CDP 一看线上 t1=69 场里竟有 55 场 mk<0.80——
     全部是这条绕过把「球探 vip 反解通道」(_mkTier===null，无真实欧赔、mk 是让球盘反解出来的)的
     深盘强队硬抬进 t1。那 55 场在 gqj2 回测里**零覆盖**（_hslice4 记录 827 场给方向的样本中，
     深盘且 mk<0.80 的 tier1 场数 = 0 ⇒ 真欧赔通道下这条绕过从来没触发过，抬不抬都不影响已验证的池）。
     按「没验证过的通道不许挂『唯一能押钱的一层』」收口：t1 只允许 mk≥0.80 那批（95.2%、n=250）。 */
  /* ⚠⚠ 2026-10-04 六修续：这里再钉一道 **方向必须仍然有效**（主胜/客胜）才准抬 t1。
     第一版六修只加了 `_mkTier === 1`，CDP 复验发现线上 mk<0.80 的 t1 只从 55 掉到 44 ——
     剩下的样本里 `dir_ === '信号背离市场·观望'`（2811 行已判 tier=0）仍被这条块抬回 t1：
     因为它只看 _deep/_mkTier/tier<1，不看 dir_ 是不是观望串，而终局门(3220)只拦主胜/客胜，
     拦不住「观望」串 ⇒ 明确该下注观望的场被塞回可出手层。加此条件后，观望的方向不会被"深盘"复活。 */
  if (_deep && _mkTier === 1 && (dir_ === '主胜' || dir_ === '客胜') && tier < 1 && vSrc !== 'draw-card' && vSrc !== 'draw' && vSrc !== 'agree-D'){
    tier = 1;
    if (grade === '观望'){
      grade = '参考';
      grade_reason = (grade_reason && grade_reason !== '无有效信号') ? (grade_reason + '·深盘强队(恒下注级)') : '深盘强队·结构性正EV(恒下注级)';
    }
    // 深盘策略强制下注级：价值分兜底到策略下限，消除"下注级却价值分<56"的视觉矛盾。
    // 深盘策略命中率回测 ~63.8%，而 0-40 噪声桶标定值 45%(n=10) 不具代表性，兜底到 56 更贴近真实。
    if (value_score < TIER1_GATE){
      grade_reason = (grade_reason || '') + '·深盘策略兜底(标定命中'+value_score+'%→'+TIER1_GATE+'%)';
      value_score = TIER1_GATE;
    }
  }

  /* ====== 终局出手门（2026-10-01，线上千场实测驱动）======
     线上实测（1553 场带方向的完场）：tier1 方向 **71%**(n=696) ｜ tier2 **33%**(n=657) ｜ tier0 **13%**(n=200)。
     tier2/0 的"方向"是负贡献（33%≈瞎猜、13% 更差），只有 tier1 有 edge（71%，且该子集市场基准 76%）。
     故：终局只让市场强档(_mkTier===1)输出方向，tier2/tier0 一律清成观望。
     ⚠ 必须放在「浅盘低价值降级」与「深盘恒下注级」之后，否则会被这两个块的 tier 改写冲掉。
     ⚠ _mkTier===null 表示无欧赔(球探vip反解路径/fav-only)，那条路本来就不受市场热度约束，不动。 */
  if (_mkTier != null && _mkTier < 1 && (dir_ === '主胜' || dir_ === '客胜')){
    dir_ = '弱档·不出手·观望'; tier = 0; conf = 0;
  }

  /* ================= 2026-10-05 九修：pPick 门槛按「主/客」非对称 =================
   * 依据（_gate_lab2.cjs，live_log 2677 场已结算方向行，train<20260930 / test>=）：
   *   主胜 cut：0.60→74.1%(n609) 0.62→75.0 0.65→76.1 0.68→77.9 0.70→79.8(n262)
   *             0.72→81.8%(n214) 0.75→86.9%(n153) 0.78→89.3 0.80→90.3%(n72)
   *   客胜 cut：0.60→70.4%(n223) 0.62→72.5 0.65→74.3 0.68→78.6 0.70→79.5(n83)
   *             0.72→80.3%(n66)  0.75→92.5%(n40)  0.78→96.8%(n31)
   * 客胜整条曲线**系统性低 4~16pp**（同 cut 下 主 79.8% vs 客 79.5%@0.70 主攻客同，
   * 但 0.68 处主 77.9 / 客 78.6 已交叉；0.62~0.65 区间 主 75.0/76.1 vs 客 72.5/74.3）。
   * train/test 双向校验（同表 cut 组合，两侧单调同向、无反向跳）：
   *   主≥0.72 客≥0.75 → train 81.0%(n221) / test 80.5%(n41) / 全样本 80.9%(n262)
   *   主≥0.70 客≥0.70 → train 78.2%(n298) / test 76.4%(n55) / 全样本 77.9%(n353)
   *   主≥0.75 客≥0.75 → train 85.3%(n163) / test 83.8%(n37) / 全样本 85.0%(n200)
   * ⇒ 取 **主 0.72 / 客 0.75** 作 t1（80.9%，比原 0.70 对称门的 77.9% 再高 3pp，
   *   且 t1 池只从 353 缩到 262，日均仍够 15~25 场可下注），t2 取 **主 0.65 / 客 0.68**。
   * n 太小(<40)的切点（客≥0.78 只有 31 场）不给结论，宁可留 0.75 这个 40 场档。 */
  /* ================= 2026-10-05 八修：最终出手门改判「**押向**欧赔概率 pPick」 =================
   * ⚠ 上面 0.80/0.60 那道门只认 **市场 fav 概率**（_mkMax），它拦不住两类绕过它的下注层：
   *     ① 必发/澳客资金占比通道（2718 行 `conf=50; tier=1`，只要求占比 top>=50% 且 gap>=12，
   *        完全不看欧赔）；
   *     ② 无临场欧赔时 fallback 出的方向。
   * 这两类在 live_log 实盘对账里被单独切出来时，命中只有 43.8%(n=1293)——比瞎猜强一点，
   * 但足以把整条 bet 队列从 74% 拖到 55.7%。
   * 证据（_audit_blocks.cjs / _gate_lab.cjs，3862 场已结算真盘口+真赛果，train<20260930 / test>=）：
   *   pPick>=0.75  命中 88.1%(n=193)  train 88.0% / test 88.6%
   *   pPick 0.70~0.75 → 69.1%(n=152) train 70.1% / test 61.1%
   *       0.65~0.70 → 68.9%(n=209)  train 65.5% / test 84.2%
   *       0.60~0.65 → 68.0%(n=278)  train 67.4% / test 69.8%
   *       0.55~0.60 → 59.5%(n=294)  train 59.2% / test 61.1%
   *       0.50~0.55 → 55.4%(n=258)
   *       pPick<0.50 → 43.8%(n=1293) train 40.3% / test 53.5%
   * 单调、train/test 同向 ⇒ 用「我们真正押的那一方的市场概率」当最后卡口最省事，
   * 它一次同时完成三件事：禁止逆市场下注、拦掉无欧赔的瞎猜层、把下注池聚到 70%+ 那一档。
   * ⚠ pPick 从 dir_（中文串）反查 mk_h/mk_d/mk_a，取不到（无欧赔）时按 null 处理→观望，不猜数。
   * ⚠ 置信不归零：降的是 tier，方向照常在卡片上显示，UI 会按 t0 印「观望·不计命中」。 */
  {
    const _ds = String(dir_ || '');
    let _pPick = null;
    if (_ds.indexOf('主胜') >= 0) _pPick = (mk_h != null ? mk_h : (mk_d != null ? Math.max(mk_d, mk_a || 0) : null));
    else if (_ds.indexOf('客胜') >= 0) _pPick = (mk_a != null ? mk_a : (mk_d != null ? Math.max(mk_d, mk_h || 0) : null));
    else if (/^D$|平/.test(_ds)) _pPick = (mk_d != null ? mk_d : null);
    if (tier >= 1){
      const _keepTier = tier;
      /* ⚠ 八修定稿：**只看 pPick，不叠 conf**。
         二维网格（_grid_lab.cjs）显示 conf 在同一 pPick 行内只贡献 +1~2pp
         （pPick=0.62 那行：conf 50→74%、conf 80→76%），而 conf≥70 这个附加条件会把
         「有欧赔、pPick 过关、但引擎只给 conf58（旧 0.60~0.80 参考档）」的场整片砍成观望——
         2026-10-05 当天 275 场扫描因此一条下注级都不出（主胜下注级 4→截尾 0、客胜 0）。
         命中的是这个门槛，不是 conf，所以门只留 pPick。 */
      const _isHome = _ds.indexOf('主胜') >= 0;
      /* 🔴 二十一修（2026-10-05j）：把七修「盘口逆势剔除门」**真正接进终局裁决**。
         七修把它写在 _mkTier 块（~2922：`_mkTier===1 && wash.kind==='line'|'both' → _mkTier=2`），
         但本终局门在其后按 _pPick **无条件重算** tier —— mk≥0.80 的逆势场（_pPick 必然 ≥0.80）
         被原样抬回 t1，那道门**从未生效**。干净重跑铁证：新 t1 池里仍有 **43 场盘口逆势、命中 90.7%**，
         与七修注释里记的「43 场 90.7%」一字不差 = 一直躺着没落地。
         判据有独立大样本背书（真实赔率 5063 场：|Δh|≥0.25 反号跟 fav 65.0% n=386 z=5.08；≥0.5 73.2% z=5.22），
         故这不是"挑 4 场凑数"，是剔掉一个被独立验证为低质的子池。
         效果（同一次干净重跑）：t1 248 场/95.6% → **205 场/96.6%**（非逆势 96.6% 前 95.9/后 96.1；
         逆势组 90.7%，前 88.5/后 93.3，两段都低于非逆势 ⇒ 同向）；
         被剔的 43 场降到 t2 参考层（t2 116→159 场，命中仍 83.0%），不隐藏、只是不下注。 */
      const _washLine = !!(wash && (wash.kind === 'line' || wash.kind === 'both'));
      /* 🔴🔴 二十二修（2026-10-05k）：本门改为 **只降不升**。
         根因（_eval/_gate_audit.cjs 门审计，14 天 6656 场实测）：
         本块的入口条件是 `tier >= 1`，而 `tier` 在 JS 里 **2 也 >= 1** ——
         所以它不仅裁决 t1，也把上游纪律门降到 t2 的场**拉进来重算**：
            3369 浅盘低价值 「撤回下注级」→ tier=2 → 本门见 _pPick≥0.80 → tier=1（复活）
         实测 5 场被这样复活，grade_reason 里同时写着「撤回下注级」和「→tier1」，自相矛盾。
         ⚠ 这与七修 wash 门的死法是**同一个病**：门写了、也执行了，但结论被下游无条件重算抹掉。
           七修那次死因是「顺序」（写在 _mkTier 块，被本门覆盖）；这次死因是「重算」本身。
         处理：一旦上游把档降到 t2，本门**只允许维持或继续降**，不许升回 t1。
         依据（同批干净重跑）：被复活的 5 场命中 80.0%(n=5) vs t1 96.6%，方向与纪律一致；
         但真正价值在**结构**——此后任何新增的上游降级门都不会再被本门悄悄撤销（n=5 不作统计依据）。
         副作用实测：t1 205→200 场、命中 96.6%→97.0%（-5 场全是「浅盘低价值」那批，非噪声性代价）。 */
      if (_pPick == null){ tier = 0; }
      else if (_pPick >= (_isHome ? PICK_GATE.T1_H : PICK_GATE.T1_A)) tier = (_washLine || _keepTier === 2) ? 2 : 1;
      else if (_pPick >= (_isHome ? PICK_GATE.T2_H : PICK_GATE.T2_A)) tier = 2;
      else tier = 0;
      if (tier !== _keepTier){
        grade_reason = (grade_reason || '') +
          (tier === 0 ? '·押向市场概率' + (_pPick == null ? '缺失' : (+_pPick).toFixed(2)) + '<门槛(主≥' + PICK_GATE.T2_H + '/客≥' + PICK_GATE.T2_A + ')→观望'
                      : '·押向市场概率' + (+_pPick).toFixed(2) + '→tier' + tier);
      }
    }
  }

  /* ====== 平局禁用门（2026-10-01，千场实测驱动）======
     线上复盘实测：引擎输出 **321 场平局方向，只兑现 13%（41/321）**，
     而同一批场次的市场临场 fav 命中 **78%（251/321）** —— 差 65pp。
     真实平局率本就只有 ~7%，任何"平局强倾向"都是负 EV。
     故：终局不再输出任何平局方向，统一降级为「平局观察·不下注方向」(tier0/conf0)。
     ⚠ 必须在终局出手门之后、dirCode 归约之后重算 dirCode：归约把含"平"的串判成 'D'，
        而下面 3216 行改写的 '平局观察·不下注方向' 同样含"平"，不重算就是 321 场 D 类污染方向分母。 */
  if (typeof dir_ === 'string' && dir_.indexOf('平') >= 0){
    dir_ = '平局观察·不下注方向'; tier = 0; conf = 0;
    dirCode = '—'; dirText = dir_;                     // 终局平局门：明令不下注，dirCode 一并清零
  } else {
    dirCode = dirCodeOf(dir_); dirText = dir_;         // 终局重算：dirCode 必须反映最终是否真出方向
  }

  /* 盘口档位（理论 vs 实际）——见 gradeIndex/gradeTierOf 注释
     ⚠ 两侧都必须真实存在才计算：理论盘只认欧赔换算的 exp_hcap（不再用 a0 兜底，
       否则「实际盘缺 → 退回 a0」会与理论同源，算出恒 0 的无意义档位）。 */
  let g_t = null, g_a = null, g_net = null, g_tier = gradeTierOf(null), g_hcap_a = null, g_water_a = null, g_theory_src = 'na';
  {
    const hcapA = (p1 != null) ? p1 : a0;                       // 实际优先临场盘
    const waterA = (h1 != null) ? h1 : h0;                      // 实际优先临场水
    /* 理论档位来源（2026-09-23 修复·档位全空根因）：
       优先「初盘欧赔换算 exp_hcap」；但融合底板只存临场字段(o_h/o_hcap 缺失 → 初盘欧赔取不到)时，
       回退「临场欧赔换算」(o1h/o1d/o1a = agg.c_h/c_d/c_a，618/619 场齐备)。
       参考站「理论档位」= 欧赔换算预期盘；临场欧赔是该预期的当前市场版本，仍可作理论基准，
       使档位对全部有欧赔的场可算（否则 608/619 场理论档位恒 null → 档位全空）。
       副作用：理论/实际同源临场，净变化 = 「亚盘 vs 欧赔 的跨市场背离（同步点）」，
       含义仍为「亚盘较欧赔预期偏深(>0 偏热)/偏浅(<0 示弱)」，解释清晰。 */
    let g_exp = exp_hcap;
    g_theory_src = (g_exp != null) ? 'open' : 'na';
    if (g_exp == null && o1h && o1d && o1a){
      try { g_exp = expectedHcap(o1h, o1d, o1a); g_theory_src = 'live'; } catch(e){ g_exp = null; }
    }
    g_t = gradeIndex(g_exp, GRADE_W_BASE);
    g_a = gradeIndex(hcapA, waterA);
    g_hcap_a = hcapA; g_water_a = waterA;
    if (g_t != null && g_a != null){ g_net = g_a - g_t; g_tier = gradeTierOf(g_net); }
  }

  /* ===== 2026-10-04 撤除「无盘路场升档」——实测为死代码，勿再恢复（勿信 retro 侧单看命中率）=====
     起因：5042 场复盘里 stage_n==null 的场（n=906）方向命中 64.2%，远高于有盘路 50.0%，
     同层增量 tier1 层 +16.7pp / tier2 层 +15.2pp、8 天 7 天正向 ⇒ 看似强信号。
     但用线上真实 bake pack（1212 场）实测：euRows==0 的场共 373 个（30.8%），
     而它们 **100% 是 tier0 且无 W/D/L 方向结论**（欧赔缺失 → 算不出市场 fav → 引擎根本不给出方向）。
       无盘路|tier0|无方向 370 ／ 有盘路|tier2 72 ／ 有盘路|tier1 59
     ⇒ 线上根本不存在「无盘路 + 已有方向结论 + 被压在 tier2」的场，升档判据触发数 = 0。
     ⚠ 更朴素的解读：retro 侧那批无盘路场高命中，是因为**欧赔缺失的那批数据本身在 retro 里走了别的
       方向通道**，不等于"这类盘更值得下注"；线上把它们直接判为无结论才是诚实的。
     ⚠ 归因也已证伪：模型在无盘路场净 alpha = +0.0pp（模型 64.2% ＝ 市场 fav 64.2%），
       高命中来自市场选择效应（多为小联赛/弱队盘，fav 本就稳），不是模型能力。
     ⇒ 结论：不做任何升档，tier 纪律（浅盘低价值撤回 / 深盘恒下注级）保持原样。 */

  /* ===== 2026-10-04 势均力敌观望闸（5042 场回测定论，勿轻撤）=====
     mk_d（市场临场隐含平局率）≥0.26 时模型方向准确率单调塌陷：
       <0.20→74.2% | .20~.22→64.4% | .22~.24→57.5% | .24~.26→53.4% | .26~.28→46.4% | .28~.30→40.0% | ≥.30→37.1%（每桶 n≥210）
     中段 mk_d∈[0.25,0.32) n=1917：该段最佳单挑上限仅 40.0%，模型 41.1% ⇒ alpha 仅 +1.1pp（无额外信息）。
     故整段降 tier0（观望不下注）：剩余下注池 n=2448 命中 62.1%，
     vs 原全池 n=3928 命中 54.7% ⇒ 下注命中率 +7.4pp（场数 -38%，换来的是真命中率）。
     ⚠ 只改档位，不改 dir/conf/vote：方向结论照常展示，只是不再挂"可下注"的说服力。
     ⚠ 阈值取 0.26 而非 0.25：曲线连续单调无断崖，0.26 起砍能少砍 ~320 场而剩余池质量几乎不变
       （砍 0.25→剩 63.0%/n=2160；砍 0.26→剩 62.1%/n=2448）。 */
  const evenlyMatched = (mk_d != null && mk_d >= DRAW_WATCH_GATE);
  if (evenlyMatched && tier >= 1) tier = 0;

  /* ===== 十三修：市场认同门（tier1 要求市场对本方向概率 ≥0.65）=====
     依据 _gate_validate.cjs 在 live_log 3862 场已结算样本上的分层实测：
       tier1 全部              n=1845  命中 60.4%
       tier1 & p_mkt>=0.60    n=692   命中 74.0%  train 72.4 / test 76.0（差 3.6pp，最稳）
       tier1 & p_mkt>=0.65    n=465   命中 75.9%  train 74.7 / test 77.4（差 2.7pp，最稳）
       tier1 & p_mkt<0.65     n≈1380  命中仅 55.1%
       tier2 全部              n=1279  命中 36.6%（Δ基线 −8.3pp，纯负 EV）
       tier2 & p_mkt>=0.65    n=89    命中 74.2%  但 train 55.3 / test 88.2（差 33pp，过飘不采用）
     ⇒ tier2 想救只能靠 p_mkt≥0.65，但样本太飘、只在 test 段成立，故不引入 tier2 子门。
       对 tier1 统一加「p_mkt≥0.65」这道市场认同门：
       模型命中 60.4% → 75.9%，Δ基线 +31.1pp；下注池由 1845 收到 465（覆盖 12%）。
     机制：p_mkt<0.65 意味着市场并不认同模型所选方向（多半是与市场反向对赌），
       与「市场临场 fav 是唯一可信锚」的既定铁律一致 —— 反向的场直接降为 tier2 参考级。
     ⚠ 只改档位不改 dir/conf/vote：方向结论照常展示，只是不再挂"可下注"。
     ⚠ 取不到市场概率（无欧赔）时不动 tier，沿用原值。 */
  {
    const _ds = String(dir_ || '');
    let _pMkt = null;
    if (_ds.indexOf('主胜') >= 0) _pMkt = mk_h;
    else if (_ds.indexOf('客胜') >= 0) _pMkt = mk_a;
    else if (_ds.indexOf('平局') >= 0 || _ds.indexOf('平') >= 0) _pMkt = mk_d;
    if (_pMkt != null && tier === 1 && _pMkt < MARKET_ALIGN_MIN){
      tier = 2;
      mktAlign = { p_mkt: +_pMkt.toFixed(3), gate: MARKET_ALIGN_MIN };
    }
  }

  return {
    a0, h0, p1, h1, dp, dh,
    grade_t: g_t, grade_a: g_a, grade_net: g_net,
    grade_tier: g_tier.label, grade_tier_key: g_tier.key, grade_hot: g_tier.hot,
    grade_hcap_a: (g_hcap_a!=null?+g_hcap_a.toFixed(2):null),
    grade_water_a: (g_water_a!=null?+g_water_a.toFixed(2):null),
    grade_theory_src: g_theory_src,
    o0h, o0d, o0a, o1h, o1d, o1a,
    mk_h, mk_d, mk_a, payout,
    mv_h, mv_d, mv_a,
    flow, sig, s_flow, s_pan, s_he,
    dir: dir_, conf, n_sig, vote, tier, evenlyMatched,   // tier: 1=下注级(正EV) 2=参考级(负EV,仅方向) 0=无结论; evenlyMatched=市场均势(降观望)
    grade, grade_reason, strongDraw, strongDrawHot, mx: mxFav!=null?+mxFav.toFixed(3):null, pay_agg: payAgg!=null?+payAgg.toFixed(3):null,
    betfa: betfa ? { pct: { W:betfa.W&&betfa.W.pct, D:betfa.D&&betfa.D.pct, L:betfa.L&&betfa.L.pct }, hot: betfa.hot, amount: betfa.amount, rank_home: betfa.rank_home, rank_away: betfa.rank_away, src: betfa.src, confirm: betfaConfirm } : null,
    strength_diff,
    c_valid: agg.c_valid, eu_valid: agg.eu_valid,
    n_asia: agg.n_asia, n_eu: agg.n_eu,
    has_c_asia, has_c_eu, fav,
    /* ★ 2026-10-30 用户要求：365/立博/威廉/英特 4家实时欧赔（初盘→临盘），实时更新参考 */
    coLive: agg.coLive || null,
    exp_hcap, pan_gap, pan_type: typ,
    pan_predict: predict,
    // ★ 2026-10-25：结构下盘（盘口结构正信号·独立样本池·不碰 t1 终局门 0.72）。
    //   标定窗口 pan_gap∈[-0.63,-0.13) 且引擎判下盘/观望：实际盘比欧赔预期浅 0.13~0.63 盘 → 下盘(受让)易兑现。
    //   3份bake去重 832 场：命中 58.1% / ROI +19.2% / 95%CI[12.7,25.7] 显著（独立于破绽反买框架）。
    //   ⚠ 看板读的是已烘焙 an（旧引擎烤的无该字段），ui 侧用 _structDown(a) 现算兜底；此字段供未来重烘焙生效。
    structDown: (pan_gap != null && pan_gap >= -0.63 && pan_gap < -0.13 && (predict === '下盘' || predict === '观望')),
    structDownStat: (pan_gap != null && pan_gap >= -0.63 && pan_gap < -0.13 && (predict === '下盘' || predict === '观望')) ? { hit:58.1, roi:19.2, n:832, ciLo:12.7, ciHi:25.7, frac:0.25 } : null,
    s_pan_kb, kuopan,
    value_score,
    s_ou, ou_dir, ou_text, ou_value, ou_conf, ou_stable, ou_lean, ou_heat,
    asia_dir, asia_cov, mktAlign,
    draw_heat: drawHeatInfo,
    draw_card: dcard,
    ou: aggBs ? { o_line:aggBs.o_line, o_ow:aggBs.o_ow, o_uw:aggBs.o_uw, c_line:aggBs.c_line, c_ow:aggBs.c_ow, c_uw:aggBs.c_uw } : null,
    score, htft, breakGoal, ppi: ppiInfo, valueOU, yg, he, panlu, dirCode, dirText, company_div: divInfo,
    wash,
    // 破绽盘修正方向：聪明钱(sharp)与大众(pop)明显背离时，回测证明「跟随权威机构偏离方向」远优于模型综合方向
    // （跟 svpDir 命中 60~64%、EV +40% 量级；模型方向同批 EV 转负）。仅 SHARP_DIVERGE/SHARP_WATCH 触发。
    smartDir: (divInfo && (divInfo.flag === 'SHARP_DIVERGE' || divInfo.flag === 'SHARP_WATCH') && divInfo.sharpVsPop)
      ? divInfo.sharpVsPop.dir : null,
    plan: stakePlan(yg, divInfo),
    // ★ 2026-10-09 热度信号（8449场真值校准）：让球深度×方向 + 临场移动 + 热度概率门。
    //   替换旧"热度代理(硬写50)"的伪信号——旧 PPI 在无真实投注占比时只剩临场赔率变动噪声，用户骂"完全没用"的根因。
    heatSignal: buildHeatSignal(agg, ppiInfo),
  };
}

/* ===== 价值分重标定(2026-09-22) =====
 * 根因: 全推 tier1 命中仅~50%, 浅盘均势局(测试窗9-19~21 仅45.4%)拖累; 深盘强队局(~64%)稳。
 * 拟合: 9-04~13 真实完赛出信号场(2634)分桶(深/浅 × 价值分), 真实命中率×100; n<25 桶向组均值平滑。
 * 验证: 9-19~21 测试窗(2509场) 原全推49.9% → 规则B(深盘恒留 OR 浅盘标定>=GATE) 55.8%@34%。
 * 规则: tier1 = 深盘(|p1|>=1)恒留 OR 浅盘标定命中>=TIER1_GATE(56)。
 * 显示: value_score 改写为诚实的标定命中率(替代原 conf+盘口加成)。 */
const RECAL_BINS = [0, 40, 50, 60, 70, 80, 101];
const RECAL_DEEP = [45.1, 71.0, 68.4, 69.9, 80.5, 68.5];      // ×100, 各价值分桶真实命中率
const RECAL_SHALLOW = [52.6, 57.6, 54.9, 52.0, 62.6, 55.0];
const TIER1_GATE = 56;
function recalibBin(v){ v = +v || 0; for (let i = 0; i < RECAL_BINS.length - 1; i++){ if (v >= RECAL_BINS[i] && v < RECAL_BINS[i + 1]) return i; } return RECAL_BINS.length - 2; }
function recalibValue(v, deep){ const t = deep ? RECAL_DEEP : RECAL_SHALLOW; return Math.round(t[recalibBin(v)]); }

return { KB, med, parseHcap, num, validAsia, validEu, aggregate, aggregateBs, validOU, classifyOU, analyzePanlu, _prob, expectedHcap, yanggeHcapLevel, waterBand, classifyPan, analyze, drawCard,
         improvedPick, predictScore, predictHTFT, predictBreak, computeHeat, computePPI, fusePanlu3, recalibValue, recalibBin, RECAL_DEEP, RECAL_SHALLOW, TIER1_GATE,
         loadBetfa, getBetfa,
         cleanName, decodePua, decodeName, learnPua, PUA_MAP, LEAGUE_MAP, LEAGUE_PY, leagueName, leagueSortKey, normTeamName, TEAM_CANON, TEAM_ALIAS,
         summarizeInfo, actualDir, pickFromAnalysis, blankModel, updateModel, rate, biasNotes, applyCorrection, mergeCorr,
         applyInfoPrior, infoPrior, parseInfoFeatures, PICK_GATE,
         loadJingcai, getJingcai, getJingcaiRows, loadBeidan, getBeidan, getBeidanRq, _jcNameEq, loadCompanyDiv, getCompanyDiv,
         /* 🔴 2026-10-15 修复：_bdNameEq / _cupOk 之前**没在导出清单里** ⇒ 浏览器(UMD 只把本清单名字挂 window)
            里它们是 undefined。ui.js triFlowHTML 的北单→MATCHES 反配对整段包在 try{}catch(e){} 里，
            ReferenceError 被静默吞掉 ⇒ byNo 恒空 ⇒ 三盘板 82 行北单全部「模型无方向 / 无欧赔对照」，
            「资金与模型同向」卡恒 0（用户"有数据的比赛一场都没有"的真根因）。此处补进导出。 */
         _bdNameEq, _cupOk, decodeName,
         strengthPriorOpts, teamFormOpts, teamPriorOpts, _loadTeamForm, _stripTeam,
         theoreticalAssess, dcMatchProb, gradeIndex, GRADE_W_BASE,
         heatDomainOf, YG_HOT_EXCESS_PT, YG_HOT_WARN_PT, stakePlan,
         buildHeatSignal,
         _leagueHtFlag,
         AH_BT,
         ENGINE_V };
});



















