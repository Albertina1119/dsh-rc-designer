#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RC 飞行器总体设计器 —— 桌面版 + Inventor 驱动
==============================================
一个 pywebview 窗口加载你的网站，同时通过 js_api 把「修改 Inventor 参数」的能力
暴露给网页。网页上点一个按钮，Python 这边就去改 Inventor 里的参数并另存 .ipt。

设计原则（都是根据实际踩过的坑定的）：
  · 绝不自动启动 Inventor —— 只附着到已经在运行的那个
  · 绝不覆盖已存在的文件 —— 同名自动改成 xxx_001.ipt
  · 拒绝 template 和 saveAs 是同一个文件 —— 否则等于用改过的模型覆盖模板
  · 有未保存文档时默认拒绝执行 —— 保护你正在做的工作
  · 全程不调用 Save() —— 只用 SaveAs 写到新路径
  · 任何异常都被捕获并返回给网页，程序不闪退
  · 所有 COM 调用都在 CoInitialize / CoUninitialize 之间

需要改的只有下面 CONFIG 区。
"""

import os
import sys
import json
import time
import threading
import traceback
import pathlib

# =====================================================================
# CONFIG —— 需要改的只有这一段
# =====================================================================

# 要加载的地址。二选一：
#   ① 远程网址（默认，你现在用的是 GitHub Pages）
APP_URL = "https://albertina1119.github.io/dsh-rc-designer/"
#   ② 本地 HTML 文件：把上面那行注释掉，改成下面这行，
#      并把 index.html 与依赖的 .js 放到本程序同一文件夹
# APP_URL = "index.html"

WINDOW_TITLE = "RC 飞行器总体设计器"
WINDOW_WIDTH = 1440
WINDOW_HEIGHT = 900
MIN_WIDTH = 1100
MIN_HEIGHT = 700
RESIZABLE = True
DEBUG = False
CONFIRM_CLOSE = False
FULLSCREEN = False

# ---- Inventor 安全开关 ----
# True  = Inventor 里有任何文档打开就拒绝执行（最安全，建议保持）
# False = 允许有文档打开，只检查"有未保存改动"的
REQUIRE_EMPTY_SESSION = False
# True  = 允许覆盖已存在的 saveAs（不建议）
ALLOW_OVERWRITE = False
# 保存后是否关闭文档（关闭不保存）。True 时每次调用结束 Inventor 回到干净状态
CLOSE_AFTER_SAVE = True
# 单次建模最长等待（秒），超时就返回错误，避免界面一直转圈
BUILD_TIMEOUT = 180


# =====================================================================
# 路径与日志
# =====================================================================

def app_dir() -> str:
    """打包成 exe 后取 exe 所在目录；源码运行时取 app.py 所在目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


LOG_PATH = os.path.join(app_dir(), "app.log")
_log_lock = threading.Lock()
LOG_MAX_BYTES = 2 * 1024 * 1024


def log(msg: str) -> None:
    """写日志。任何异常都不允许把程序搞挂。"""
    line = "%s  %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        if sys.stdout is not None:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
    except Exception:
        pass
    try:
        with _log_lock:
            if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
                try:
                    if os.path.exists(LOG_PATH + ".1"):
                        os.remove(LOG_PATH + ".1")
                    os.replace(LOG_PATH, LOG_PATH + ".1")
                except Exception:
                    pass
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        pass


def 显示错误(标题: str, 内容: str) -> None:
    """用系统弹窗显示错误（不依赖 webview）。"""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, 内容, 标题, 0x10)
        return
    except Exception:
        pass
    try:
        print("[" + 标题 + "]\n" + 内容)
    except Exception:
        pass


# =====================================================================
# Inventor 操作
# =====================================================================

class BridgeError(Exception):
    """业务错误。message 会原样返回给网页。"""


