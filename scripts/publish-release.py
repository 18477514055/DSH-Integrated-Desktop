#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
publish-release.py —— 把 `github/` 里的分发包建成 GitHub Release（桌面端用）

为什么不用 `gh release create`（**2026-09-20 实测，本机不可用**）：
  `gh` 本身是通的（带代理 `gh api rate_limit` 0.9 秒返回），
  但 `gh release create` 跑了 **20 分钟连 Release 都没建出来**（API 一直 404），
  进程活着、无输出、无报错。原因未定位 ⇒ 不跟它耗。

为什么上传**必须走 `curl.exe`**（同一次实测）：
  第一版用 `urllib` 单次 POST 传 88 MB，**卡死在代理上**：
  进程 CPU 累计只有 1 秒、内存 2 MB、TCP 只是挂在 `127.0.0.1:7897` 不动。
  换 `curl.exe --data-binary @文件` **流式**上传后，同一个文件 417 秒传完（201）。
  ⇒ 大文件一律 `curl`，并且带"低速自动放弃"守卫（`--speed-limit/--speed-time`），
    否则一个停滞的连接能把整轮发布挂死。

三条来自手机端 `publish.py` 真实事故的规矩（这里同样适用）：
  ① 附件名**必须 URL 编码** —— `+` 在查询串里表示空格，服务端收到带空格的名字后
     会消毒成 `.`（实测 `…v0.118.3+github…` → `…v0.118.3.github…`），
     于是文档里写的直链 404，而上传本身返回 201、脚本照报 ✅。
  ② **单文件重试** —— 本机出口会随机 RST，与文件大小无关；没有重试就得整轮重跑。
  ③ 重试前**清掉同名残留**，否则下一次必然 422 already_exists。

用法：
    $env:GITHUB_TOKEN = (gh auth token).Trim()
    python scripts/publish-release.py            # 建 Release + 传附件 + 回读
    python scripts/publish-release.py --check    # 只做本地校验，不联网上传

前置：先跑 `npm run release:bundle` 生成并审计 `github/`。
退出码：0 成功；1 失败。
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GH = os.path.join(ROOT, "github")
CHECK_ONLY = "--check" in sys.argv

# ══════════════════════════════════════════════════════════════════════════
# ★★ 先把 stdout/stderr 切到 UTF-8 —— 否则这个脚本会被**自己打印的一句话**弄挂
# ══════════════════════════════════════════════════════════════════════════
# 实测（2026-09-22，发布 0.2.7 时真的挂在发布这一步）：
#   UnicodeEncodeError: 'gbk' codec can't encode character '\u24ea'
#     at publish-release.py:171  print("\u24ea 本地校验（SHA256SUMS.txt 共 %d 条）")
# Windows 上 Python 的 stdout 默认跟控制台代码页走（本机是 GBK）。而 GBK **有** ①②③，
# 却**没有** ⓪(U+24EA) —— 于是"打印个序号"直接抛异常，整个发布会停在那里，
# 而且报错看着像编码问题、不像发布问题。
# ⇒ errors="replace" 是刻意的：宁可把个别符号打成 ?，也不该让一句日志否决整次发布。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:          # 老 Python / 被重定向成非文本流时就算了，别为这个崩
    pass

API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"

# ── 版本与仓库：以 package.json 为**单一出处**，不在脚本里另抄一遍 ──
with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
    PKG = json.load(f)
VERSION = PKG["version"]
TAG = "v" + VERSION
TITLE = "%s %s" % (PKG.get("productName", PKG["name"]), VERSION)
REPO = "18477514055/DSH-Integrated-Desktop"          # 见 package.json 的 repository
TARGET = "main"

# 上传的附件：两个安装包 + 源码包 + 校验清单（与 0.2.1 保持一致）
ASSETS = [
    os.path.join(GH, "DSH-Integrated-%s-x64.exe" % VERSION),
    os.path.join(GH, "DSH-Integrated-%s-portable-x64.exe" % VERSION),
    os.path.join(GH, "source", "DSH-Integrated-%s-source.zip" % VERSION),
    os.path.join(GH, "SHA256SUMS.txt"),
]
NOTES = os.path.join(GH, "RELEASE-NOTES.md")

CURL_OPTS = [
    "-sS", "-X", "POST",
    "--retry", "8", "--retry-all-errors", "--retry-delay", "5",
    "--connect-timeout", "30",
    # 低速守卫：连续 120 秒低于 20 KB/s 就放弃这一次，交给 --retry 重来
    "--speed-limit", "20480", "--speed-time", "120",
]


def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return "%.1f %s" % (n, u)
        n /= 1024.0


