# bds-termux-mcp

Ek self-contained MCP server jo **phone pe hi** chalta hai (Termux), taki Better DeepSeek
apne DeepSeek login ke saath device pe kaam kar sake — files padhna, script chalana,
clipboard/notification use karna. Koi API key nahi, koi third-party server nahi, traffic
loopback se bahar nahi jaata.

## Kyun chahiye

Better DeepSeek Android ek WebView shell hai: DeepSeek ka apna account, koi token cost
nahi. Par uske paas "haath" nahi the. BDS pehle se MCP servers se baat kar sakta hai
(tool schemas system prompt me inject hote hain, model `<BDS:AUTO:MCP url="..." tool="...">`
se call karta hai) — bas Android build me MCP transport missing tha (background service
worker build hi nahi hota). Repo ke patched build me woh `bds-mcp-http` native transport se
chalta hai, aur ye file us transport ke doosri taraf ka server hai.

## Install (Termux)

```bash
# F-Droid / GitHub se Termux (Play Store wala purana hai)
pkg update && pkg upgrade -y
pkg install python termux-api -y
termux-setup-storage          # /sdcard access ke liye ek baar

# Termux:API app bhi install karo (F-Droid), warna termux_api tool error dega
```

## Chalana

```bash
python bds_termux_mcp.py --port 8765 --root /sdcard/Documents --allow-shell
```

Output:

```
[mcp] bds-termux-mcp 1.0.0 listening on http://127.0.0.1:8765/mcp
[mcp] roots: /storage/emulated/0/Documents
[mcp] shell: enabled | termux-api: enabled
```

Verify (dusre Termux session me):

```bash
curl -s 127.0.0.1:8765/health
# {"ok": true, "server": "bds-termux-mcp", ..., "tools": ["fs_list", ...]}
```

Phone ko jagte rakho jab agent kaam kar raha ho:

```bash
termux-wake-lock
```

## Better DeepSeek me add karna

**Settings (BDS drawer) → MCP Servers → Add**

| Field | Value |
|---|---|
| Name | `Phone` (ya jo chahiye) |
| Server URL | `http://127.0.0.1:8765/mcp` |
| API Key | khaali chhod do |

**Test** dabao → `fs_list`, `fs_read`, `fs_write`, `fs_search`, `shell_run`, `termux_api`
dikhne chahiye. Enable toggle on rakho.

## Tools

| Tool | Kya karta hai | Args |
|---|---|---|
| `fs_list` | directory listing (recursive 1–4 levels) | `path`, `depth` |
| `fs_read` | text file padhna, 200 KB cap | `path`, `max_bytes` |
| `fs_write` | file banana/overwrite | `path`, `content` |
| `fs_search` | case-insensitive text search | `path`, `query` |
| `shell_run` | Termux shell command, 30 s (max 120 s) timeout | `command`, `cwd`, `timeout` |
| `termux_api` | `termux-<name>` wrapper: `clipboard-get`, `clipboard-set`, `notification`, `torch`, `battery-status`, `toast`, `vibrate`, ... | `command`, `args[]` |

`shell_run` sirf `--allow-shell` ke saath milta hai. `--no-termux-api` se API wrapper hide
kar sakte ho.

## Options

```
--host 127.0.0.1        # default loopback hi rakho
--port 8765
--root DIR              # repeatable; default: $HOME + /storage/emulated/0/Documents
--allow-shell           # shell_run enable
--no-termux-api         # termux_api hide
```

## Safety model (kyun ye relative safe hai)

- **Sandbox**: har path realpath karke check hota hai, sirf `--root` ke andar. `../../etc/passwd`
  jaise attempts `isError: true` ke saath reject.
- **Read caps**: 200 KB per read, 20 KB shell output — ek careless call poora context flood nahi karta.
- **Shell opt-in**: default off. On karne pe bhi timeout aur output truncation lagu.
- **Loopback only**: server 127.0.0.1 pe bind hota hai; BDS ka patched transport bhi sirf
  loopback ko plain HTTP deta hai, LAN ko nahi.
- **Visibility**: har tool call chat me dikhta hai (`<BDS:AUTO:MCP ...>`), to tumhe pata rehta hai
  kya chalaya gaya.

## Autostart (optional)

Termux:Boot app install karo, phir `~/.termux/boot/start-mcp.sh`:

```bash
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
python $HOME/bds_termux_mcp.py --port 8765 --root /sdcard/Documents --allow-shell >> $HOME/mcp.log 2>&1 &
```

`chmod +x` karna na bhoolo.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Unsupported bridge message type: bds-mcp-list-tools` | Purana APK hai — patched build install karo |
| `CLEARTEXT communication not permitted` | `network_security_config.xml` manifest me add nahi hua |
| `termux-clipboard-get not found` | Termux:API app + `pkg install termux-api` |
| Test pe tools nahi dikhe | `curl 127.0.0.1:8765/health` chalao; Termux session zinda hai? |
| File "outside allowed roots" | `--root` me woh folder add karo |
