import base64
import json
import os
import subprocess
import sys
import urllib.request

OWNER = "zhangwenda0518"
REPO = "ai-tools"
ROOT = r"D:\桌面\ai-tools"
BRANCH = "main"
MESSAGE = """feat: 飞书文档图片/表格批量导出扩展 v0.1.0

- 自动滚动扫描虚拟滚动文档，按 block-id 去重收集图片块与表格块
- 图片走 image-token 接口取原图（非页面压缩预览）
- 表格处理 rowspan/colspan 还原，导出 UTF-8 BOM CSV
- 悬浮面板逐张勾选，自写 STORE 模式 ZIP 打包（无依赖）
- 从图片字节解析真实像素尺寸写入 index.md 清单"""

TOKEN = subprocess.check_output(["gh", "auth", "token"], text=True).strip()


def api(method, path, payload=None):
    url = f"https://api.github.com/repos/{OWNER}/{REPO}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "ai-tools-push")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode()
        return json.loads(body) if body else {}


def walk_files():
    skip_dirs = {".git", "node_modules", "__pycache__"}
    out = []
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for f in sorted(files):
            if f.endswith(".zip"):
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
            with open(p, "rb") as fh:
                out.append((rel, fh.read()))
    return out


def main():
    files = walk_files()
    print(f"files: {len(files)}")

    # an empty repo rejects /git/blobs with 409; seed it with one tiny file via the
    # Contents API so the git objects API starts working.
    seed = api("PUT", "/contents/.gitkeep", {
        "message": "chore: init repository",
        "content": base64.b64encode(b"").decode(),
    })
    parent = seed["commit"]["sha"]
    print("seed commit:", parent)

    tree = []
    for rel, data in files:
        blob = api("POST", "/git/blobs", {
            "content": base64.b64encode(data).decode(),
            "encoding": "base64",
        })
        tree.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print(f"  blob {blob['sha'][:8]} {rel} ({len(data)}B)")

    t = api("POST", "/git/trees", {"tree": tree})
    print("tree:", t["sha"])

    commit = api("POST", "/git/commits", {"message": MESSAGE, "tree": t["sha"], "parents": [parent]})
    print("commit:", commit["sha"])

    try:
        api("POST", "/git/refs", {"ref": f"refs/heads/{BRANCH}", "sha": commit["sha"]})
    except urllib.error.HTTPError as e:
        if e.code == 422:
            api("PATCH", f"/git/refs/heads/{BRANCH}", {"sha": commit["sha"], "force": True})
        else:
            raise
    print("ref ok ->", f"https://github.com/{OWNER}/{REPO}")


if __name__ == "__main__":
    main()
