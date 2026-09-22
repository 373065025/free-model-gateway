"""把「免费模型聚合网关」打包成飞牛 fnOS 可安装的 .fpk。

fpk 结构（与已验证可用的第三方应用保持一致）：

  外层 free-model-gateway<版本>.fpk  (tar.gz)
    ├── manifest                应用元信息
    ├── cmd/*                   启停脚本（权限必须是 755，否则装上起不来）
    ├── config/privilege|resource
    ├── wizard/index.json       安装向导字段
    ├── ui/                     桌面图标入口（必须在内层！）
    ├── ICON.PNG / ICON_256.PNG
    └── app.tgz                 内层包，解到应用目录
          ├── server/           网关本体（零依赖，不需要 npm install）
          ├── ui/config + ui/images
          ├── config/privilege|resource
          └── manifest

用法：
    python tools/build_fpk.py            # 先自动生成图标，再打包
"""

import io
import json
import os
import shutil
import sys
import tarfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FNOS = os.path.join(ROOT, "fnos")
BUILD = os.path.join(ROOT, "build")
STAGING = os.path.join(BUILD, "staging")

FILE_MODE = 0o666
DIR_MODE = 0o777
CMD_FILE_MODE = 0o755
CMD_DIR_MODE = 0o755

TRIVIAL_CMDS = {
    "install_init": "#!/bin/bash\nexit 0\n",
    "uninstall_init": "#!/bin/bash\nexit 0\n",
    "config_init": "#!/bin/bash\nexit 0\n",
    "config_callback": "#!/bin/bash\nexit 0\n",
    "upgrade_init": "#!/bin/bash\nexit 0\n",
}

# 打进包里的网关文件（不含运行时数据与密钥）
SERVER_ITEMS = ["package.json", "src", "config", "public", "scripts", "README.md"]
# 运行时产生的本地文件，绝不打进包（密钥 / 自动发现结果 / 更新源凭据）
SERVER_EXCLUDE = {"keys.json", "models.discovered.json", "update-config.json"}


def log(msg):
    print(f"  {msg}")