def _win32():
    """
    延迟导入 win32com / pythoncom。
    这样即使这台机器没装 pywin32，网页窗口仍然能正常打开，只在建模时报错。
    """
    try:
        import win32com.client          # noqa: F401
        import pythoncom                # noqa: F401
        return win32com.client, pythoncom
    except ImportError as e:
        raise BridgeError(
            "缺少 pywin32 组件（win32com / pythoncom）。"
            "请确认打包时包含了 pywin32。原始错误：%s" % e
        )


def 附着Inventor(win32client):
    """
    只附着到已经在运行的 Inventor，绝不自动启动新实例。
    启动一个空的 Inventor 对用户没有意义，而且会掩盖真正的原因。
    """
    try:
        app = win32client.GetActiveObject("Inventor.Application")
    except Exception:
        raise BridgeError(
            "请先打开 Inventor。当前没有检测到正在运行的 Inventor 进程，"
            "本程序不会替你启动它。"
        )
    if app is None:
        raise BridgeError("请先打开 Inventor。")
    return app


def 列出打开的文档(app):
    names = []
    try:
        n = app.Documents.Count
        for i in range(1, n + 1):
            try:
                names.append(str(app.Documents.Item(i).FullFileName))
            except Exception:
                names.append("<无法读取名称>")
    except Exception:
        pass
    return names


def 统计未保存文档(app):
    """
    数一下有多少文档有未保存改动（Dirty）。
    这是保护用户的关键：有脏文档时我们拒绝动手。
    """
    dirty = []
    try:
        n = app.Documents.Count
        for i in range(1, n + 1):
            try:
                d = app.Documents.Item(i)
                if d.Dirty:
                    dirty.append(str(d.FullFileName))
            except Exception:
                pass
    except Exception:
        pass
    return dirty


def 安全关闭(doc):
    """关闭我们打开的文档，且不保存。doc 是我们自己开的，关掉是安全的。"""
    if doc is None:
        return
    try:
        doc.Close(True)      # True = 不提示、不保存
    except Exception:
        pass


def 生成不冲突路径(path: str) -> str:
    """同名文件已存在时，生成 xxx_001.ipt / xxx_002.ipt …"""
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    for i in range(1, 1000):
        cand = "%s_%03d%s" % (stem, i, ext)
        if not os.path.exists(cand):
            return cand
    raise BridgeError("同名文件太多，无法生成不冲突的文件名：%s" % path)


def 归一化路径(p: str) -> str:
    try:
        return os.path.normcase(os.path.abspath(p))
    except Exception:
        return p


def 转成表达式(value) -> str:
    """
    把参数值转成 Inventor 能接受的 Expression。
      数字   -> 当作毫米，例如 120 变成 "120 mm"
      字符串 -> 原样传（支持 "120 mm"、"2.5 in"、"30 deg"）
    """
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return "%s mm" % value
    s = str(value).strip()
    if not s:
        raise BridgeError("参数值为空")
    return s


def 列参数名(params) -> list:
    names = []
    try:
        for i in range(1, params.Count + 1):
            try:
                names.append(str(params.Item(i).Name))
            except Exception:
                pass
    except Exception:
        pass
    return names


# 串行锁：防止用户连点两次按钮导致两个 COM 会话打架
_BUILD_LOCK = threading.Lock()


