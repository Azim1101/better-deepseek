#!/usr/bin/env python3
"""
bds_termux_mcp.py — a self-contained MCP server that runs *on the phone* (Termux).

Why this exists
---------------
Better DeepSeek on Android is a WebView shell around chat.deepseek.com: you are
logged in with your own DeepSeek account, so there is no API key and no token
cost. What it lacks on Android is the ability to touch the device — you cannot
read a folder, run a script, or put something on the clipboard.

MCP (Model Context Protocol) is the bridge. BDS already knows how to talk to MCP
servers (tool schemas are injected into the system prompt, and the model calls
them with <BDS:AUTO:MCP ...>). This file is the server side: it exposes a small,
deliberately boring set of filesystem / shell / Termux-API tools over the MCP
Streamable-HTTP transport, so DeepSeek-in-your-browser-login can act on this
phone like an agent.

Nothing here talks to the network outbound. It binds to loopback only.

Run
---
    pkg install python termux-api
    termux-setup-storage
    python bds_termux_mcp.py --root /sdcard/Documents --allow-shell

Then in Better DeepSeek: Settings -> MCP Servers -> add
    http://127.0.0.1:8765/mcp

Safety model
------------
* Every path is resolved and must land inside one of the --root directories.
  `/sdcard` is rewritten to /storage/emulated/0 so paths typed by a model still
  work after the storage symlink disappears on newer Android.
* Reads are capped (default 200 kB) so one careless tool call cannot flood the
  conversation with a 40 MB log file.
* Shell execution is OFF unless --allow-shell is passed, and even then it runs
  with a timeout and returns truncated output. Tool calls from BDS are visible
  in the conversation, so you can see exactly what was run.
* Termux:API wrappers only run binaries that actually exist; a missing
  termux-api package degrades to a clear error instead of a stack trace.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterable, List, Optional

SERVER_NAME = "bds-termux-mcp"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"

MAX_READ_BYTES = 200_000
MAX_SHELL_OUTPUT = 20_000
SHELL_TIMEOUT_S = 30

# Filled in by main().
ALLOWED_ROOTS: List[str] = []
ALLOW_SHELL = False
ALLOW_TERMUX_API = True

# ──────────────────────────────────────────────────────────────────────────────
# Path handling
# ──────────────────────────────────────────────────────────────────────────────


def normalize_user_path(raw: str) -> str:
    """Turn a model-supplied path into an absolute one we can reason about."""
    text = str(raw or "").strip()
    if not text:
        text = "/sdcard"
    text = os.path.expanduser(text)
    # Newer Android: /sdcard is not a real path, /storage/emulated/0 is.
    if text == "/sdcard" or text.startswith("/sdcard/"):
        text = "/storage/emulated/0" + text[len("/sdcard"):]
    if text in ("~", "$HOME"):
        text = os.path.expanduser("~")
    if not os.path.isabs(text):
        text = os.path.join(ALLOWED_ROOTS[0] if ALLOWED_ROOTS else os.getcwd(), text)
    return os.path.normpath(text)


def resolve_inside_root(raw: str) -> str:
    """Resolve + sandbox a path. Raises ValueError when it escapes every root."""
    path = normalize_user_path(raw)
    real = os.path.realpath(path)
    for root in ALLOWED_ROOTS:
        root_real = os.path.realpath(root)
        if real == root_real or real.startswith(root_real + os.sep):
            return real
    raise ValueError(
        "Path is outside the allowed roots. Allowed: " + ", ".join(ALLOWED_ROOTS)
    )


def rel_to_root(path: str) -> str:
    for root in ALLOWED_ROOTS:
        root_real = os.path.realpath(root)
        if path == root_real or path.startswith(root_real + os.sep):
            rel = os.path.relpath(path, root_real)
            return root_real if rel == "." else os.path.join(root_real, rel)
    return path


# ──────────────────────────────────────────────────────────────────────────────
# Tools
# ──────────────────────────────────────────────────────────────────────────────


def tool_fs_list(args: Dict[str, Any]) -> str:
    path = resolve_inside_root(args.get("path", ""))
    depth = int(args.get("depth", 1) or 1)
    depth = max(1, min(depth, 4))
    if not os.path.isdir(path):
        raise ValueError(f"Not a directory: {path}")

    lines: List[str] = []
    base_depth = path.rstrip(os.sep).count(os.sep)
    for current, dirnames, filenames in os.walk(path):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))[:200]
        level = current.rstrip(os.sep).count(os.sep) - base_depth
        if level >= depth:
            dirnames[:] = []
        indent = "  " * level
        lines.append(f"{indent}{os.path.basename(current) or current}/")
        for name in sorted(filenames)[:200]:
            try:
                size = os.path.getsize(os.path.join(current, name))
            except OSError:
                size = 0
            lines.append(f"{indent}  {name}  ({human_size(size)})")
        if len(lines) > 600:
            lines.append("... (truncated)")
            break
    return "\n".join(lines) or "(empty directory)"


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n:.1f}GB"


def tool_fs_read(args: Dict[str, Any]) -> str:
    path = resolve_inside_root(args.get("path", ""))
    if not os.path.isfile(path):
        raise ValueError(f"Not a file: {path}")
    limit = int(args.get("max_bytes", MAX_READ_BYTES) or MAX_READ_BYTES)
    limit = max(1, min(limit, MAX_READ_BYTES))
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        data = handle.read(limit)
    text = data.decode("utf-8", errors="replace")
    if size > limit:
        text += f"\n\n... (truncated at {limit} of {size} bytes)"
    return text


def tool_fs_write(args: Dict[str, Any]) -> str:
    path = resolve_inside_root(args.get("path", ""))
    content = str(args.get("content", ""))
    if os.path.isdir(path):
        raise ValueError(f"Path is a directory: {path}")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)
    return f"Wrote {len(content)} characters to {path}"


def tool_fs_search(args: Dict[str, Any]) -> str:
    path = resolve_inside_root(args.get("path", ""))
    needle = str(args.get("query", "")).strip()
    if not needle:
        raise ValueError("query is required")
    pattern = re.compile(re.escape(needle), re.IGNORECASE)
    hits: List[str] = []
    for current, dirnames, filenames in os.walk(path):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            full = os.path.join(current, name)
            try:
                if os.path.getsize(full) > 2_000_000:
                    continue
                with open(full, "r", encoding="utf-8", errors="ignore") as handle:
                    for number, line in enumerate(handle, 1):
                        if pattern.search(line):
                            hits.append(f"{full}:{number}: {line.strip()[:200]}")
                            if len(hits) >= 80:
                                return "\n".join(hits) + "\n... (truncated)"
            except (OSError, UnicodeError):
                continue
    return "\n".join(hits) or "No matches."


def tool_shell_run(args: Dict[str, Any]) -> str:
    if not ALLOW_SHELL:
        raise ValueError(
            "Shell execution is disabled. Restart the server with --allow-shell to enable it."
        )
    command = str(args.get("command", "")).strip()
    if not command:
        raise ValueError("command is required")
    cwd = resolve_inside_root(args.get("cwd", "")) if args.get("cwd") else ALLOWED_ROOTS[0]
    if not os.path.isdir(cwd):
        cwd = ALLOWED_ROOTS[0]
    timeout = int(args.get("timeout", SHELL_TIMEOUT_S) or SHELL_TIMEOUT_S)
    timeout = max(1, min(timeout, 120))
    try:
        completed = subprocess.run(
            ["sh", "-c", command],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise ValueError(f"Command timed out after {timeout}s")
    output = (completed.stdout or "") + (completed.stderr or "")
    if len(output) > MAX_SHELL_OUTPUT:
        output = output[:MAX_SHELL_OUTPUT] + "\n... (truncated)"
    return f"exit={completed.returncode}\ncwd={cwd}\n\n{output.strip() or '(no output)'}"


def tool_termux_api(args: Dict[str, Any]) -> str:
    if not ALLOW_TERMUX_API:
        raise ValueError("Termux:API wrappers are disabled on this server instance.")
    command = str(args.get("command", "")).strip()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,32}", command):
        raise ValueError("command must be a termux-api name such as clipboard-get")
    binary = shutil.which(f"termux-{command}")
    if not binary:
        raise ValueError(
            f"termux-{command} not found. Install the Termux:API app and run: pkg install termux-api"
        )
    extra = args.get("args")
    argv = [binary]
    if isinstance(extra, list):
        argv.extend(str(item) for item in extra)
    elif isinstance(extra, str) and extra.strip():
        argv.extend(extra.split())
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        raise ValueError("Termux API call timed out")
    output = (completed.stdout or "") + (completed.stderr or "")
    return output.strip() or f"(termux-{command} returned nothing)"


TOOLS: List[Dict[str, Any]] = [
    {
        "name": "fs_list",
        "description": "List a directory on this Android device (recursive up to `depth`).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path, e.g. /sdcard/Documents"},
                "depth": {"type": "integer", "description": "1-4, default 1"},
            },
            "required": ["path"],
        },
        "handler": tool_fs_list,
    },
    {
        "name": "fs_read",
        "description": "Read a text file from this device. Output is capped at 200000 bytes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "max_bytes": {"type": "integer", "description": "default 200000"},
            },
            "required": ["path"],
        },
        "handler": tool_fs_read,
    },
    {
        "name": "fs_write",
        "description": "Create or overwrite a text file on this device.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
        "handler": tool_fs_write,
    },
    {
        "name": "fs_search",
        "description": "Case-insensitive text search across files under a directory.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "query": {"type": "string"}},
            "required": ["path", "query"],
        },
        "handler": tool_fs_search,
    },
    {
        "name": "shell_run",
        "description": "Run a shell command on the device (Termux environment). Enable with --allow-shell.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "cwd": {"type": "string"},
                "timeout": {"type": "integer", "description": "seconds, max 120"},
            },
            "required": ["command"],
        },
        "handler": tool_shell_run,
    },
    {
        "name": "termux_api",
        "description": (
            "Call a Termux:API command, e.g. clipboard-get, clipboard-set, notification, "
            "torch, battery-status, toast, vibrate, camera-info."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "name without the termux- prefix"},
                "args": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "arguments passed to the command",
                },
            },
            "required": ["command"],
        },
        "handler": tool_termux_api,
    },
]

TOOL_INDEX = {tool["name"]: tool for tool in TOOLS}


def public_tools() -> List[Dict[str, Any]]:
    return [
        {k: v for k, v in tool.items() if k != "handler"}
        for tool in TOOLS
        if tool["name"] != "shell_run" or ALLOW_SHELL
    ]


# ──────────────────────────────────────────────────────────────────────────────
# JSON-RPC dispatch
# ──────────────────────────────────────────────────────────────────────────────


def rpc_result(request_id: Any, result: Any) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def rpc_error(request_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle_rpc(message: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        return rpc_result(
            request_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        )

    if method in ("notifications/initialized", "initialized"):
        return None

    if method == "ping":
        return rpc_result(request_id, {})

    if method == "tools/list":
        return rpc_result(request_id, {"tools": public_tools()})

    if method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        tool = TOOL_INDEX.get(str(name))
        if tool is None:
            return rpc_error(request_id, -32602, f"Unknown tool: {name}")
        if tool["name"] == "shell_run" and not ALLOW_SHELL:
            return rpc_error(request_id, -32602, "shell_run is disabled (start the server with --allow-shell)")
        try:
            text = tool["handler"](arguments if isinstance(arguments, dict) else {})
            return rpc_result(
                request_id,
                {"content": [{"type": "text", "text": str(text)}], "isError": False},
            )
        except ValueError as error:
            return rpc_result(
                request_id,
                {"content": [{"type": "text", "text": str(error)}], "isError": True},
            )
        except Exception as error:  # noqa: BLE001 - never leak a traceback to the model
            return rpc_result(
                request_id,
                {
                    "content": [
                        {"type": "text", "text": f"{type(error).__name__}: {error}"}
                    ],
                    "isError": True,
                },
            )

    if request_id is None:
        return None
    return rpc_error(request_id, -32601, f"Method not found: {method}")


class Handler(BaseHTTPRequestHandler):
    server_version = f"{SERVER_NAME}/{SERVER_VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *fmt_args: Any) -> None:  # keep the console readable
        sys.stderr.write("[mcp] " + (fmt % fmt_args) + "\n")

    def _send_json(self, code: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.split("?")[0] in ("/health", "/"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "server": SERVER_NAME,
                    "version": SERVER_VERSION,
                    "roots": ALLOWED_ROOTS,
                    "shell": ALLOW_SHELL,
                    "tools": [tool["name"] for tool in public_tools()],
                },
            )
            return
        self._send_json(405, {"error": "Use POST for MCP JSON-RPC"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""
        try:
            message = json.loads(raw.decode("utf-8")) if raw else {}
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            self._send_json(400, rpc_error(None, -32700, f"Parse error: {error}"))
            return

        if isinstance(message, list):  # batch
            responses = [r for r in (handle_rpc(item) for item in message) if r is not None]
            if not responses:
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._send_json(200, responses)
            return

        response = handle_rpc(message if isinstance(message, dict) else {})
        if response is None:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send_json(200, response)


def parse_args(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MCP server for Better DeepSeek on Android (Termux)")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default loopback only)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--root",
        action="append",
        default=None,
        help="allowed directory; repeatable (default: $HOME and /storage/emulated/0/Documents)",
    )
    parser.add_argument("--allow-shell", action="store_true", help="enable the shell_run tool")
    parser.add_argument("--no-termux-api", action="store_true", help="hide the termux_api tool")
    return parser.parse_args(list(argv) if argv is not None else None)


def main(argv: Optional[Iterable[str]] = None) -> int:
    global ALLOWED_ROOTS, ALLOW_SHELL, ALLOW_TERMUX_API
    args = parse_args(argv)

    roots = args.root or [
        os.path.expanduser("~"),
        "/storage/emulated/0/Documents",
    ]
    ALLOWED_ROOTS = [os.path.realpath(os.path.expanduser(str(r))) for r in roots]
    ALLOW_SHELL = bool(args.allow_shell)
    ALLOW_TERMUX_API = not args.no_termux_api

    print(f"[mcp] {SERVER_NAME} {SERVER_VERSION} listening on http://{args.host}:{args.port}/mcp")
    print(f"[mcp] roots: {', '.join(ALLOWED_ROOTS)}")
    print(f"[mcp] shell: {'enabled' if ALLOW_SHELL else 'disabled'} | termux-api: {'enabled' if ALLOW_TERMUX_API else 'disabled'}")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[mcp] shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
