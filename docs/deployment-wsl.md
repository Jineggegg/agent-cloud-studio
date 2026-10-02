# 在 WSL 中部署 Agent Cloud Studio（iPad / MacBook 远程使用）

```
iPad / MacBook（Safari，可添加到主屏幕）
   │  Tailscale（仅 tailnet 内可访问）
   ▼
Windows: tailscale serve  https://<机器名>.<tailnet>.ts.net:8443  →  127.0.0.1:3002
   │  WSL 镜像网络：WSL 与 Windows 共用 127.0.0.1
   ▼
WSL: agent-cloud-studio.service（127.0.0.1:3002）
   ├─ Claude Code / Codex / Cursor / OpenCode CLI（你的订阅登录），在各项目目录内运行
   ├─ SNR 实验室网关 → Windows 127.0.0.1:8768（固定回环目标）
   └─ Trading 212 只读 API（密钥从指定的 .env 文件读取）
```

## 1. 开启 WSL 镜像网络（在 Windows 上，由你执行）

在 `%UserProfile%\.wslconfig` 中加入：

```ini
[wsl2]
networkingMode=mirrored
```

然后在 PowerShell 中执行 `wsl --shutdown`。这一步会停止**所有** WSL 进程，包括现有的 CloudCLI 和正在运行的 AI 会话，请在空闲时进行。

验证：在 WSL 中执行 `curl http://127.0.0.1:8768/api/health`，应返回 SNR 健康信息。

## 2. 停止 Windows 上的 Studio 预览

现在 `:8443` 指向 Windows 上 `Documents\GitHub\agent-cloud-studio` 跑的 3002 端口。开启镜像网络后，3002 端口由两边共用，请先停止 Windows 端的 `scripts/studio-start.ps1`（或对应的计划任务）。

## 3. 配置并安装服务（在 WSL 中）

```bash
cd ~/projects/agent-cloud-studio
cp .env.example .env   # 如已存在则直接编辑
```

至少填写：

- `STUDIO_PUBLIC_ORIGIN=https://<机器名>.<tailnet>.ts.net:8443`
- `STUDIO_T212_ENV_FILE`、`STUDIO_T212_DEMO_ENV_FILE`：指向包含 `TRADING212_API_KEY` / `TRADING212_API_SECRET` 的文件。
- 需要时填写 `STUDIO_SNR_PATH` 等项目目录。目录必须在 WSL 用户主目录下，才能在里面启动 Claude / Codex。

然后：

```bash
bash scripts/wsl/install-studio-service.sh
```

脚本会构建项目，并安装一个 systemd 用户服务 `agent-cloud-studio.service`，只监听 `127.0.0.1:3002`。它不会修改 Tailscale、Windows 网络，也不会停用现有的 CloudCLI。

## 4. 在 iPad 上使用

1. 用 Safari 打开 `https://<机器名>.<tailnet>.ts.net:8443`。
2. 点「分享」→「添加到主屏幕」，之后它会像一个独立 App 一样全屏运行。

## 5. 以后替换现有的 CloudCLI（可选）

确认 Studio 完全可用后：

1. `tailscale serve --bg --https=443 http://127.0.0.1:3002`
2. `systemctl --user disable --now ipad-workbench.service`

开发工具（`/workspace`）里的 Claude / Codex 会话就是原来 CloudCLI 的功能，替换后不会丢失。

## 6. 首页的模型额度小组件（可选）

主屏幕的额度小组件显示 Claude、Codex 的 5 小时 / 每周用量和 DeepSeek 余额，每分钟最多刷新一次。数据来源不同，可信度也不同，小组件会标出来源和「可能已过期」：

- **Codex**：自动读取。优先用 Codex 官方接口（`codex app-server` 的 `account/rateLimits/read`，需要 Codex 已登录 ChatGPT 账号）；失败时退回到最近几个 Codex 会话日志（默认 `~/.codex/sessions`，可用 `STUDIO_CODEX_SESSIONS_DIRS` 指定多个目录，用 `:` 分隔）。日志只在你使用 Codex 时更新，超过 15 分钟会标为过期。
- **DeepSeek**：用你在「连接」中保存的密钥查询官方余额接口，不需要额外配置。
- **Claude**：Claude 没有公开的额度查询接口，Studio 读取一个快照文件 `~/.claude/studio-rate-limits.json`（可用 `STUDIO_CLAUDE_RATE_FILE` 改位置），里面只有用量百分比和重置时间，没有任何密钥。快照有两个来源：
  1. 在 Studio 里进行的 Claude 对话会自动更新它。
  2. 在终端直接用 Claude Code 时，需要把状态栏（statusLine）指向仓库里的脚本。请你自己编辑 `~/.claude/settings.json`，加入：

     ```json
     "statusLine": {
       "type": "command",
       "command": "node /home/laosong/projects/agent-cloud-studio/scripts/claude-statusline-snapshot.mjs"
     }
     ```

     如果已经配置过其他 statusLine，这会替换它。之后 Claude Code 底部会显示类似 `Opus · 5h 42% · 周 18%` 的一行，同时写入快照。脚本出错时只会显示模型名，不会影响 Claude Code。

  只有 Claude 订阅账号（Pro / Max）才有 5 小时 / 每周限额；用 API 密钥登录时小组件会显示「暂无数据」。快照超过 6 小时未更新，或者重置时间已过，会标为过期。