def sha256_of(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def token():
    t = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not t:
        sys.exit("没有 GITHUB_TOKEN（$env:GITHUB_TOKEN = (gh auth token).Trim()）")
    return t.strip()


def req(method, url, tok, data=None, ctype="application/json", timeout=180):
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dsh-desktop-publish",
    }
    if tok:
        headers["Authorization"] = "Bearer %s" % tok
    if ctype:
        headers["Content-Type"] = ctype
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def curl_upload(tok, rel_id, path):
    """用 curl 流式上传单个附件。多试几轮，每轮都先清掉同名残留。"""
    name = os.path.basename(path)
    url = "%s/repos/%s/releases/%s/assets?name=%s" % (
        UPLOADS, REPO, rel_id, urllib.parse.quote(name, safe=""))
    for attempt in range(1, 6):
        cmd = ["curl.exe"] + CURL_OPTS + [
            "-H", "Authorization: Bearer %s" % tok,
            "-H", "Content-Type: application/octet-stream",
            "-H", "Accept: application/vnd.github+json",
            "-H", "X-GitHub-Api-Version: 2022-11-28",
            "--data-binary", "@" + path,
            "-o", os.path.join(os.environ.get("TEMP", "."), "curl-asset.json"),
            "-w", "%{http_code}",
            url,
        ]
        t0 = time.time()
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=3600)
            code = (out.stdout or "").strip()
        except subprocess.TimeoutExpired:
            code = "timeout"
        dt = time.time() - t0
        if code in ("200", "201"):
            return True, code, dt
        print("     ⚠️ 第 %d 次失败（%s，%.0f 秒），清理同名残留后重试…" % (attempt, code, dt))
        # ★ 重试前必须清掉同名残留，否则下一次必然 422 already_exists
        st, b = req("GET", "%s/repos/%s/releases/%s/assets" % (API, REPO, rel_id), tok)
        if st == 200 and isinstance(b, list):
            for x in b:
                if x.get("name") == name:
                    req("DELETE", "%s/repos/%s/releases/assets/%s" % (API, REPO, x["id"]), tok)
        time.sleep(5)
    return False, code, 0.0


def main():
    print("=" * 70)
    print(" 发布 %s → %s" % (TAG, REPO))
    print("=" * 70)

    # ── ⓪ 本地校验：与 SHA256SUMS.txt 逐条比对（不信任任何自述）──
    sums = {}
    with open(os.path.join(GH, "SHA256SUMS.txt"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            if len(parts) == 2:
                sums[os.path.basename(parts[1].strip().lstrip("*"))] = parts[0].lower()
    print("⓪ 本地校验（SHA256SUMS.txt 共 %d 条）" % len(sums))
    ok_all = True
    for a in ASSETS:
        if not os.path.isfile(a):
            print("   ❌ 缺文件：%s（先跑 npm run release:bundle）" % a)
            ok_all = False
            continue
        name = os.path.basename(a)
        got = sha256_of(a)
        if name == "SHA256SUMS.txt":
            # 它给自己算不了哈希（清单列的是**其它**文件）
            print("   ➖ %-48s %10s  自校验不适用" % (name, human(os.path.getsize(a))))
            continue
        want = sums.get(name)
        good = (want == got)
        ok_all = ok_all and good
        print("   %s %-48s %10s  %s" % ("✅" if good else "❌", name, human(os.path.getsize(a)),
                                        "一致" if good else "期望 %s 实测 %s" % (want, got)))
    if not ok_all:
        sys.exit("本地校验未通过，一个字节都不上传")
    if CHECK_ONLY:
        print("\n--check：只校验，不上传。")
        return 0

    tok = token()

    # ── ① 建 Release（已存在就复用）──
    print("\n① 建 Release")
    st, body = req("GET", "%s/repos/%s/releases/tags/%s" % (API, REPO, TAG), tok)
    if st == 200 and isinstance(body, dict):
        rel = body
        print("   已存在，复用（id=%s，现有附件 %d 个）" % (rel["id"], len(rel.get("assets", []))))
    else:
        with open(NOTES, encoding="utf-8") as f:
            notes = f.read()
        payload = json.dumps({
            "tag_name": TAG, "target_commitish": TARGET, "name": TITLE,
            "body": notes, "draft": False, "prerelease": False,
        }).encode("utf-8")
        st, body = req("POST", "%s/repos/%s/releases" % (API, REPO), tok, payload)
        if st not in (200, 201):
            sys.exit("建 Release 失败（HTTP %s）：%s" % (st, str(body)[:400]))
        rel = body
        print("   已创建（id=%s，tag=%s）" % (rel["id"], rel["tag_name"]))

    # ── ② 传附件（curl 流式 + 重试 + 清残留）──
    print("\n② 上传附件")
    existing = {a["name"]: a for a in rel.get("assets", [])}
    for a in ASSETS:
        name = os.path.basename(a)
        if name in existing:
            st, _ = req("DELETE", "%s/repos/%s/releases/assets/%s" % (API, REPO, existing[name]["id"]), tok)
            print("   · 同名附件已存在，先删旧的（HTTP %s）" % st)
        print("   ↑ %s（%s）…" % (name, human(os.path.getsize(a))))
        good, code, dt = curl_upload(tok, rel["id"], a)
        if good:
            print("     ✅ HTTP %s（%.0f 秒）" % (code, dt))
        else:
            sys.exit("上传 %s 失败（%s）" % (name, code))

    # ── ③ 回读确认 ──
    print("\n③ 回读 Release")
    st, rel2 = req("GET", "%s/repos/%s/releases/tags/%s?t=%d" % (API, REPO, TAG, time.time()), tok)
    print("   tag=%s  附件 %d 个" % (rel2["tag_name"], len(rel2["assets"])))
    for x in sorted(rel2["assets"], key=lambda v: v["name"]):
        print("     %-48s %12d" % (x["name"], x["size"]))
    print("\n完成。下一步回验（**真下载回来重算**，别看这个脚本的自述）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