def 执行建模(form_data: dict) -> dict:
    """
    真正干活的函数。所有 COM 调用都在这里，全程 try/except。
    返回 {"status":"ok", ...} 或 {"status":"error", "message": ...}
    """
    win32client, pythoncom = _win32()

    # ---------- 1. 参数校验（全部在碰 Inventor 之前做完）----------
    if not isinstance(form_data, dict):
        raise BridgeError("form_data 必须是一个对象")

    template = form_data.get("template")
    params = form_data.get("params") or {}
    save_as = form_data.get("saveAs")
    dry_run = bool(form_data.get("dryRun"))

    if not template:
        raise BridgeError("缺少 template（.ipt 模板路径）")
    if not isinstance(params, dict):
        raise BridgeError('params 必须是对象，例如 {"Length": "120 mm"}')
    if not dry_run and not save_as:
        raise BridgeError('缺少 saveAs（保存路径）。只想试算不落盘请传 "dryRun": true')

    template = os.path.abspath(str(template))
    if not template.lower().endswith(".ipt"):
        raise BridgeError("template 必须是 .ipt 零件文件：%s" % template)
    if not os.path.isfile(template):
        raise BridgeError("模板文件不存在：%s" % template)

    if save_as and not dry_run:
        save_as = os.path.abspath(str(save_as))
        # 关键：template 和 saveAs 相同 = 用改过的模型覆盖你的模板
        if 归一化路径(save_as) == 归一化路径(template):
            raise BridgeError(
                "saveAs 和 template 是同一个文件，这会用改过的模型覆盖你的模板。已拒绝。"
            )
        out_dir = os.path.dirname(save_as) or "."
        if not os.path.isdir(out_dir):
            try:
                os.makedirs(out_dir, exist_ok=True)
                log("已创建保存目录：%s" % out_dir)
            except Exception as e:
                raise BridgeError("保存目录不存在且无法创建：%s（%s）" % (out_dir, e))
        if os.path.exists(save_as):
            if not ALLOW_OVERWRITE:
                new_path = 生成不冲突路径(save_as)
                log("目标已存在，改为另存：%s -> %s" % (save_as, new_path))
                save_as = new_path
            else:
                log("警告：允许覆盖已存在文件 %s" % save_as)

    # ---------- 2. 连接 Inventor ----------
    app = 附着Inventor(win32client)
    log("已连接 Inventor：%s" % _safe_attr(app, "SoftwareVersion", "?"))

    # ---------- 3. 安全闸门 ----------
    open_docs = 列出打开的文档(app)
    dirty_docs = 统计未保存文档(app)

    if REQUIRE_EMPTY_SESSION and open_docs:
        raise BridgeError(
            "Inventor 当前有 %d 个文档打开，为保护你正在做的工作已拒绝执行。"
            "请先全部关闭（文件 → 关闭全部）再试。当前打开：%s"
            % (len(open_docs), "; ".join(open_docs[:5]))
        )
    if dirty_docs:
        raise BridgeError(
            "Inventor 里有 %d 个文档存在未保存改动，为保护这些改动已拒绝执行。"
            "请先保存或关闭它们。涉及：%s"
            % (len(dirty_docs), "; ".join(dirty_docs[:5]))
        )

    doc = None
    applied = []
    try:
        # ---------- 4. 打开模板（不可见，不弹窗）----------
        log("打开模板：%s" % template)
        try:
            doc = app.Documents.Open(template, False)      # False = 不显示窗口
        except Exception as e:
            raise BridgeError("打开模板失败：%s" % e)

        # ---------- 5. 改参数 ----------
        try:
            param_coll = doc.ComponentDefinition.Parameters
        except Exception as e:
            raise BridgeError("读取参数表失败：%s" % e)

        for name, value in params.items():
            key = str(name)
            expr = 转成表达式(value)
            try:
                p = param_coll.Item(key)
            except Exception:
                avail = 列参数名(param_coll)
                raise BridgeError(
                    "模板里没有名为「%s」的参数。可用参数（前 30 个）：%s"
                    % (key, ", ".join(avail[:30]) if avail else "（读不到，请检查模板）")
                )
            try:
                old = ""
                try:
                    old = str(p.Expression)
                except Exception:
                    pass
                p.Expression = expr
                applied.append("%s: %s -> %s" % (key, old, expr))
            except Exception as e:
                raise BridgeError("设置参数「%s」=%s 失败：%s" % (key, expr, e))

        log("已应用 %d 个参数：%s" % (len(applied), "; ".join(applied)))

        # ---------- 6. 重建模型 ----------
        try:
            doc.Update()
        except Exception as e:
            raise BridgeError("模型重建失败（参数可能互相冲突）：%s" % e)
        log("模型已重建")

        if dry_run:
            return {
                "status": "ok",
                "dryRun": True,
                "applied": applied,
                "message": "参数已应用并重建成功；未保存任何文件。",
            }

        # ---------- 7. 另存为 ----------
        log("另存为：%s" % save_as)
        try:
            doc.SaveAs(save_as, False)     # False = 不是"另存副本"
        except Exception as e:
            raise BridgeError("另存失败：%s（原模板未被修改）" % e)

        # ---------- 8. 校验产物 ----------
        try:
            size = os.path.getsize(save_as)
        except Exception:
            size = -1
        if size <= 0:
            raise BridgeError("另存后文件不存在或为空：%s" % save_as)

        log("完成：%s（%d KB）" % (save_as, size // 1024))
        return {
            "status": "ok",
            "file": save_as,
            "bytes": size,
            "applied": applied,
            "template": template,
        }
    finally:
        if CLOSE_AFTER_SAVE:
            安全关闭(doc)
            doc = None


def _safe_attr(obj, name, default=None):
    try:
        return getattr(obj, name)
    except Exception:
        return default


# =====================================================================
# 暴露给网页的 API（pywebview js_api）
# =====================================================================

class Api:
    """
    网页里通过 window.pywebview.api.xxx() 调用这里的方法。
    方法名不要以下划线开头 —— pywebview 只暴露公开方法。
    """

    # ---------- 建模 ----------
    def generate_model(self, form_data=None):
        """
        网页调用：pywebview.api.generate_model({template, params, saveAs})
        返回：{"status":"ok", "file": "..."} 或 {"status":"error", "message": "..."}
        """
        with _BUILD_LOCK:
            # COM 必须在每个使用它的线程里单独初始化
            pythoncom = None
            inited = False
            try:
                try:
                    import pythoncom as _pc
                    pythoncom = _pc
                    _pc.CoInitialize()
                    inited = True
                except Exception:
                    # 没有 pywin32 时也让错误走正常流程返回给网页
                    pass

                data = form_data
                if isinstance(data, str):
                    # 容忍网页传 JSON 字符串的情况
                    try:
                        data = json.loads(data)
                    except Exception as e:
                        raise BridgeError("form_data 不是合法 JSON：%s" % e)
                if data is None:
                    data = {}

                log("收到建模请求：template=%s 参数 %d 个 saveAs=%s dryRun=%s" % (
                    data.get("template"), len(data.get("params") or {}),
                    data.get("saveAs"), data.get("dryRun")))

                result = 执行建模(data)
                return result

            except BridgeError as e:
                log("失败：%s" % e)
                return {"status": "error", "message": str(e)}
            except Exception as e:
                log("未预期错误：%s\n%s" % (e, traceback.format_exc()))
                return {"status": "error", "message": "未预期的错误：%s" % e}
            finally:
                # 所有 COM 引用必须在使用完之后、CoUninitialize 之前丢掉
                try:
                    import gc
                    gc.collect()
                except Exception:
                    pass
                if inited and pythoncom is not None:
                    try:
                        pythoncom.CoUninitialize()
                    except Exception:
                        pass

    # ---------- 状态查询（网页用来显示绿点/红点）----------
    def get_status(self):
        """网页调用：pywebview.api.get_status()，检查 Inventor 是否可用。"""
        pythoncom = None
        inited = False
        try:
            try:
                import pythoncom as _pc
                pythoncom = _pc
                _pc.CoInitialize()
                inited = True
            except Exception:
                pass

            win32client, _ = _win32()
            app = 附着Inventor(win32client)
            docs = 列出打开的文档(app)
            dirty = 统计未保存文档(app)
            return {
                "status": "ok",
                "connected": True,
                "version": str(_safe_attr(app, "SoftwareVersion", "?")),
                "caption": str(_safe_attr(app, "Caption", "")),
                "openDocuments": docs,
                "dirtyDocuments": dirty,
                "ready": (len(dirty) == 0),
                "logFile": LOG_PATH,
            }
        except BridgeError as e:
            return {"status": "ok", "connected": False, "reason": str(e),
                    "logFile": LOG_PATH}
        except Exception as e:
            log("get_status 异常：%s" % e)
            return {"status": "ok", "connected": False, "reason": str(e),
                    "logFile": LOG_PATH}
        finally:
            if inited and pythoncom is not None:
                try:
                    pythoncom.CoUninitialize()
                except Exception:
                    pass


# =====================================================================
# 窗口
# =====================================================================

def 判断是否本地文件(target: str) -> bool:
    t = (target or "").strip().lower()
    return not (t.startswith("http://") or t.startswith("https://"))


def 解析成本地文件URI(target: str) -> str:
    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(pathlib.Path(sys.executable).parent / target)
    candidates.append(pathlib.Path(__file__).parent / target)
    candidates.append(pathlib.Path.cwd() / target)
    for c in candidates:
        if c.exists():
            return c.resolve().as_uri()
    需要 = "\n".join("    " + str(c) for c in candidates)
    raise FileNotFoundError(
        "找不到本地文件：" + target + "\n\n找过这些位置：\n" + 需要
    )


def 检查WebView2() -> str:
    if os.name != "nt":
        return ""
    try:
        import winreg
    except Exception:
        return ""
    键路径 = (
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    )
    for 路径 in 键路径:
        for 根 in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(根, 路径) as k:
                    version, _ = winreg.QueryValueEx(k, "pv")
                    if version and version != "0.0.0.0":
                        return ""
            except OSError:
                continue
    return (
        "这台电脑缺少 Microsoft Edge WebView2 运行时，窗口无法显示网页。\n\n"
        "解决办法：\n"
        "  1. 打开 Edge 浏览器，它一般会自动装好；之后重新运行本程序\n"
        "  2. 或手动下载（免费，约 2 MB）：\n"
        "     https://developer.microsoft.com/microsoft-edge/webview2/\n"
        "     选「常青独立安装程序 (Evergreen Standalone Installer)」"
    )


def main() -> int:
    try:
        import webview
    except ImportError:
        显示错误(WINDOW_TITLE,
                 "缺少组件 pywebview。\n\n"
                 "源码运行请先执行：pip install -r requirements.txt\n"
                 "拿到的是 exe 则说明打包不完整。")
        return 2

    缺失 = 检查WebView2()
    if 缺失:
        显示错误(WINDOW_TITLE, 缺失)
        return 3

    try:
        地址 = 解析成本地文件URI(APP_URL) if 判断是否本地文件(APP_URL) else APP_URL
    except FileNotFoundError as e:
        显示错误(WINDOW_TITLE, str(e))
        return 4

    log("=" * 60)
    log("启动：%s" % 地址)
    log("日志：%s" % LOG_PATH)

    # 启动时探一次 Inventor，把结论写进日志（不阻塞窗口）
    try:
        win32client, pythoncom = _win32()
        pythoncom.CoInitialize()
        try:
            app = 附着Inventor(win32client)
            log("Inventor 已就绪：%s / %s" % (
                _safe_attr(app, "SoftwareVersion", "?"),
                _safe_attr(app, "Caption", "")))
            dirty = 统计未保存文档(app)
            if dirty:
                log("注意：有 %d 个文档存在未保存改动，建模请求会被拒绝" % len(dirty))
        finally:
            pythoncom.CoUninitialize()
    except BridgeError as e:
        log("Inventor 未就绪：%s" % e)
        log("窗口照常打开；等你打开 Inventor 后点按钮即可。")
    except Exception as e:
        log("启动探测异常（不影响窗口）：%s" % e)

    api = Api()

    window = webview.create_window(
        title=WINDOW_TITLE,
        url=地址,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=(MIN_WIDTH, MIN_HEIGHT),
        resizable=RESIZABLE,
        fullscreen=FULLSCREEN,
        confirm_close=CONFIRM_CLOSE,
        text_select=True,
        easy_drag=False,
        js_api=api,                 # ← 关键：把 Api 暴露给网页
    )

    try:
        webview.start(debug=DEBUG, gui="edgechromium")
    except TypeError:
        webview.start(debug=DEBUG)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        显示错误(WINDOW_TITLE + " 启动失败",
                 "程序启动时出错：\n\n" + traceback.format_exc())
        sys.exit(1)
