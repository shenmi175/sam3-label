from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from model_registry.registry import MODELS, get_model
from model_registry.status import load_env_file, repo_root, resolve_host_dir, status


def _human(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if num < 1024 or unit == "TB":
            return f"{num:.1f}{unit}"
        num /= 1024
    return f"{num:.1f}TB"


def _cmd_list(args: argparse.Namespace) -> int:
    env_file = load_env_file()
    width = max(len(m.id) for m in MODELS)
    print(f"{'ID':<{width}}  {'SERVICE':<20}  {'PORT':<5}  STATE       HOST DIR")
    for spec in MODELS:
        st = status(spec, env_file=env_file)
        print(
            f"{spec.id:<{width}}  {spec.api_service:<20}  "
            f"{spec.api_port:<5}  {st.state:<11} {st.host_dir}"
        )
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    env_file = load_env_file()
    specs = [get_model(args.model_id)] if args.model_id else list(MODELS)
    for spec in specs:
        st = status(spec, env_file=env_file)
        print(f"== {spec.id} ({spec.display_name}) ==")
        print(f"   service : {spec.api_service} (port {spec.api_port})")
        print(f"   host dir: {st.host_dir} ({'exists' if st.host_dir_exists else 'absent'})")
        print(f"   state   : {st.state}")
        for f in st.files:
            tag = "optional" if f.optional else "required"
            if f.exists:
                print(f"     [ok]   {f.rel_path:<40} {_human(f.size_bytes)} ({tag})")
            else:
                print(f"     [miss] {f.rel_path:<40} - ({tag})")
        if st.state != "ready":
            print(f"   hint    : {spec.download.instructions}")
        print()
    return 0


def _download_hf(spec, target: Path, mirror: bool) -> int:
    if mirror:
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
    target.mkdir(parents=True, exist_ok=True)

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        snapshot_download = None

    if snapshot_download is not None:
        print(f"Downloading {spec.download.hf_repo_id} -> {target}")
        kwargs = {"local_dir": str(target), "local_dir_use_symlinks": False}
        endpoint = os.environ.get("HF_ENDPOINT", "")
        if endpoint:
            kwargs["endpoint"] = endpoint
        try:
            snapshot_download(spec.download.hf_repo_id, **kwargs)
            print(f"Download complete: {target}")
            return 0
        except Exception as exc:
            print(f"Download failed: {exc}", file=sys.stderr)
            if "401" in str(exc) or "gated" in str(exc).lower():
                print("This model may require `huggingface-cli login` first.", file=sys.stderr)
            return 1

    cli = shutil.which("huggingface-cli")
    if cli:
        print(f"Downloading {spec.download.hf_repo_id} -> {target} (huggingface-cli)")
        return subprocess.call(
            [cli, "download", spec.download.hf_repo_id, "--local-dir", str(target),
             "--local-dir-use-symlinks", "False"]
        )

    print("Neither huggingface_hub nor huggingface-cli is available.", file=sys.stderr)
    print("Install with: pip install -U 'huggingface_hub[cli]'", file=sys.stderr)
    return 1


def _cmd_download(args: argparse.Namespace) -> int:
    spec = get_model(args.model_id)
    env_file = load_env_file()
    host_dir = resolve_host_dir(spec, env_file=env_file)

    if spec.download.kind != "hf":
        print(f"Model {spec.id} requires manual acquisition:", file=sys.stderr)
        print(spec.download.instructions, file=sys.stderr)
        print(f"Target directory: {host_dir}", file=sys.stderr)
        return 2

    subdir = spec.download.subdir or spec.download.hf_repo_id.split("/")[-1]
    target = host_dir / subdir
    return _download_hf(spec, target, args.mirror)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="model_registry",
        description="Unified model management for the sam3-auto-label platform.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List all models and their state")
    p_list.set_defaults(func=_cmd_list)

    p_status = sub.add_parser("status", help="Show weight status for one or all models")
    p_status.add_argument("model_id", nargs="?", help="Model id (omit for all)")
    p_status.set_defaults(func=_cmd_status)

    p_dl = sub.add_parser("download", help="Download weights for an HF model")
    p_dl.add_argument("model_id", help="Model id")
    p_dl.add_argument("--mirror", action="store_true", help="Use hf-mirror.com")
    p_dl.set_defaults(func=_cmd_download)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
