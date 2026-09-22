"""解包 fpk 并按 NAS 上的方式真实启动一次，确认「能装就能跑」。

模拟 install_callback 的行为：
  - 内层 app.tgz 解到 <appdest>/target
  - providers.json 复制到 <pkgvar>/config
  - 生成 admin-token
然后用 NAS 同款环境变量启动 node，打 /healthz、/v1/models 与一次对话请求。
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
VERIFY = os.path.join(BUILD, "verify")
NODE = r"C:\Users\AGG\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
PORT = "8791"
TOKEN = "gw-selftest-token-for-nas"


def find_fpk():
    cands = [f for f in os.listdir(ROOT) if f.endswith(".fpk")]
    if not cands:
        print("找不到 fpk，请先跑 tools/build_fpk.py")
        sys.exit(1)
    cands.sort(key=lambda f: os.path.getmtime(os.path.join(ROOT, f)), reverse=True)
    return os.path.join(ROOT, cands[0])


def extract(fpk):
    if os.path.isdir(VERIFY):
        shutil.rmtree(VERIFY)
    outer = os.path.join(VERIFY, "appdest")
    os.makedirs(outer)
    with tarfile.open(fpk, "r:gz") as t:
        t.extractall(outer)

    inner_path = os.path.join(outer, "app.tgz")
    target = os.path.join(outer, "target")
    os.makedirs(target)
    with tarfile.open(inner_path, "r:gz") as it:
        members = it.getnames()
        if any(m.startswith("./") for m in members):
            print("  ✗ 内层成员名带 './' 前缀，解包后路径会错")
            sys.exit(1)
        it.extractall(target)
    return outer, target


def prepare_var(target):
    var = os.path.join(VERIFY, "pkgvar")
    cfg = os.path.join(var, "config")
    data = os.path.join(var, "data")
    os.makedirs(cfg, exist_ok=True)
    os.makedirs(data, exist_ok=True)
    shutil.copy2(os.path.join(target, "server", "config", "providers.json"),
                 os.path.join(cfg, "providers.json"))
    with open(os.path.join(var, "admin-token"), "w", encoding="utf-8") as fh:
        fh.write(TOKEN)
    return var, cfg, data


def http(path, method="GET", body=None, token=None):
    url = f"http://127.0.0.1:{PORT}{path}"
    req = urllib.request.Request(url, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    payload = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, payload, timeout=25) as res:
            return res.status, res.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def main():
    fpk = find_fpk()
    print(f"\n=== 验证 fpk：{os.path.basename(fpk)} ===\n")
    print(f"  产物大小：{os.path.getsize(fpk) / 1024:.1f} KB")

    outer, target = extract(fpk)
    print(f"  解包完成 → {target}")

    server_dir = os.path.join(target, "server")
    entry = os.path.join(server_dir, "src", "index.js")
    if not os.path.isfile(entry):
        print("  ✗ 解包后找不到 server/src/index.js")
        sys.exit(1)

    var, cfg, data = prepare_var(target)
    print(f"  持久目录 → {var}")

    env = dict(os.environ)
    env.update({
        "NODE_ENV": "production",
        "GATEWAY_HOST": "127.0.0.1",
        "GATEWAY_PORT": PORT,
        "GATEWAY_CONFIG_DIR": cfg,
        "GATEWAY_DATA_DIR": data,
        "GATEWAY_ADMIN_TOKEN": TOKEN,
    })

    logfile = open(os.path.join(BUILD, "verify-server.log"), "w", encoding="utf-8")
    proc = subprocess.Popen([NODE, "src/index.js"], cwd=server_dir, env=env,
                            stdout=logfile, stderr=subprocess.STDOUT)

    ok = True
    try:
        deadline = time.time() + 20
        alive = False
        while time.time() < deadline:
            try:
                status, text = http("/healthz")
                if status == 200:
                    alive = True
                    data_json = json.loads(text)
                    print(f"  ✓ /healthz 200  渠道 {data_json['providers']} 个 / 模型 {data_json['models']} 个")
                    break
            except Exception:
                time.sleep(0.5)
        if not alive:
            print("  ✗ 服务 20 秒内没有起来，日志：")
            logfile.flush()
            print(open(os.path.join(BUILD, "verify-server.log"), encoding="utf-8").read()[-2000:])
            ok = False

        if ok:
            status, text = http("/v1/models", token=TOKEN)
            models = json.loads(text)["data"] if status == 200 else []
            has_auto = any(m["id"] == "auto" for m in models)
            print(f"  ✓ /v1/models 200  {len(models)} 个模型，含 auto：{has_auto}")
            ok = ok and status == 200 and has_auto

            status, text = http("/v1/chat/completions", method="POST", token=TOKEN, body={
                "model": "auto",
                "messages": [{"role": "user", "content": "NAS 验证"}],
            })
            if status == 200:
                js = json.loads(text)
                print(f"  ✓ 对话成功，来源渠道：{js['x_gateway']['provider_name']}")
            else:
                print(f"  ✗ 对话失败 {status}: {text[:200]}")
                ok = False

            status, text = http(f"/admin/api/overview?token={TOKEN}")
            if status == 200:
                js = json.loads(text)
                print(f"  ✓ 管理接口可访问，累计调用 {js['stats']['totals']['calls']} 次，监听 {js['gateway']['host']}:{js['gateway']['port']}")
            else:
                print(f"  ✗ 管理接口异常 {status}")
                ok = False

            status, _ = http("/")
            print(f"  {'✓' if status == 200 else '✗'} Dashboard 首页 {status}")

            status, _ = http("/admin/api/overview?token=wrong")
            print(f"  {'✓' if status == 401 else '✗'} 错误令牌被拒绝（{status}）")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
        logfile.close()

    print()
    if ok:
        print("  ✓ 结论：这个 fpk 解包后可以直接在飞牛 NAS 上跑起来。\n")
    else:
        print("  ✗ 结论：验证未通过，先修问题再交付。\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
