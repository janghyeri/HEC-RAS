"""HEC-RAS 창 살펴보기 (Windows 전용) — 명령줄 계산이 대화상자 때문에 멈췄는지 알아내고 그 글자를 기록한다.

2026-11-02 기록: 워커가 Ras.exe에 파일 이름을 따옴표 없이 넘기자 HEC-RAS가 '명령줄 매개변수 오류' 창을
띄우고 결과 파일을 하나도 쓰지 않은 채 1시간(시간 제한)까지 멈춰 있었다. 화면을 보는 사람이 없으면 이런 창이
떠도 알 수 없으므로, 워커가 HEC-RAS 프로세스(와 그 자식)의 창 제목·글자를 직접 읽어 실행 기록에 남긴다.

Windows가 아니면 빈 결과를 돌려준다 (Linux에서 시험할 때).
"""
from __future__ import annotations

import subprocess
import sys

IS_WIN = sys.platform == "win32"
DIALOG_CLASS = "#32770"      # Windows 표준 대화상자(MessageBox 포함) 창 종류
MAX_TEXT = 300               # 창 글자 하나당 기록 길이


def process_tree(root: int, root_alive: bool = True, known: dict[int, str] | None = None) -> dict[int, str]:
    """root 프로세스와 그 자식·손자 {pid: 실행 파일 이름}.

    root가 이미 끝났으면(root_alive=False) root 번호는 다른 프로그램이 다시 쓸 수 있으므로 쓰지 않고,
    지난번에 본 자식(known) 가운데 같은 번호·같은 실행 파일로 아직 살아 있는 것과 그 자식만 돌려준다.
    → 강제 종료할 때 상관없는 프로그램을 끝내지 않는다."""
    if not IS_WIN:
        return {}
    import ctypes
    from ctypes import wintypes

    class PE(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PE)]
    k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PE)]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]

    snap = k32.CreateToolhelp32Snapshot(0x2, 0)          # TH32CS_SNAPPROCESS
    if not snap or snap == ctypes.c_void_p(-1).value:
        return {}
    procs: dict[int, tuple[int, str]] = {}
    try:
        e = PE()
        e.dwSize = ctypes.sizeof(PE)
        ok = k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            procs[e.th32ProcessID] = (e.th32ParentProcessID, e.szExeFile)
            ok = k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)

    if root_alive and root in procs:
        want = {root}
    else:
        want = {p for p, exe in (known or {}).items() if p != root and p in procs and procs[p][1] == exe}
    out = {p: procs[p][1] for p in want}
    grew = True
    while grew:
        grew = False
        for pid, (ppid, exe) in procs.items():
            if ppid in want and pid not in want and pid != ppid:
                want.add(pid)
                out[pid] = exe
                grew = True
    return out


def windows(pids: dict[int, str]) -> list[dict]:
    """주어진 프로세스들의 보이는 창: 제목, 창 종류, 안쪽 글자(버튼·문구)."""
    if not IS_WIN or not pids:
        return []
    import ctypes
    from ctypes import wintypes

    u32 = ctypes.WinDLL("user32", use_last_error=True)
    PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    u32.EnumWindows.argtypes = [PROC, wintypes.LPARAM]
    u32.EnumChildWindows.argtypes = [wintypes.HWND, PROC, wintypes.LPARAM]
    u32.IsWindowVisible.argtypes = [wintypes.HWND]
    u32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    u32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    u32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                        wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
    u32.SendMessageTimeoutW.restype = wintypes.LPARAM

    WM_GETTEXT, WM_GETTEXTLENGTH, SMTO_ABORTIFHUNG = 0x000D, 0x000E, 0x0002

    def text(h) -> str:
        # 다른 프로세스의 버튼·문구 글자는 GetWindowText로 못 읽는다 → WM_GETTEXT (0.5초 제한)
        n = ctypes.c_size_t(0)
        if not u32.SendMessageTimeoutW(h, WM_GETTEXTLENGTH, 0, 0, SMTO_ABORTIFHUNG, 500, ctypes.byref(n)):
            return ""
        size = min(n.value, 4000) + 1
        buf = ctypes.create_unicode_buffer(size)
        r = ctypes.c_size_t(0)
        if not u32.SendMessageTimeoutW(h, WM_GETTEXT, size, ctypes.cast(buf, ctypes.c_void_p).value,
                                       SMTO_ABORTIFHUNG, 500, ctypes.byref(r)):
            return ""
        return buf.value

    def cls(h) -> str:
        buf = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(h, buf, 256)
        return buf.value

    out: list[dict] = []

    def on_top(h, _):
        try:
            if not u32.IsWindowVisible(h):
                return True
            pid = wintypes.DWORD()
            u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
            if pid.value not in pids:
                return True
            texts: list[str] = []

            def on_child(c, _):
                try:
                    if u32.IsWindowVisible(c):
                        t = " ".join(text(c).split())
                        if t:
                            texts.append(t[:MAX_TEXT])
                except Exception:
                    pass
                return True

            child_cb = PROC(on_child)
            u32.EnumChildWindows(h, child_cb, 0)
            out.append({"pid": pid.value, "exe": pids[pid.value], "class": cls(h),
                        "title": text(h)[:MAX_TEXT], "texts": texts[:20]})
        except Exception:
            pass
        return True

    top_cb = PROC(on_top)
    u32.EnumWindows(top_cb, 0)
    return out


DIALOG_WORDS = ("error parsing command line", "unrecognized command parameter")


def dialogs(wins: list[dict]) -> list[dict]:
    """표준 대화상자(오류·경고·확인 창)와 HEC-RAS 명령줄 오류 창."""
    out = []
    for w in wins:
        body = " ".join([w.get("title") or ""] + list(w.get("texts") or [])).lower()
        if w.get("class") == DIALOG_CLASS or any(k in body for k in DIALOG_WORDS):
            out.append(w)
    return out


def describe(wins: list[dict]) -> str:
    parts = []
    for w in wins:
        body = " / ".join(w.get("texts") or [])
        parts.append(f"[{w.get('exe')}] '{w.get('title')}'" + (f": {body}" if body else ""))
    return " | ".join(parts)


def kill(pids, proc=None) -> None:
    """프로세스 트리 강제 종료 (Ras.exe + 계산 프로그램)."""
    if IS_WIN:
        for pid in sorted(pids, reverse=True):
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
    if proc is not None and proc.poll() is None:
        proc.kill()