`STUDIO_CLAUDE_RATE_FILE` 和 `STUDIO_CODEX_SESSIONS_DIRS` 里的 `~` 会展开成你的主目录，相对路径也按主目录解析（不按当前目录），所以在 systemd 的 `Environment=` 里写 `~/.claude/x.json` 也能用；服务和 statusLine 脚本会落到同一个文件。修改后需要重启服务才会生效。

## 7. SNR 实验室（可选）

Studio 通过同源网关 `/api/studio/snr-site/*` 内嵌 SNR，目标固定为 `STUDIO_SNR_BASE_URL`（默认 `http://127.0.0.1:8768`，只接受回环地址）。网关另外只读放行 `GET /api/integration/v1/manifest` 和 `/api/integration/v1/sessions/<uuid>/context`，Studio 的 SNR 状态会显示 manifest 里截短、过滤后的名称、版本和能力列表。

### 在 WSL 里从克隆运行 SNR

```bash
cd ~/projects/snr3-lab
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8768
```

- SNR 的 README 要求 Python 3.12。实测 WSL 自带的 Python 3.14.4 也能装好 `requirements.lock.txt`（`pip check` 无冲突），服务正常启动，非浏览器测试只有 1 个失败（一条数据库表数量断言，看起来与 Python 版本无关）。如果遇到问题，再换用 3.12 的 venv。
- 只监听 `127.0.0.1`。Windows 上的 SNR 和 WSL 里的 SNR 不要同时占用 8768（镜像网络下两边共用端口）。两份 `data/lab.sqlite3` 互不相通。
- 浏览器测试才需要 `playwright install`，日常运行不需要。语音听写还需要 SNR 的本地语音模型；在 Studio 里用麦克风需要 HTTPS（Tailscale 地址满足）。

### SNR 开启认证时

SNR 设置了 `SNR_LAB_USER` / `SNR_LAB_PASSWORD` 时，在 Studio 的 `.env` 中加入：

```ini
STUDIO_SNR_USER=<与 SNR_LAB_USER 相同>
STUDIO_SNR_PASSWORD_FILE=/home/<用户名>/.config/agent-cloud-studio/snr-password
```

密码文件里只放密码一行，并执行 `chmod 600`。Studio 每次请求 SNR 时都重新读取这个文件，所以改密码后不用重启。凭据只放在服务器端发给 SNR 的网关和状态请求的 `Authorization: Basic` 头里，不写日志，也不发给浏览器。两个变量缺一个就按不认证处理；文件读不到时，状态会显示「SNR 认证配置不可用」。

## 8. 用自己的 Tailscale 身份免密码登录（可选）

通过 Tailscale Serve 打开 Studio 时，Serve 会告诉后端「这个请求来自哪个 Tailscale 账号」。
把你自己的账号加入白名单后，iPad 打开 Studio 就会直接进入，不再显示登录页；
tailnet 里其他人（包括共享给你的设备）仍然需要密码。

**先弄清信任范围。** Serve 告诉后端的是 Tailscale **账号**，不是具体设备，更不是具体程序。
页面「同源」检查依赖 `Origin` / `Sec-Fetch-Site` 请求头，只能挡住别的网页，挡不住会自己填写请求头的程序。
开启后，下列任何一方都能不输密码拿到完整的 Studio 会话（能打开 Claude / Codex 和终端，等于能在这台电脑上执行代码）：

- 登录了白名单账号、没有打 tag 的**每一台设备**上的**每一个程序**，不只是浏览器。
  例如 iPhone / iPad 开着 Tailscale 时的任何第三方 App，或者你另一台电脑上的任何进程。
