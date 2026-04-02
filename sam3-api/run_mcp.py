from __future__ import annotations

import argparse

import uvicorn

from mcp_server import create_streamable_http_app, load_mcp_config, build_mcp_server


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the sam3-api MCP adapter")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http"],
        default="stdio",
        help="MCP transport. Use stdio for LiteLLM local command mode, http for Streamable HTTP.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="HTTP host for --transport http")
    parser.add_argument("--port", type=int, default=8011, help="HTTP port for --transport http")
    parser.add_argument(
        "--mount-path",
        default=None,
        help="Streamable HTTP mount path. Defaults to SAM3_MCP_HTTP_MOUNT_PATH or /mcp.",
    )
    parser.add_argument("--log-level", default="info", help="Uvicorn log level for --transport http")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    cfg = load_mcp_config()
    if args.mount_path:
        cfg = cfg.__class__(
            api_base_url=cfg.api_base_url,
            timeout_sec=cfg.timeout_sec,
            http_mount_path=args.mount_path if str(args.mount_path).startswith("/") else f"/{args.mount_path}",
        )

    if args.transport == "stdio":
        print(f"sam3-api MCP (stdio) -> {cfg.api_base_url}")
        build_mcp_server(cfg).run()
        return

    print(f"sam3-api MCP (streamable-http) -> {cfg.api_base_url}")
    print(f"Mount: http://{args.host}:{args.port}{cfg.http_mount_path}")
    uvicorn.run(
        create_streamable_http_app(cfg),
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )


if __name__ == "__main__":
    main()
