# -*- coding: utf-8 -*-
"""refresh_all.py — 无人值守后台数据刷新流水线（看板数据每轮自动更新）

链路：
  1) fetch_jingcai.cjs  竞彩官方赔率（sporttery.cn，含胜平负/让球/比分/半全场/进球数）
  2) bake.cjs           gqj2 全量比赛 + 亚盘/欧盘/大小球/交锋（今天+明天）
  3) compact.cjs        裁剪+列式打包（省体积）
  4) gen_index.py       生成自包含 index.html
  5) auto_pick.cjs      自动跑引擎分析，产出当日重点清单 markdown
  6) 同步 index.html 到 _deploy/ （供部署步骤上传）

设计要点（踩过的坑）：
  - 每一步独立 try/except：某步失败不阻断后续，且保留上一轮文件，绝不产出空页面
  - bake 是最耗时的一步（数百场串行/并发拉盘口），给足超时
  - 所有输出进 _refresh_log.txt 便于事后核查
  - 本脚本只负责「把数据更新到位」，部署交给调用方（automation）执行

用法： python refresh_all.py
"""
import os
import sys
import subprocess
import time
import datetime
import shutil
import json

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = r"C:\Users\99618\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not os.path.exists(NODE):
    NODE = "node"
PY = sys.executable
LOG = os.path.join(HERE, "_refresh_log.txt")

# ★ 2026-11-01 每日精选仓位配置（凯利测算：全凯利 23.5% / 1/4 凯利 5.9%；
#   历史 n=99、命中率估计 SE≈4.8%，取 1/4 凯利留缓冲 → 默认每注 5%）。
#   仅在环境变量未设时给默认值；CVM 上可用 `export BANKROLL=xxx STAKE_PCT=0.05` 覆盖。
#   子进程（node _roi_picks.cjs daily）会继承这里设置的 os.environ。
os.environ.setdefault("STAKE_PCT", "0.05")
os.environ.setdefault("BANKROLL", "5000")

# ⚠ 关键：Windows 下所有子进程必须带 CREATE_NO_WINDOW，否则会弹控制台黑框。
# 原因：计划任务用 pythonw.exe 启动本脚本时，本进程本身没有控制台；
#       这时若 spawn 一个控制台程序（node.exe / python.exe），Windows 会为它
#       新建一个可见的控制台窗口 → 每轮刷新弹好几个黑框，干扰用户其他软件。
#       （node 脚本内部不再 spawn 子进程，所以只需在这里统一加标志）
_CNW = 0x08000000 if os.name == "nt" else 0

# 用 pythonw.exe 托管时 sys.stdout 为 None，print() 会抛 RuntimeError("lost sys.stdout")
# → 直接把 stdout/stderr 接到日志文件，保证无窗口后台运行时也不会崩
_stderr_stdout_to_log = False
if sys.stdout is None or sys.stderr is None:
    try:
        _f = open(LOG, "a", encoding="utf-8", buffering=1)
        _stderr_stdout_to_log = True
        if sys.stdout is None:
            sys.stdout = _f
        if sys.stderr is None:
            sys.stderr = _f
    except Exception:
        pass

# 互斥锁：计划任务每 30 分钟触发一次，而 bake 可能跑十来分钟 → 一轮没跑完就起下一轮会写坏文件
LOCK = os.path.join(HERE, ".refresh.lock")
_lock_fp = None


def _pid_alive(pid):
    """跨平台判断进程是否存活（Windows 用 tasklist，posix 用 os.kill 0）。

    ⚠ 2026-10-10 根治 PID 复用：仅用 tasklist 查 PID 是否存在会被「PID 复用」骗过——
    被杀的 refresh_all 的 PID 被系统分给别的进程后，tasklist 仍报该 PID 存活，
    导致 _lock_is_stale 误判锁有效、整条刷新流水线被冻住（表现为反复"延期几十分钟"）。
    新增：① 映像必须是 python 解释器；② 命令行必须含 "refresh_all"，二者任一不满足即判死。
    命令行探测失败时退回"映像为 python"的弱判据，仍优于原版。"""
    if not pid or pid <= 0:
        return False
    try:
        if os.name == "nt":
            import subprocess
            # 1) 确认 PID 存在且映像是 python（CSV 含映像名列，便于校验）
            out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True,
                                 encoding="oem", errors="ignore", timeout=10).stdout
            if str(pid) not in out:
                return False
            if "python" not in out.lower():
                return False  # PID 被复用成非 python 进程 → 死
            # 2) 命令行确证在跑 refresh_all（防 PID 复用成别的 python 脚本）
            try:
                cl = subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     "Get-CimInstance Win32_Process -Filter 'ProcessId=%d' | "
                     "Select-Object -ExpandProperty CommandLine" % pid],
                    capture_output=True, text=True, encoding="oem", errors="ignore", timeout=10).stdout
                if "refresh_all" not in cl:
                    return False
            except Exception:
                pass  # 命令行查不到就退回弱判据（映像已是 python）
            return True
        else:
            os.kill(pid, 0)
            return True
    except Exception:
        return False