- 设置 `STUDIO_TAILSCALE_NODES` 后，范围缩小到列出的设备；但这些设备上的每一个程序仍然受信任。
- 本机上的任何程序：它们可以直接访问 `127.0.0.1:3002` 并伪造全部请求头。

所以强烈建议用 `STUDIO_TAILSCALE_NODES` 只列出你的 iPad。

1. 查出你的 Tailscale 登录名（在 Windows PowerShell 中）：

   ```powershell
   $s = tailscale status --json | ConvertFrom-Json
   $s.User."$($s.Self.UserID)".LoginName
   ```

   这是本机所登录账号的登录名，例如 `you@gmail.com` 或 `name@github`。如果 iPad 登录的是另一个账号，
   用 `tailscale whois <iPad 的 100.x 地址>` 查看 iPad 那一端的登录名。
2. 查出 iPad 的两个 Tailscale 地址：在 PowerShell 中运行 `tailscale ip <iPad 的设备名>`，
   或者在 iPad 的 Tailscale App 里点开本机查看。会有一个 `100.x.y.z` 和一个 `fd7a:115c:a1e0:…`；
   两个都要写，因为 iPad 可能用其中任意一个连接。
3. 在 WSL 的 `.env` 中设置：

   ```ini
   STUDIO_TAILSCALE_LOGINS=you@gmail.com
   # 只允许这些设备免密码登录（逗号分隔）；留空表示该账号下所有未打 tag 的设备
   STUDIO_TAILSCALE_NODES=100.x.y.z,fd7a:115c:a1e0::xxxx
   # Studio 里有多个账号时，指定登录成哪一个；只有一个账号时可以留空
   STUDIO_TAILSCALE_USER=
   ```

   - `STUDIO_TAILSCALE_NODES` 里只要有一项不是 Tailscale 地址，免密码登录就会全部拒绝（日志原因 `nodes-invalid`），
     而不会退回「所有设备」。
   - 如果设置了 `STUDIO_PUBLIC_ORIGIN`，免密码登录只接受来自这个地址的页面。它必须写成完整的
     `https://<机器名>.<tailnet>.ts.net:8443`（带 `https://`、不带路径）；格式不对时免密码登录会全部拒绝
     （日志原因 `public-origin-invalid`）。
4. `systemctl --user restart agent-cloud-studio.service`，然后在 iPad 上重新打开 Studio。

只有同时满足下列条件才会免密码登录，否则照常显示登录页：请求经由 Tailscale Serve（`https://…ts.net`）
到达、Studio 只监听 `127.0.0.1`、不是 Funnel（公网）请求、页面与地址同源且是 https、
设备在 `STUDIO_TAILSCALE_NODES` 中（如果设置了）、登录名在白名单中。
每次登录成功或被拒绝都会写一行日志（`journalctl --user -u agent-cloud-studio -f` 中的
`[auth] Tailscale sign-in …`），包括原因、只显示前两个字符的登录名，以及发起请求的设备地址
（`from 100.x.y.z`）。设备不在名单里时原因是 `node-not-allowed`，可以据此核对要加入的地址。

撤销：免密码登录签发的会话会记下登录名和设备地址，每次请求都会按当前设置重新检查。
清空 `STUDIO_TAILSCALE_LOGINS`、把登录名移出白名单，或者让 `STUDIO_TAILSCALE_NODES` 不再包含那台设备，
重启服务后这些会话立即失效（Studio 自动续期得到的新 token 也一样）。用密码登录的会话不受影响；
要让**所有**会话都失效，在 `.env` 中设置一个新的随机 `JWT_SECRET` 并重启服务。

注意：

- 只在你信任这台电脑上的所有程序和用户、以及上面列出的设备上的所有 App 时开启。
- 不要再用 cloudflared、ngrok、nginx 等其他反向代理把 3002 端口转发出去；它们可能原样转发伪造的请求头。
- 不要对 Studio 开启 Tailscale Funnel。
- 「退出登录」后刷新页面会自动重新登录；要关闭此功能，清空 `STUDIO_TAILSCALE_LOGINS` 并重启服务。

## 安全说明

- 只通过 Tailscale 暴露，不要把 3002 端口开放到公网。你的 tailnet 列表里有其他人共享的设备，建议在 Tailscale ACL 中只允许你自己的设备访问 443 / 8443。
- 项目目录是 AI 会话的**工作目录**，不是沙箱。Claude Code 在跳过权限确认的模式下可以访问目录外的文件；Codex 默认使用 workspace-write 沙箱。
- Trading 212 模块只发送读取请求。密钥只存在你指定的文件里，Studio 不会保存、显示或回传密钥。
