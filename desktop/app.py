#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RC 飞行器总体设计器 —— 桌面版（pywebview 外壳）
================================================
本文件只做一件事：开一个原生桌面窗口，里面加载你的网站界面。
不包含任何 Inventor / pywin32 / COM 代码，不驱动任何建模。

窗口用的渲染引擎是系统自带的 Edge WebView2（Win11 自带，Win10 多数已装）。
所以按钮、表单、Three.js 3D、Excel 导出都和浏览器里表现一致。


打包用的图标、版本号等信息不在这里，见 README.md。
"""

import os
import sys
import pathlib
import traceback

# =====================================================================
# CONFIG —— 需要改的只有这一段
# =====================================================================

# 要加载的地址。二选一：
#
#   ① 远程网址（默认，你现在用的是 GitHub Pages）
APP_URL = "https://albertina1119.github.io/dsh-rc-designer/"
#
#   ② 本地 HTML 文件：把下面这行取消注释，并把上面那行注释掉
#      同时把 index.html 和它依赖的 js 文件放到本程序同一个文件夹
# APP_URL = "index.html"

# 窗口标题
WINDOW_TITLE = "RC 飞行器总体设计器"

# 窗口初始大小（像素）。网站是宽屏布局，别设太小
WINDOW_WIDTH = 1440
WINDOW_HEIGHT = 900

# 窗口最小尺寸，防止拖到比布局还窄
MIN_WIDTH = 1100
MIN_HEIGHT = 700

# 是否可调整大小
RESIZABLE = True

# 是否显示"调试"菜单（右键可开开发者工具）。发布版建议 False
DEBUG = False

# 关闭窗口时是否弹确认框
CONFIRM_CLOSE = False

# 是否允许窗口全屏（F11 行为由页面自己处理，这里只控制窗口属性）
FULLSCREEN = False


# =====================================================================
# 下面一般不用改
# =====================================================================

def 判断是否本地文件(target: str) -> bool:
    """不是 http/https 开头，就当作本地文件路径。"""
    t = target.strip().lower()
    if t.startswith("http://") or t.startswith("https://"):
        return False
    return True


def 解析成本地文件URI(target: str) -> str:
    """
    把本地 HTML 路径转成 file:// URI。
    优先找"程序同目录"，其次找"当前工作目录"，都不存在就报错。
    """
    candidates = []

    # ① 打包成 exe 后：exe 所在目录
    if getattr(sys, "frozen", False):
        candidates.append(pathlib.Path(sys.executable).parent / target)
    # ② 源码运行：app.py 所在目录
    candidates.append(pathlib.Path(__file__).parent / target)
    # ③ 当前工作目录
    candidates.append(pathlib.Path.cwd() / target)

    for c in candidates:
        if c.exists():
            return c.resolve().as_uri()

    需要 = "\n".join("    " + str(c) for c in candidates)
    raise FileNotFoundError(
        "找不到本地文件：" + target + "\n\n" +
        "找过这些位置：\n" + 需要 + "\n\n" +
        "请把 index.html 和它依赖的 .js 文件放在程序的同一目录下。"
    )


def 检查WebView2() -> str:
    """
    检查 Edge WebView2 运行时是否安装。
    返回空字符串表示没问题；返回非空字符串是给用户看的提示。

    WebView2 的注册表位置有两个（32 位 / 64 位系统各一个）。
    """
    if os.name != "nt":
        return ""  # 非 Windows 不做这个检查

    try:
        import winreg
    except Exception:
        return ""  # 拿不到注册表就不拦，让 pywebview 自己报错

    键路径 = (
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients"
        r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients"
        r"\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    )
    for 路径 in 键路径:
        for 根 in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(根, 路径) as k:
                    version, _ = winreg.QueryValueEx(k, "pv")
                    if version and version != "0.0.0.0":
                        return ""   # 找到了，运行时就绪
            except OSError:
                continue

    return (
        "这台电脑缺少 Microsoft Edge WebView2 运行时，窗口无法显示网页。\n\n"
        "解决办法（任选一个）：\n"
        "  1. 打开 Edge 浏览器，它一般会自动装好；之后重新运行本程序\n"
        "  2. 手动下载安装（免费，约 2 MB）：\n"
        "     https://developer.microsoft.com/microsoft-edge/webview2/\n"
        "     下载页面里的“常青独立安装程序 (Evergreen Standalone Installer)”"
    )


def 显示错误(标题: str, 内容: str) -> None:
    """
    显示错误提示。优先用系统弹窗（不依赖 webview），再退回控制台。
    """
    try:
        import ctypes
        # 0x10 = MB_ICONERROR，让图标是红色叉
        ctypes.windll.user32.MessageBoxW(None, 内容, 标题, 0x10)
        return
    except Exception:
        pass
    try:
        print("[" + 标题 + "]")
        print(内容)
    except Exception:
        pass


def main() -> int:
    # ① 先确认 pywebview 装了没有
    try:
        import webview
    except ImportError:
        显示错误(
            WINDOW_TITLE,
            "缺少组件 pywebview。\n\n"
            "如果你在用源码运行，请先执行：\n"
            "    pip install -r requirements.txt\n\n"
            "如果你拿到的是打包好的 .exe，说明打包不完整，请重新打包。"
        )
        return 2

    # ② 检查 WebView2 运行时
    缺失提示 = 检查WebView2()
    if 缺失提示:
        显示错误(WINDOW_TITLE, 缺失提示)
        return 3

    # ③ 决定加载地址
    try:
        if 判断是否本地文件(APP_URL):
            地址 = 解析成本地文件URI(APP_URL)
        else:
            地址 = APP_URL
    except FileNotFoundError as e:
        显示错误(WINDOW_TITLE, str(e))
        return 4

    # ④ 创建窗口
    #    这些参数对应 pywebview 的 create_window：标题、地址、尺寸、能否缩放
    window = webview.create_window(
        title=WINDOW_TITLE,
        url=地址,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=(MIN_WIDTH, MIN_HEIGHT),
        resizable=RESIZABLE,
        fullscreen=FULLSCREEN,
        confirm_close=CONFIRM_CLOSE,
        text_select=True,      # 允许选中文字（方便复制参数）
        easy_drag=False,       # 不用无边框拖拽
    )

    # ⑤ 启动事件循环
    #    gui="edgechromium" 强制用 Edge WebView2 内核，避免退化成老 IE 内核
    #    如果你的 pywebview 版本不认识这个参数，会自动忽略，不影响运行
    try:
        webview.start(debug=DEBUG, gui="edgechromium")
    except TypeError:
        # 老版本 pywebview 没有 gui 参数
        webview.start(debug=DEBUG)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        # 兜底：任何没预料到的异常都弹窗，而不是静默退出
        显示错误(
            WINDOW_TITLE + " 启动失败",
            "程序启动时出错：\n\n" + traceback.format_exc()
        )
        sys.exit(1)