def _kill_tree(pid):
    """强杀进程树（含子孙）。用于锁接管时清理僵死的上一个 refresh_all 实例，
    避免「接管后两个实例并发写 bake_pack」造成数据损坏 / 再次卡死。
    旧实例可能挂着 CDP 浏览器子进程，必须用 /T 连子孙一起杀。"""
    if not pid or pid <= 0:
        return
    try:
        subprocess.run([r"C:\Windows\system32\taskkill.exe", "/F", "/T", "/PID", str(pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    except Exception:
        pass


def _lock_is_stale(max_age_min=20):
    """锁文件存在且已陈旧（进程已死，或持有超过 max_age_min 分钟）→ True。
    用于 acquire_lock 的接管判定，也供自愈合等待逻辑复用。读不出锁内容时宁可判为陈旧，
    也不要被死锁冻住整条刷新流水线。"""
    if not os.path.exists(LOCK):
        return False
    try:
        age = (time.time() - os.path.getmtime(LOCK)) / 60.0
        if age >= max_age_min:
            return True
        with open(LOCK, "r", encoding="utf-8") as _lf:
            _pid = int(_lf.read().split()[0])
        if not _pid_alive(_pid):
            return True
    except Exception:
        return True
    return False


def acquire_lock(max_age_min=20):
    """抢不到锁就退出（上一轮还在跑）；锁文件超过 20 分钟、或其中记录的 PID 已死，视为僵死，强制接管。

    ⚠ 2026-10-09 根治：safe-delete 钩子拦截 os.remove/os.replace（fail-closed 走回收站），
       旧代码靠「删锁」接管，僵死锁永远删不掉 → 整条刷新流水线冻结。
       新方案：**彻底不再删除/改名锁文件，只用「覆盖写」接管**——
       只要锁僵死（陈旧或 PID 已死），直接 open(LOCK,"w") 把内容换成自己的 PID 再 flush。
       写操作不受 safe-delete 限制，因此任何环境下接管都不会卡死。"""
    global _lock_fp
    try:
        # 锁存在且仍鲜活（进程活着且未超时）→ 跳过，避免与正在跑的轮次重叠
        if os.path.exists(LOCK) and not _lock_is_stale(max_age_min):
            return False
        # 接管 / 新建：锁僵死（陈旧或 PID 已死 / 已杀）→ 先强杀旧实例进程树（防并发写 bake_pack 损坏），
        # 再覆盖写锁内容（用写而非删除绕开 safe-delete）。
        if os.path.exists(LOCK):
            try:
                with open(LOCK, "r", encoding="utf-8") as _lf:
                    _old = _lf.read().split()
                if _old:
                    _kill_tree(int(_old[0]))
            except Exception:
                pass
        _lock_fp = open(LOCK, "w", encoding="utf-8")
        _lock_fp.write(str(os.getpid()) + " " + time.strftime("%Y-%m-%d %H:%M:%S"))
        _lock_fp.flush()
        return True
    except Exception:
        return False


def release_lock():
    global _lock_fp
    try:
        if _lock_fp is not None:
            try:
                _lock_fp.flush()
            except Exception:
                pass
            try:
                _lock_fp.close()
            except Exception:
                pass
            _lock_fp = None
    except Exception:
        pass
    # 不删除锁文件（safe-delete 会拦截 os.remove）。仅清空内容标记释放：
    # 下一轮 acquire 读到空/旧内容 → _lock_is_stale 读 PID 抛异常 → 判为陈旧 → 正常接管，
    # 不会误判成"正在运行"而整轮跳过。
    try:
        with open(LOCK, "w", encoding="utf-8") as _rf:
            _rf.write("")
    except Exception:
        pass


# ── 自愈合：被锁跳过时，若 _deploy 缺失/损坏，等待或接管以重建，杜绝部署空窗 ──
#    仅做"能否上线"的充分性检查，不要求全部 13 个文件（bake_detail/teamctx 等由其它步产出，缺失不致命）。
_EXPECT_DEPLOY_FILES = ["index.html", "bake_data.js", "version.json"]


def _deploy_intact():
    """_deploy 是否具备可部署的最小完整性：核心文件齐全 + version.json 合法 + bake_data 含数据标记。
    与同步守卫同口径（window.__BAKE），缺任意一项即视为空壳/被截断，不应上线。"""
    dep = os.path.join(HERE, "_deploy")
    if not os.path.isdir(dep):
        return False
    for fn in _EXPECT_DEPLOY_FILES:
        if not os.path.exists(os.path.join(dep, fn)):
            return False
    try:
        with open(os.path.join(dep, "bake_data.js"), "r", encoding="utf-8", errors="replace") as f:
            head = f.read(200000)
        if "window.__BAKE" not in head:
            return False
    except Exception:
        return False
    try:
        with open(os.path.join(dep, "version.json"), encoding="utf-8") as f:
            vj = json.load(f)
        if not vj.get("built"):
            return False
    except Exception:
        return False
    return True


def _self_heal_on_skip():
    """本轮因锁冲突被跳过：若 _deploy 完好则无需动作（调用方会继续部署现有产物，符合"继续部署当前 _deploy"）；
    若 _deploy 缺失/损坏，则等待持锁刷新完成（其同步步骤会重建），超时仍缺则接管跑完整刷新。
    设计原则：只为"可部署性"兜底，不为了追新鲜度而阻塞——线上始终是合法产物，空窗归零。"""
    if _deploy_intact():
        return
    log("[自愈] _deploy 缺失/损坏，等待持锁刷新重建…")
    deadline = time.time() + 1800  # 最多等 30 分钟（覆盖已知最长 ~18min 的刷新）
    while time.time() < deadline:
        if not os.path.exists(LOCK):
            break                      # 持锁刷新已释放，通常会重建好 _deploy
        if _lock_is_stale():
            break                      # 锁变陈旧（进程死/超龄）→ 不再等，直接接管
        time.sleep(15)
    time.sleep(2)
    if _deploy_intact():
        return
    # 仍缺：持锁刷新可能失败，接管并跑完整刷新重建
    log("[自愈] 等待后 _deploy 仍缺失，接管并跑完整刷新重建")
    if acquire_lock():
        try:
            _main()
        finally:
            release_lock()


LOG_MAX = 400 * 1024          # 日志超过 400KB 就保留后半段


def log(msg):
    line = datetime.datetime.now().strftime("%m-%d %H:%M:%S") + " | " + msg
    print(line, flush=True)
    if _stderr_stdout_to_log:
        return                      # stdout 已指向日志文件，再写一遍会每条重复两次
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def trim_log():
    try:
        if os.path.getsize(LOG) > LOG_MAX:
            with open(LOG, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            with open(LOG, "w", encoding="utf-8") as f:
                f.writelines(lines[-400:])
    except Exception:
        pass


def run(args, timeout, name):
    """执行一步；返回 (是否成功, 耗时秒, 末几行输出)

    ★2026-11-25 Linux 强杀修复：
      旧版用 subprocess.run(timeout=...) + Windows taskkill.exe。Linux 上 taskkill 不存在、
      异常被吞；且 Python 在抛 TimeoutExpired 之前已先杀掉直接子进程，node wrapper 自
      spawnSync 的 --max-old-space-size=4096 子进程此时已 reparent 到 PID1 变孤儿，事后
      再扫 ps 父子关系永远抓不到。实测孤儿 RSS 1.2~1.8GB 与 gen_index 并发，把 1.9GB
      小机 HTTP 打爆两次。改 Popen + start_new_session，超时瞬间 killpg 整组杀。
    """
    t0 = time.time()
    try:
        if os.name == "nt":
            kw = {"creationflags": _CNW} if _CNW else {}
        else:
            kw = {"start_new_session": True}
        p = subprocess.Popen(args, cwd=HERE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, **kw)
        try:
            out_b, err_b = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            dt = time.time() - t0
            try:
                if os.name == "nt":
                    subprocess.run([r"C:\Windows\system32\taskkill.exe", "/F", "/T", "/PID", str(p.pid)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
                else:
                    import signal as _sig
                    try:
                        os.killpg(os.getpgid(p.pid), _sig.SIGKILL)
                    except Exception:
                        try:
                            os.kill(p.pid, _sig.SIGKILL)
                        except Exception:
                            pass
                    try:
                        p.communicate(timeout=10)
                    except Exception:
                        pass
            except Exception:
                pass
            log("[%s] TIMEOUT after %.0fs (已强杀进程树)" % (name, dt))
            return False, dt, ["timeout"]
        out = (out_b or b"").decode("utf-8", "replace") + (err_b or b"").decode("utf-8", "replace")
        dt = time.time() - t0
        tail = [l.strip() for l in out.splitlines() if l.strip()][-4:]
        ok = (p.returncode == 0)
        log("[%s] %s (%.0fs)%s" % (name, "OK" if ok else "FAIL rc=%s" % p.returncode, dt,
                                   " :: " + " / ".join(tail) if tail else ""))
        return ok, dt, tail
    except Exception as e:
        log("[%s] ERROR %s" % (name, e))
        return False, 0, [str(e)]


def maybe_refit_team_ratings():
    """team_ratings 自愈：滞后 >1 天则自动补赛果并重拟合，消除「去滞后只做一次又回归」的坑。
    仅在滞后时跑，不滞后跳过；联网/拟合失败均不阻断主流水线（try/except 包住）。"""
    try:
        tp = os.path.join(HERE, "team_ratings.json")
        if not os.path.exists(tp):
            return
        with open(tp, encoding="utf-8") as f:
            tr = json.load(f)
        gen = tr.get("generated")
        if not gen:
            return
        gdt = datetime.datetime.fromisoformat(gen.replace("Z", "+00:00"))
        age_days = (datetime.datetime.now(datetime.timezone.utc) - gdt).days
        if age_days < 1:
            return
        log(f"[team_ratings] 滞后 {age_days} 天，自动补赛果+重拟合（固化自愈）")
        run([NODE, "extend_history.cjs"], 120, "补赛果")
        run([NODE, "fit_team_ratings.cjs"], 300, "重拟合ratings")
    except Exception as e:
        log(f"[team_ratings] 自愈失败（不阻断）: {e}")


BAKE_PACK = os.path.join(HERE, "bake_pack.json")
BAKE_GOOD = os.path.join(HERE, "bake_pack.good.json")


def _pack_count(path):
    """返回 bake_pack 里的比赛包数量；文件缺失/损坏返回 -1"""
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return len(d.get("packs", {}) or {})
    except Exception:
        return -1


def guard_bake_pack():
    """底座空数据保护（2026-09-24 新增，治「线上场次/赔率不更新、点更新也拿不到」）。

    事故复盘：bake_pack.json 被并发写成空(118B) → gen_index 生成 0 场 index.html，
    而 index.html 的部署体积阈值仅 0.05MB，拦不住这种"逻辑空但体积不小"的产物，
    于是空页面照样被部署上线，用户看到的就是"比赛没更新、赔率没更新"。
    策略：新底座 < 500 场 或 较上一轮良好快照腰斩 → 判定异常，回滚备份，不让空数据进 gen_index。
    """
    n_new = _pack_count(BAKE_PACK)
    n_good = _pack_count(BAKE_GOOD)
    if n_new >= 500 and (n_good < 0 or n_new >= n_good * 0.5):
        try:
            shutil.copyfile(BAKE_PACK, BAKE_GOOD)
            log("[底座保护] 新底座 %d 场，正常，已更新备份" % n_new)
        except Exception as e:
            log("[底座保护] 备份失败（不阻断）: %s" % e)
        return True
    if n_good > 0:
        try:
            shutil.copyfile(BAKE_GOOD, BAKE_PACK)
            log("[底座保护] ⚠ 新底座仅 %d 场（异常），已回滚到上一轮良好快照 %d 场" % (n_new, n_good))
            return False
        except Exception as e:
            log("[底座保护] 回滚失败: %s" % e)
            return False
    log("[底座保护] ⚠ 新底座仅 %d 场且无良好备份，无法回滚" % n_new)
    return False


# ── gqj2 567 自愈门（2026-11-20）────────────────────────────────────────────
# 背景：11-18 16:51 全量烘焙(2397场/354s)触发 gqj2 对 CVM IP 的 567 封禁；此后每 15 分钟
#   cron 继续锤（烘焙全量列表 + 结算回拉 3 天），封禁两天未解 → 线上快照冻在 11-18 16:51。
# 机制：进入 gqj2 相关步骤前先查门——冷却期内直接跳过、零请求；到期发【单个】探针：
#   仍 567/网络不通 → 冷却 ×2（上限 6h）继续等；探针 200 → 清门放行，链路自愈。
# 门文件 gqj2_gate.json 只记 {until, backoff, last, ts}，崩溃/并发安全（flock 已互斥整轮）。
GQJ2_GATE = os.path.join(HERE, "gqj2_gate.json")
_GQJ2_OK = None   # 本轮内缓存：True=门开（探针通过）；False=冷却/探针失败


def gqj2_gate():
    """返回 True 才允许打 gqj2。567 封禁自愈门：冷却期零请求，到期单探针。"""
    global _GQJ2_OK
    if _GQJ2_OK is not None:
        return _GQJ2_OK
    import urllib.request, urllib.error
    now = time.time()
    try:
        with open(GQJ2_GATE, "r", encoding="utf-8") as f:
            g = json.load(f)
    except Exception:
        g = {}
    if now < float(g.get("until", 0)):
        log("[gqj2门] 冷却中（剩约 %d 分钟，上次探针 http %s）→ 跳过 gqj2 步骤"
            % (int((float(g.get("until", 0)) - now) // 60) + 1, g.get("last")))
        _GQJ2_OK = False
        return False
    code = 0
    try:
        # ★ 探针与烘焙同款列表请求（api.gqj2.tv/getfootball_list?day=今天&state=0），
        #   不要用 /api 前缀——那是 m.gqj2.tv 移动端路径，api 主站对它不保证 200。
        _d = datetime.datetime.now().strftime("%Y%m%d")
        req = urllib.request.Request(
            "https://api.gqj2.tv/getfootball_list?day=" + _d + "&state=0",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                     "Referer": "https://m.gqj2.tv/"})
        with urllib.request.urlopen(req, timeout=15) as r:
            code = r.getcode()
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception:
        code = 0
    if 200 <= code < 300:
        if g:
            log("[gqj2门] 探针 200，封禁解除 → 清门放行")
        try:
            os.remove(GQJ2_GATE)
        except Exception:
            pass
        _GQJ2_OK = True
        return True
    # ★2026-11-20 20:00 上限 6h→1h：实测 567 是 WAF 频率黑名单（响应页写「休息5-10s」），
    #   单 IP 每 15 分钟锤一次才触发；每小时 1 个探针远低于阈值、不会续封，
    #   却能把解封检测从最长 6h 压到 ≤1h，让烘焙/入围尽快恢复。
    backoff = min(int(g.get("backoff", 900)) * 2, 3600)
    g = {"until": now + backoff, "backoff": backoff, "last": code, "ts": now}
    try:
        with open(GQJ2_GATE, "w", encoding="utf-8") as f:
            json.dump(g, f, ensure_ascii=False)
    except Exception:
        pass
    log("[gqj2门] 探针 http %s 仍被封 → 冷却 %d 分钟（指数退避，上限 1h）"
        % (code, backoff // 60))
    _GQJ2_OK = False
    return False


def main():
    if not acquire_lock():
        log("[互斥] 上一轮刷新尚未结束（.refresh.lock 存在），本轮跳过")
        _self_heal_on_skip()
        return 0
    try:
        return _main()
    finally:
        release_lock()


def _main():
    t_all = time.time()
    log("=" * 60)
    log("开始自动刷新")

    # ── 0. team_ratings 自愈（滞后>1天则追，固化进流水线，避免手动补一次又回归）
    maybe_refit_team_ratings()

    # ── 1. 竞彩官方赔率（快，失败也保留旧文件）
    run([NODE, "fetch_jingcai.cjs"], 90, "竞彩")
    # 独立篮球公开报价采集；历史接口访问受限，默认仅当前列表与观察poll。
    # 单源失败显式保留旧数据，不影响足球刷新；basket_collect 内含独立跨进程锁。
    run([PY, "basket_collect.py", "--history-matches", "0"], 125, "篮球三盘观察")
    # ★ 2026-11-18 篮球赛果自动同步：ESPN NBA scoreboard 拉 FINAL 赛果 → 追加平铺赛果文件。
    #   只追加不覆盖、只认 FINAL+按开赛时刻对齐队名，避免串场/误结未开赛场次。
    #   必须在账本之前跑，账本才能当轮结算。失败不致命（run 已隔离异常）。
    run([NODE, "_sync_basket_result.cjs", "--days", "5"], 60, "篮球赛果同步")
    # ★ 2026-11-17 篮球方向观察账本：紧跟篮球采集之后重生成，把新出现的赛前场按玩法冻结方向。
    #   首登冻结（pick/赔率/Δpp/规则版本不回写）+ 结算只认已核验外部赛果；无赛果源时只冻结不结算。
    #   CVM 上为只读模式需设 DIR_LEDGER_FORCE_WRITE=1（本账本独立，不复用足球写守卫），故直接跑。
    run([NODE, "_basket_dir_ledger.cjs"], 60, "篮球方向账本")
    # ★ 2026-11-19 篮球预设盘地基：ESPN 球队赛程算赛前滚动场均 → 开合理让分/大小分线
    #   （洋哥L85可复刻部分）。只读ESPN+写 basket_preset.json，失败不致命。仅观察档，不进引擎。
    run([NODE, "_basket_preset.cjs"], 120, "篮球预设盘地基")
    # ★ 2026-11-19 篮球三盘资金过热核对（观察档）：只收竞彩SP+北单池SP+已结算赛果三者齐全的场次，
    #   按洋哥L174动态缺口口径算判定/偏差（参照盘用竞彩替代被封的365，非原法），仅同让分线可比。
    #   写 basket_overheat.json，失败不致命。n<40观察档，不进引擎/方向票/仓位。
    run([NODE, "_basket_overheat.cjs"], 60, "篮球三盘过热核对")

    # ── 1.1 竞彩初盘走势快照累积（collect_jc_history.cjs）：把刚抓到的 jingcai 按场追加到
    #      jc_history.json 的 history[]，逐步建出「竞彩初→临」时间线，补一盘流速最弱一环。
    #      纯本地文件读写、失败不致命（run 已隔离异常）。
    run([NODE, "collect_jc_history.cjs"], 30, "竞彩走势")

    # ── 1.2 亚盘/欧赔多时点盘路轨迹累积（collect_odds_timeline.cjs）：把 bake 每场当前
    #      亚盘(a0/h0/p1/h1) 与多公司欧赔(coLive) 追加到 odds_timeline.json，逐步建出
    #      「14:00→赛前3h→赛前1h→封盘」盘中盘路时间线。解决此前只有初/临两点的缺陷，
    #      为「按不同时刻变化重判让球方向」提供真实时序数据。纯本地、失败不致命。
    run([NODE, "collect_odds_timeline.cjs"], 30, "盘路时间线")

    # ── 1.5 北单（北京单场）赛程：抓 okooo bjdc 页（GBK→utf8，服务端可直连，无需手动种子）
    #      → beidan.json，gen_index 注入后「只看北单」过滤与北单✓标记即生效（2026-09-21 真正接入）
    run([NODE, "fetch_beidan.cjs"], 90, "北单")

    # ── 1.6 球探(titan007)全量比赛：服务端直连静态文件（非浏览器），约 1 秒
    #      2026-09-23 实测推翻旧结论「球探只能靠本机无头浏览器」——其比赛列表/盘口是
    #      livestatic.titan007.com/vbsxml/*.js|xml 静态文件，可直接 HTTP 取；
    #      当日 307 场 / 105 联赛，相对 gqj2 净增约 29 场（次级别/小国/U系列）。
    #      → titan007.json + titan007.js，ui.js mergeTitan007 补进列表，把比赛补全。
    run([NODE, "fetch_titan007.cjs"], 60, "球探")

    # ── 1.7 澳客必发真实投注占比（fetch_okooo → okooo_data.json → match_okooo → ppi_auto.json）
    #      ★ 2026-10-11：此前该链路是手动的，导致 ppi_auto 长期不刷新（陈旧旧 schema）→ 必发覆盖≈0.5%。
    #        接进主链后每轮累计刷新；match_okooo 合并写（不覆盖历史完场行）且 refresh_all 互斥锁已防并发打残账本。
    #        同时 fetch_okooo 累积 betfa_series.json（初盘/即时双截面）→ 供 流速差 信号。
    #        两者失败均不阻断主链（run 内部吞异常）。
    run([NODE, "fetch_okooo.cjs"], 150, "澳客候选")
    run([NODE, "match_okooo.cjs"], 180, "必发匹配")

    # ── 2. gqj2 全量烘焙（慢，给足 15 分钟）
    #  ★ 2026-11-20 加 567 自愈门：封禁冷却期直接跳过、绝不锤源站（沿用上一轮 bake_pack.json）
    if gqj2_gate():
        ok_bake, _, _ = run([NODE, "bake.cjs"], 900, "烘焙")
    else:
        ok_bake = False
        log("[烘焙] 跳过（gqj2 567 封禁冷却中，沿用上一轮 bake_pack.json）")

    # ── 3. 压缩打包
    if ok_bake:
        run([NODE, "compact.cjs"], 300, "压缩")
    else:
        log("[压缩] 跳过（烘焙失败，沿用上一轮 bake_pack.json）")

    # ── 3.2 底座空数据保护：必须在 gen_index 之前拦住空 bake_pack，否则 0 场页面会被部署上线
    guard_bake_pack()

    # ── 3.3 离线快照补引擎结论（★ 2026-10-14 提前到烘焙后立刻补）
    #     原在步骤3.8（排在回放库/每日复盘之后）。那两步一旦挂死（回放库 CDP 探针遇 gqj2 DNS 抖动、
    #     每日复盘 gen_review 每轮都 TIMEOUT 180s 被强杀），an 就永远填不回 → 整板变空/停滞、还要人工救火。
    #     提到这里：bake→compact→guard 一完就补，把「an 清零窗口」从「整轮剩余时间」压到「几秒」，
    #     即使后面任何步骤卡死，an 早已回填，下一轮 gen_index 不受影响、板子不再停滞。
    #     bake 失败则沿用上一轮 bake_pack，本步幂等只补不覆盖，无害。
    run([NODE, "_recalc_bake_an.cjs"], 180, "补离线结论(提前)")

    # ── 3.4 智云(捷报) 逐场交锋/近况真值：用【本轮 CVM 自己的新鲜 bake_pack】补抓缺口。
    #   ★★ 2026-11-15 根治（用户："交锋都有的资料，为什么就是拿不到"）：
    #   此前只在本地 deploy_all.sh 里用「本地陈旧 bake_pack」的 tid 列表跑抓取，且产物从没推到 CVM，
    #   CVM 上的 zhiyun_battle.json 停在 11-14；结果当前窗口 3199 场里 1225 个 tid 从未被抓过，
    #   __DG_BATTLE__ 里这些场 x=[] → 解说帝哥第五步①③恒缺、模拟盘不成立。
    #   CVM 可直连 live.zhiyunsports.com(200/0.3s)，故挂进每 15 分钟主链：
    #   抓取器按当轮 bake.matches.r 的 tid 增量补齐（缓存已有不重抓），gen_index 每轮自动内联。
    #   注意：必须排在 compact/guard 之后（bake_pack.json 已稳定）、gen_index 之前。
    run([NODE, "fetch_zhiyun_battle.cjs"], 420, "智云逐场交锋真值")

    # ── 3.45 三盘「开盘→临盘」整条序列（2026-11-15 v3，用户口径）
    #   ★ 三盘的分歧是「谁先动、动多少、谁跟谁没跟」，不是某一刻两项赔率相减。
    #   ★ CVM 有 pool_cloud/snap/*.jsonl 逐帧真值；本地无该目录时脚本自检跳过，
    #     绝不写空产物覆盖 CVM 权威版（deploy_all.sh [0] 会拉回权威 tri_trail.json）。
    #   ★ 必须在 gen_index 之前：方向序列护栏与页面内联都读 tri_trail.json。
    #   ★ 北单 rqspf.rq!=0 是让球胜平负，生成器已隔离，禁止与 365 独赢盘相减。
    run([NODE, "_build_tri_trail.cjs"], 180, "三盘开盘→临盘序列")

    # ── 3.5 跨公司赔率分歧（读 bake_data.json 全量多公司盘口，绕开澳客 405；离群过滤+当今分级加权）
    if ok_bake:
        run([NODE, "company_div.cjs"], 180, "公司分歧")
    else:
        log("[公司分歧] 跳过（烘焙失败）")

    # ── 3.7 每日复盘（对所有已完场跑引擎，记录模型赛前预测/热度判定 vs 实际赛果，按比赛日归集）
    #      必须先于步骤4 gen_index（gen_index 才会把 review_data.js 注入页面）；失败不阻断主流水线。
    #   🔴 2026-10-06 立：gen_review 的数据源是 _replay_finish.json（15 天回放库，千场级）；
    #      该文件缺失时它会**静默退回 bake_data.json（仅 4 天窗口 / 完场约 150 场）**——
    #      这就是「半个月调不动命中率」的结构性根因（样本全落在噪声里）。
    #      而 _replay_build.cjs 此前**从未接进主链**，10-01 手工建过一次后文件丢失、无人发现。
    #      此处补上：先建库再复盘；建库失败不覆盖旧库（脚本内部已保护），主链继续。
    run([NODE, "_replay_build.cjs"], 600, "回放库")
    # ── 2026-10-14：gen_review 改为增量复盘（仅重算最近 7 天活跃天，历史天复用 review_data.js 缓存），
    #    正常每轮几秒完成；仅「引擎版本变化/首次/无旧数据」才全量（9007 场需数百秒）。
    #    超时从 180s 提到 900s 仅作「全量兜底」——增量模式远不会触顶，且已根治"每轮被强杀→永不更新"。
    run([NODE, "gen_review.cjs"], 900, "每日复盘")

    # ── 3.8 离线快照补引擎结论 —— ★ 已提前到步骤3.3（bake→compact→guard 一完就补），此处不再跑。
    #      历史坑（保留备忘）：an 字段**不要**再瘦身（_shrink_an.cjs 已废弃），主看板行内读 breakGoal/
    #      draw_card/htft/panlu/ppi/yg/vote/plan/draw_heat 等块，裁掉会整块空白；改用 _recalc_bake_an.cjs
    #      （Node 直跑 engine.js，不碰浏览器，幂等只补不覆盖，引擎版本戳变自动重算）。

    # ── 3.9 真值对撞：按日归档快照 → 当日战绩 + 累计战绩
    #      单日完场只有几十场（今早 94 完场 / 73 有结论，方向分母才 16），这个量级的命中率纯噪声。
    #      唯一能把分母攒厚的办法就是「每天留档、跑累计」，所以 _xsnap 必须进主链（只写一次，
    #      当日归档文件已存在就跳过，免得每轮白写 100KB）；_xacc 会把多日快照按 tid 去重取最新一份。
    #      ⚠ 判定逻辑统一收在 _eval/_xjudge.cjs：当日(_xfin)与累计(_xacc)必须同源，
    #      各写一份的话迟早漂移，而漂移的表现永远是静默假数（分母正常、命中悄悄错）。
    #      这三条都是只读评估，失败一律不阻断主链（run 内部已吞异常，返回值不用）。
    run([NODE, "_eval/_xsnap.cjs"], 90, "归档当日快照")
    run([NODE, "_eval/_xfin.cjs"], 90, "当日真值对撞")
    run([NODE, "_eval/_xacc.cjs"], 150, "累计真值对撞")

    # ── 3.8 离线快照补引擎结论 —— 已提前到步骤3.3（bake 后立刻补），此处不再重复跑，避免 an 被后续卡死步骤拖空。

    # ── 3.6 三段融合（初盘/中盘/临盘）── 已由 bake.cjs 直接基于赔率历史接口(oddshistorypc)
    #     在步骤2重算并写入 fused.json（early/mid/late 三段，权重 1/3·1/3·1/3），gen_index 直接合并。
    #     ⚠ 旧管线 capture_slice.cjs + fuse_slices.cjs（多时点切片）已于 2026-09-21 废弃：
    #       它靠"逐场相对时刻调度"抓盘，从未正常触发，且其输出会在 bake 之后覆盖掉正确的三段，
    #       导致页面三段永远停在旧快照。故此处不再调用，避免覆盖。

    # ── 3.7 破蛋「精选/优选」链（#306/#308/#309，2026-10-12 接入主链）──
    #     gen_ht_pick  : 深盘+近期半场历史分级（S/A/B），已排除非主流联赛(#308) → ht_pick.json
    #     gen_ht_select: 双源融合(引擎破蛋档 ∪ ht_pick)，按开赛时间升序 → ht_select.json，并把当日入选
    #                    场次归档进跨日复盘账本 ht_settle.json（幂等，#309）
    #     settle_break_picks: 从新鲜真值库(_7m_db.json 含半/全场比分)回填账本结果（跨日持久复盘）
    #     ⚠ 顺序不可颠倒：select 依赖 pick；必须在 gen_index 之前跑，页面才会注入最新 ht_pick/ht_select/ht_settle。
    #       之前这三步不在主链 → ht_pick/ht_select 长期过期（面板 join 对不上），本步修复该根因。
    run([NODE, "gen_ht_pick.cjs"], 150, "破蛋深盘分级")
    run([NODE, "gen_ht_select.cjs"], 150, "破蛋精选优选")
    run([NODE, "settle_break_picks.cjs"], 90, "破蛋账本结算")

    # ── 3.95 球探完场页(Over)半场真值：抓取最近 N 天(含今天)完场页 → 解析 → 重建 HTFT_GROUND
    #      ★ 半场破蛋面板「半场比分 / 真实破蛋判定」的唯一真值源（titan007/okooo 均无半场比分）。
    #        完场页按 sId(===t7id) 1:1 配对，无需队名映射，零误配风险。球探滞后约 1 天，
    #        今日完场页若当日产出则顺带抓到，否则次日刷新自动补齐。失败不阻断主链。
    #        注意：本步会重写 htft_ground.js，必须在 gen_index 之前跑（gen_index 才把它内联进 index.html）。
    run([NODE, "refresh_htft_ground.cjs", "7"], 120, "球探半场真值")

    # ── 3.96 雷速体育(leisu.com)权威队名/联赛覆盖：抓取赛程 → 按 tid 配对新鲜 bake → leisu_map.json。
    #      gen_index 会内联 leisu_map 供 ui.js 的 cleanTeam/cleanLeague 优先取用（leisu 队名最准确）。
    #      ★ 两者失败均保留旧档、非零退出不阻断主链（fetch_leisu 网络失败/被限流 → 不写空覆盖）。
    #        配对只认相同开赛日 + 主客双向命中 + 联赛归一，护栏同北单四护栏，零误配风险。
    run([NODE, "fetch_leisu.cjs"], 60, "雷速赛程抓取")
    run([NODE, "match_leisu.cjs"], 60, "雷速配对bake")

    # 历史交锋真值表：由 _7m_db.json 重建 h2h_map.json（gen_index 注入 window.H2H_MAP）。
    # 失败保留旧档、不阻断主链（_7m_db 静态，旧档即可用）。
    run([NODE, "gen_h2h_map.cjs"], 120, "历史交锋表")

    # ★ 2026-11-01 可下投账本（钱板的命中率/ROI 唯一真数据源）：
    #   必须在 gen_index 之前跑 —— 否则 gen_index 注入的是上一轮的 roi_ledger.json，
    #   钱板上的"命中 56.8% / ROI +9.7%"会永远停在旧值（此前正是 709 注卡在 pending 的根因）。
    #   内部：capture(今日窗口) → 用 gqj2 完场逐场对账 settle → 重算 roi_ledger.json。
    run([NODE, "_roi_picks.cjs", "run"], 300, "可下投账本")

    # ★ 2026-11-03 推荐复盘板（用户：「我怎么知道你哪些推荐对，哪些错」）：
    #   把 settle 回填好赛果的 roi_picks_*.json 聚合成逐条对错表。必须在账本结算之后跑，
    #   否则 result/hs/as/pl 还是空的。产出 review_summary.json（内联）+ review_board.json（外置）。
    run([NODE, "_gen_review_board.cjs"], 90, "推荐复盘板")

    # ★ 2026-11-02 复盘学习闭环：结算后从真实战绩挖「命中验证 / 未命中教训」→ 自动更新 lessons.json
    #   改进规则（如强队大热 flow=W 剔除），选场逻辑每轮读它剔除已学坏的段。必须在 gen_index 之前跑，
    #   下一轮 _roi_picks 的 buildTruth/selectEntry 才能立即应用新规则。样本不足时只观察不硬剔（防过拟合）。
    run([NODE, "review_learn.cjs"], 120, "复盘学习")

    # ★ 2026-11-02 下注模块（总聚合均注总账）：把各板块经验证正边的选场口径聚合，对权威烘焙
    #   真实完场做均注回测，算组合总账（总投入/总盈亏/ROI/命中率），并产出今日可下注候选。
    #   必须在 gen_index 之前跑，页面才会注入 window.BET_MODULE 供「🏦 下注模块」板块渲染。
    run([NODE, "bet_module.cjs"], 120, "下注模块总账")

    # ★ 2026-11-01 每日精选清单（平手盘·小联赛·买受让方，含建议仓位）：_roi_picks.cjs daily 生成
    #   daily_picks.json，供钱板「今日精选」板块与每日自动推送读取。必须在 gen_index 之前跑。
    run([NODE, "_roi_picks.cjs", "daily"], 60, "每日精选")
    # ★ 2026-11-01 人类可读推送版：从 daily_picks.json 生成 daily_picks_summary.md/.txt，
    #   并从 bake 补全队名/联赛名（避免 daily_picks 里 PUA 解码失败的空名）。用户"每天发我"的落地产物。
    run([NODE, "gen_daily_push.cjs"], 30, "推送清单")

    # ★ 2026-11-01 历史板补结算（fundplate/overheat）：两板的回填原先只依赖 bake 的 state===-1，
    #   比赛一滚出 bake（约 1~2 天）就永远「待结算」——实测 10-23/10-26/10-28 的已完场比赛仍挂 pending。
    #   本步用 gqj2 官方完场按 tournament_id 补 result，并用真实盘口回写（旧条目错用了模型期望盘口）。
    #   必须放在 gen_index 之前，页面才吃得到补好的结果。
    # ★ 2026-11-21 雷速当天比分直配：settle_leisu_direct.cjs 用账本自带队名(E.decodeName 解 PUA)
    #   +简繁归一配对雷速当天完场，产出 leisu_direct_map.json 供 _settle_hist 按 tid 精确补结算。
    #   不依赖 bake_pack（CVM 被 gqj2 567 冻在 11-15，match_leisu 的 leisu_map 恒为 0）。
    #   必须排在 _settle_hist 之前。
    run([NODE, "settle_leisu_direct.cjs"], 60, "雷速直配对账本")
    run([NODE, "_settle_hist.cjs"], 180, "历史补结算")

    # ── 3.8 解说帝哥数据补齐（2026-11-15，D 盘真值回流）
    #   ★ 只在**存在 D 盘采集目录**的 Windows 本地跑（CVM Linux 无 D 盘，直接用推上去的产物）。
    #   ★ 必须在 gen_index 之前：产物由 gen_index 内联进页面。
    #   ★ _build_dg_history.cjs 修过北单 bdSpf 方向(0/1/3=负/平/胜)，不可用旧版账本。
    if os.path.isdir("D:/北单竞彩数据/快照流水"):
        run([NODE, "_build_dg_history.cjs"], 120, "解说帝哥·官方逐帧回流")
        run([NODE, "_build_dg_extra.cjs"], 120, "解说帝哥·交锋/外围补齐")

    # ── 3.8b 篮球精选/优选/强推分档（2026-11-24，Windows-only）
    #   ★ 分档引擎读 D:/北单竞彩数据/篮球/快照流水 真实临盘帧，只在本地 Windows 跑；
    #     CVM Linux 无该目录 → 跳过，直接用本地推上去的 basket_tiers.json，避免产出空档覆盖好数据。
    #   必须排在 _basket_overheat.cjs / 赛果同步之后：读它们的 basket_overheat.json + basket_result.json。
    #   写 basket_tiers.json 观察分档；n<40 不进引擎/账本/投注建议。失败不致命。
    if os.path.isdir("D:/北单竞彩数据/篮球/快照流水"):
        run([NODE, "_basket_tier_engine.cjs"], 60, "篮球精选优选强推分档")

    # ── 4. 生成自包含 index.html
    ok_gen, _, _ = run([PY, "gen_index.py"], 420, "生成页面")

    # ── 4.5 方向推荐·赛前样本外账本（2026-11-15）
    #    必须在 gen_index 之后：读它产出的 fundplate_history.json（含最新赛前候选 + 已结算 plStrong/plUnder）。
    #    独立冻结账本，首登锁 pick/意见原文/盘口水位/票差/规则版本，结算只回填一次、已结算不覆盖。
    #    ★ 与 fundplate_history 的历史回测物理隔离，绝不把「新算法方向配旧赛果」当业绩。
    #    ★ Linux(CVM) 默认只读，本地为唯一写入方，避免两端双写分叉。
    run([PY, "_dir_ledger.py"], 60, "方向样本外账本")

    # ── 4.6 挑战版·逐场结算复盘账本（2026-11-16，A/B 对照用）
    #    与 dir_ledger.json 物理隔离的独立前向账本：只收「仅让球行/无独赢」+严格赛前
    #    +让球方视角盘级差≥2级(洋哥大热)；首登冻结判定/反买方向，结算用 gqj2 完场
    #    +365 真实亚盘盘口水位。流速异常(1级)只观察不登记 → 样本偏少但口径干净。
    #    ★ 生成后前端 fetch('rq_ledger.json') 只读，公网板为最近部署快照。
    run([NODE, "_rq_ledger.cjs"], 60, "挑战版结算账本")

    # ── 5. 同步到部署目录（仅在页面确实生成成功时覆盖，避免把线上换成坏文件）
    # 注：gen_index.py 已将离线快照拆分为 index.html + bake_data.js，两者必须同时部署
    # team_form.js 真实体量约 0.5MB（6906 队·精简对象）；阈值设 0.2MB 既能拦住空/截断文件，
    # 又不会误杀正常的小体积文件（旧阈值 0.6MB 会把 0.54MB 的合法文件判成"疑似未注入"而跳过部署，
    # 导致 history.json 更新后线上 team_form.js 一直不刷新）。
    # ★ 2026-10-02：这三个「按需加载」包（点开档位面板/破蛋面板才拉）以前**不在这份白名单**里，
    #   而本主链每 15 分钟跑一次，等于每轮都把 _deploy 从「11 文件」拉回「6 文件」——
    #   上一轮 _sync_deploy.py 辛苦放进 _deploy 的 m7_pack/retro_pack/htft_validate 会被抹掉，
    #   线上表现就是档位面板历史段永远空、破蛋面板 ④ 段永远"载入中"。必须一起带上。
    # ★ 2026-10-02（19:47 修正）：bake_data.js 自本日起改为 gzip+base64 压缩形态
    #   （明文 ~10MB → 1.7MB，运行时 DecompressionStream 解压），旧体积门限 2.0MB 会把它
    #   误判成"疑似未注入数据"而整轮跳过同步，导致线上看板缺失核心数据 —— 即部署空窗根因。
    #   改为「标记检测」：bake_data.js 必须含 window.__BAKE 标记才放行（兼容 _GZ_ 压缩形态与
    #   可能的明文 __BAKE__ 形态），其余文件维持体积门限。marker 为 None 走体积门限。
    files_to_deploy = [("basketball.html", "basketball.html", 0.0001, None),
                       ("basket_heat.js", "basket_heat.js", 0.0001, None),
                       ("basket_heat.json", "basket_heat.json", 0.0001, None),
                       # ★ 2026-11-19：篮球三盘资金过热账本必须同步，否则线上 fetch 404 → 板块永远空
                       ("basket_overheat.json", "basket_overheat.json", 0.0001, None),
                       ("index.html", "index.html", 0.05, None), ("bake_data.js", "bake_data.js", 0.0001, "window.__BAKE"),
                       ("team_ratings.js", "team_ratings.js", 0.3, None), ("team_form.js", "team_form.js", 0.2, None),
                       ("review_data.js", "review_data.js", 0.0001, None), ("titan007.js", "titan007.js", 0.0001, None),
                       ("retro_pack.js", "retro_pack.js", 0.3, None), ("m7_pack.js", "m7_pack.js", 0.3, None),
                       ("htft_validate.js", "htft_validate.js", 0.3, None),
                       # company_div.js（2026-10-02 拆成外链）：漏了线上 404、分歧索引全空（当前 1.3MB）
                       ("company_div.js", "company_div.js", 0.3, None)]
    deploy_ok = True
    if ok_gen and os.path.exists(os.path.join(HERE, "index.html")):
        # ── 内容守卫（2026-09-24）：体积阈值拦不住"0 场但 493KB"的空页面，必须验内容。
        #    不通过就整轮跳过覆盖，线上继续用已验证的旧产物 —— 宁可慢，不可空。
        try:
            from _deploy_guard import check_payload
            guard_ok, guard_reason = check_payload(HERE, log=log)
        except Exception as e:
            guard_ok, guard_reason = (False, "守卫异常 %s" % e)
        if not guard_ok:
            log("[部署守卫] ⚠ 拒绝部署：%s —— 保留线上现有产物不覆盖" % guard_reason)
            files_to_deploy = []      # 置空即可，下面循环自然不覆盖任何文件，无需改动缩进
            deploy_ok = False

        # ── 兜底（2026-10-02）：_deploy 目录曾被外部清理/误删，导致内置 shutil.copyfile 全部
        #    报 No such file or directory。这里在复制前确保目录存在，根除此类空窗。
        os.makedirs(os.path.join(HERE, "_deploy"), exist_ok=True)

        for src_name, dst_name, min_mb, marker in files_to_deploy:
            src = os.path.join(HERE, src_name)
            dep = os.path.join(HERE, "_deploy", dst_name)
            if not os.path.exists(src):
                log("[同步] 跳过：%s 不存在" % src_name)
                deploy_ok = False
                continue
            try:
                size = os.path.getsize(src)
                # 体积门控：未指定 marker 时，按 min_mb 拦截空/截断文件
                if not marker and size < min_mb * 1024 * 1024:
                    log("[同步] 跳过：%s 仅 %.1f MB，疑似未注入数据" % (src_name, size / 1048576.0))
                    deploy_ok = False
                    continue
                # 内容门控：指定 marker 时，必须在文件内容中检出该标记
                # （如 bake_data.js 的 gzip 压缩快照 window.__BAKE_GZ__）。
                # 兼容压缩形态（明文 10MB → 1.7MB），避免体积门限误杀有效数据。
                if marker:
                    try:
                        _content = open(src, "r", encoding="utf-8", errors="replace").read()
                    except Exception as _e:
                        log("[同步] 跳过：%s 读取失败 %s" % (src_name, _e))
                        deploy_ok = False
                        continue
                    if marker not in _content:
                        log("[同步] 跳过：%s 不含 %s 标记，疑似未注入数据" % (src_name, marker))
                        deploy_ok = False
                        continue
                shutil.copyfile(src, dep)
                log("[同步] %s -> _deploy/ (%.1f MB)" % (src_name, size / 1048576.0))
            except Exception as e:
                log("[同步] %s 失败 %s" % (src_name, e))
                deploy_ok = False
    else:
        log("[同步] 跳过：未生成新的 index.html")
        deploy_ok = False

    # ── 5.5 写版本标记（供前端 version.json 自检 → 后台重部署后自动刷新页面）
    #     ⚠ 复用 gen_index.py 已在 HERE/version.json 写好的【完整版】（含 matches/t7Asia/t7Ou 等），
    #       只刷新 built/ts 时间戳，绝对不要再手写 {built,ts} 残桩，否则 _deploy 的 version.json 缺字段。
    try:
        import json as _json
        _vsrc = os.path.join(HERE, "version.json")
        if os.path.exists(_vsrc):
            with open(_vsrc, encoding="utf-8") as _f:
                vj = _json.load(_f)
        else:
            vj = {}
        vj["built"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        vj["ts"] = int(time.time() * 1000)
        with open(os.path.join(HERE, "_deploy", "version.json"), "w", encoding="utf-8") as f:
            _json.dump(vj, f, ensure_ascii=False)
        log("[版本] version.json 已写入 _deploy/（%s，matches=%s t7Asia=%s t7Ou=%s）" % (
            vj["built"], vj.get("matches"), vj.get("t7Asia"), vj.get("t7Ou")))
    except Exception as e:
        log("[版本] 写入失败 %s" % e)

    # ── 6. 自动分析：当日重点清单
    run([NODE, "auto_pick.cjs"], 420, "自动挑重点")

    # ── 7. 实盘落库已随 auto_pick 写入 live_log.json；此处结算已完赛场次（本地优先+历史回拉）
    #   ★ 2026-11-20 回拉打 gqj2（3 天/轮），同样过 567 自愈门
    if gqj2_gate():
        run([NODE, "settle_log.cjs"], 180, "实盘结算")
    else:
        log("[实盘结算] 跳过（gqj2 567 封禁冷却中）")

    # ── 7.2 真实资金样本账本（北单赔率池 + 必发成交）★ 2026-10-05 新增
    #      洋哥三盘法只有第三盘（北单/必发）带「资金占比」，而北单每天只开 12~17 场、
    #      okooo 只给当天（?date= 被服务端忽略，已实测）→ **只能自己按天累积**。
    #      必须放在 settle_log 之后：结算源（live_log）已刷新，本轮新完场的场次能立刻配到真比分。
    #      幂等只增不减；fund_log.json 不参与首屏，无需同步 _deploy。
    run([NODE, "fund_log.cjs"], 60, "资金账本")

    # ── 7.5 覆盖审计（2026-10-05 新增）
    #     用户反馈「新场次没更新、搜不到（如萧山华丰）」后加的常驻保险：
    #     逐条比对 gqj2 全量 + 球探 titan007 与底座 bake，把「源里有、座里没有」的场次打出来。
    #     ★ 口径坑（已踩）：底座队名是 HTML 实体 &#xe9xx; 形式（还夹 <span class="review"> 标签），
    #       必须先过 _pua_map 还原再做归一化，否则 1029 场球探会全部误判成"缺场"（实测 0 命中）。
    #     ★ 球探侧配对故意不含日期（与 ui.js mergeTitan007 的 nkey 一致），跨天开赛不重复入库。
    #     --net 才连 gqj2 源站做交叉核对（3s），默认纯本地，不拖慢主链。
    run([NODE, "_cover_audit.cjs"], 90, "覆盖审计")

    # ── 8. 实盘对账报告（样本外）
    run([NODE, "live_report.cjs"], 60, "实盘对账")

    # ── 9. 推送腾讯云 CVM（★ 2026-10-15 新增：主线上通道）
    #    背景：CloudStudio 沙箱空闲即回收（`workbuddy_sites_deploy` 连续 UND_ERR_SOCKET 已失效），
    #    线上真实通道＝腾讯云 CVM 42.193.242.59（Caddy :80，deploy_cvm.sh 一键 scp+sudo+自验）。
    #    refresh_all 本身不负责"部署"（见头注），但主链每 15 分跑，若不在此推 CVM，线上会冻在
    #    上一次手动部署那一刻。故：仅在本轮确实产出可部署 _deploy 时推一次；失败不阻断（下轮重试）。
    if deploy_ok:
        _cvm = os.path.join(HERE, "deploy_cvm.sh")
        if os.path.exists(_cvm):
            run(["bash", _cvm], 300, "推送腾讯云CVM")
        else:
            log("[CVM] deploy_cvm.sh 不存在，跳过线上推送")
    else:
        log("[CVM] 本轮无有效产物，跳过线上推送")

    log("全部完成，总耗时 %.0fs" % (time.time() - t_all))
    trim_log()


if __name__ == "__main__":
    main()