def read_manifest():
    data = {}
    with open(os.path.join(FNOS, "manifest"), "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            data[k.strip()] = v.strip()
    return data


def add_tree(tar, fs_path, arcname, file_mode, dir_mode, exclude_names=None, skip_dirs=None):
    """把目录内容加入 tar。arcname 不带 './' 前缀，成员名统一 normalize。"""
    exclude_names = exclude_names or set()
    skip_dirs = skip_dirs or set()
    added = 0
    for root, dirs, files in os.walk(fs_path):
        dirs[:] = sorted(d for d in dirs if d not in skip_dirs)
        rel = os.path.relpath(root, fs_path)
        rel = "" if rel == "." else rel.replace("\\", "/")
        arc_root = arcname if not rel else f"{arcname}/{rel}"

        ti = tarfile.TarInfo(arc_root)
        ti.type = tarfile.DIRTYPE
        ti.mode = dir_mode
        ti.mtime = int(time.time())
        tar.addfile(ti)

        for name in sorted(files):
            if name in exclude_names:
                continue
            full = os.path.join(root, name)
            arc = f"{arc_root}/{name}"
            ti = tarfile.TarInfo(arc)
            ti.size = os.path.getsize(full)
            ti.mode = file_mode
            ti.mtime = int(time.time())
            with open(full, "rb") as fh:
                tar.addfile(ti, fh)
            added += 1
    return added


def add_file(tar, fs_path, arcname, mode):
    ti = tarfile.TarInfo(arcname)
    ti.size = os.path.getsize(fs_path)
    ti.mode = mode
    ti.mtime = int(time.time())
    with open(fs_path, "rb") as fh:
        tar.addfile(ti, fh)


def build_staging():
    if os.path.isdir(STAGING):
        shutil.rmtree(STAGING)
    os.makedirs(STAGING)

    # 1) 网关本体 → staging/server
    server_dst = os.path.join(STAGING, "server")
    os.makedirs(server_dst)
    for item in SERVER_ITEMS:
        src = os.path.join(ROOT, item)
        dst = os.path.join(server_dst, item)
        if not os.path.exists(src):
            continue
        if os.path.isdir(src):
            shutil.copytree(
                src,
                dst,
                ignore=shutil.ignore_patterns(
                    "data", "node_modules", "__pycache__", "*.tmp", "keys.json",
                    "models.discovered.json", "update-config.json", "*.log", ".update",
                ),
            )
        else:
            shutil.copy2(src, dst)

    # 2) manifest + config + ui
    shutil.copy2(os.path.join(FNOS, "manifest"), os.path.join(STAGING, "manifest"))
    shutil.copytree(os.path.join(FNOS, "config"), os.path.join(STAGING, "config"))
    shutil.copytree(os.path.join(FNOS, "ui"), os.path.join(STAGING, "ui"))

    return server_dst


def make_inner_tgz(path):
    with tarfile.open(path, "w:gz", compresslevel=9) as tar:
        add_tree(tar, os.path.join(STAGING, "server"), "server", FILE_MODE, DIR_MODE,
                 exclude_names=SERVER_EXCLUDE, skip_dirs={"data", "node_modules"})
        add_tree(tar, os.path.join(STAGING, "ui"), "ui", FILE_MODE, DIR_MODE)
        add_tree(tar, os.path.join(STAGING, "config"), "config", FILE_MODE, DIR_MODE)
        add_file(tar, os.path.join(STAGING, "manifest"), "manifest", 0o644)


def make_outer_fpk(path, inner_tgz, manifest):
    cmd_dir = os.path.join(BUILD, "cmd")
    if os.path.isdir(cmd_dir):
        shutil.rmtree(cmd_dir)
    shutil.copytree(os.path.join(FNOS, "cmd"), cmd_dir)
    for name, content in TRIVIAL_CMDS.items():
        target = os.path.join(cmd_dir, name)
        if not os.path.exists(target):
            with open(target, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)

    with tarfile.open(path, "w:gz", compresslevel=9) as tar:
        add_file(tar, os.path.join(FNOS, "manifest"), "manifest", 0o644)
        add_file(tar, inner_tgz, "app.tgz", 0o644)
        add_file(tar, os.path.join(FNOS, "ICON.PNG"), "ICON.PNG", 0o644)
        add_file(tar, os.path.join(FNOS, "ICON_256.PNG"), "ICON_256.PNG", 0o644)

        # cmd：目录 755、文件 755（权限位不对，装上起不来）
        ti = tarfile.TarInfo("cmd")
        ti.type = tarfile.DIRTYPE
        ti.mode = CMD_DIR_MODE
        ti.mtime = int(time.time())
        tar.addfile(ti)
        for name in sorted(os.listdir(cmd_dir)):
            full = os.path.join(cmd_dir, name)
            if os.path.isfile(full):
                add_file(tar, full, f"cmd/{name}", CMD_FILE_MODE)

        add_tree(tar, os.path.join(FNOS, "config"), "config", FILE_MODE, CMD_DIR_MODE)
        add_tree(tar, os.path.join(FNOS, "wizard"), "wizard", FILE_MODE, CMD_DIR_MODE)
    return cmd_dir


def verify(fpk_path, inner_names, cmd_dir, manifest):
    problems = []

    required_inner = [
        "server/src/index.js",
        "server/src/upstream.js",
        "server/src/pool.js",
        "server/src/stats.js",
        "server/public/index.html",
        "server/public/app.js",
        "server/public/style.css",
        "server/config/providers.json",
        "server/package.json",
        "ui/config",
        "ui/images/icon-64.png",
        "ui/images/icon-256.png",
        "config/privilege",
        "manifest",
    ]
    for name in required_inner:
        if name not in inner_names:
            problems.append(f"内层缺少：{name}")

    for name in inner_names:
        if name.startswith("./"):
            problems.append(f"内层成员名带 './' 前缀：{name}")
            break
        if "keys.json" in name or "usage.json" in name:
            problems.append(f"内层混入了本地运行时文件：{name}")
            break

    with tarfile.open(fpk_path, "r:gz") as tar:
        outer = tar.getnames()
        for need in ["manifest", "app.tgz", "ICON.PNG", "ICON_256.PNG", "cmd/main", "wizard/index.json"]:
            if need not in outer:
                problems.append(f"外层缺少：{need}")
        for name in outer:
            if name.startswith("cmd/"):
                mode = tar.getmember(name).mode
                if mode != CMD_FILE_MODE:
                    problems.append(f"{name} 权限位是 {oct(mode)}，应为 755")

    # 端口四处一致
    ui_config = json.load(open(os.path.join(FNOS, "ui", "config"), encoding="utf-8"))
    ui_port = ui_config[".url"][manifest["desktop_applaunchname"]]["port"]
    wizard_port = json.load(open(os.path.join(FNOS, "wizard", "index.json"), encoding="utf-8"))[0]["default"]
    main_txt = open(os.path.join(cmd_dir, "main"), encoding="utf-8").read()
    ports = {
        "manifest.service_port": manifest["service_port"],
        "ui/config": ui_port,
        "wizard/index.json": wizard_port,
    }
    if len(set(ports.values())) != 1:
        problems.append(f"端口不一致：{ports}")
    if f'${{APP_PORT:-{manifest["service_port"]}}}' not in main_txt:
        problems.append("cmd/main 里的默认端口与 manifest.service_port 不一致")

    return problems


def main():
    print("\n=== 打包飞牛 fnOS 应用 ===\n")

    icons = os.path.join(FNOS, "ui", "images", "icon-64.png")
    if not os.path.exists(icons):
        log("图标缺失，先生成…")
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import make_icons
        make_icons.main()

    manifest = read_manifest()
    version = manifest["version"]

    log("准备 staging …")
    server_dst = build_staging()
    files = sum(len(f) for _, _, f in os.walk(server_dst))
    log(f"server 文件数：{files}")

    os.makedirs(BUILD, exist_ok=True)
    inner = os.path.join(BUILD, "app.tgz")
    log("生成内层 app.tgz …")
    make_inner_tgz(inner)

    out_name = f"free-model-gateway{version}.fpk"
    out_path = os.path.join(ROOT, out_name)
    log("生成外层 fpk …")
    cmd_dir = make_outer_fpk(out_path, inner, manifest)

    with tarfile.open(inner, "r:gz") as it:
        inner_names = it.getnames()

    problems = verify(out_path, inner_names, cmd_dir, manifest)
    size = os.path.getsize(out_path)

    print()
    if problems:
        print("  ✗ 校验未通过：")
        for p in problems:
            print(f"      - {p}")
        sys.exit(1)

    print(f"  ✓ 内层条目 {len(inner_names)} 个，外层校验通过，权限位正确")
    print(f"  ✓ 端口 {manifest['service_port']} 在 4 处一致")
    print(f"  ✓ 产物：{out_path}  ({size / 1024:.1f} KB)\n")


if __name__ == "__main__":
    main()
