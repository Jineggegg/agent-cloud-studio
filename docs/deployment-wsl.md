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

## 6. 用自己的 Tailscale 身份免密码登录（可选）

通过 Tailscale Serve 打开 Studio 时，Serve 会告诉后端「这个请求来自哪个 Tailscale 账号」。
把你自己的账号加入白名单后，iPad 打开 Studio 就会直接进入，不再显示登录页；
tailnet 里其他人（包括共享给你的设备）仍然需要密码。

1. 查出你的 Tailscale 登录名（在 Windows PowerShell 中）：

   ```powershell
   $s = tailscale status --json | ConvertFrom-Json
   $s.User."$($s.Self.UserID)".LoginName
   ```

   这是本机所登录账号的登录名，例如 `you@gmail.com` 或 `name@github`。如果 iPad 登录的是另一个账号，
   用 `tailscale whois <iPad 的 100.x 地址>` 查看 iPad 那一端的登录名。
2. 在 WSL 的 `.env` 中设置：

   ```ini
   STUDIO_TAILSCALE_LOGINS=you@gmail.com
   # Studio 里有多个账号时，指定登录成哪一个；只有一个账号时可以留空
   STUDIO_TAILSCALE_USER=
   ```

   如果设置了 `STUDIO_PUBLIC_ORIGIN`，免密码登录只接受来自这个地址的页面。
3. `systemctl --user restart agent-cloud-studio.service`，然后在 iPad 上重新打开 Studio。

只有同时满足下列条件才会免密码登录，否则照常显示登录页：请求经由 Tailscale Serve（`https://…ts.net`）
到达、Studio 只监听 `127.0.0.1`、不是 Funnel（公网）请求、页面与地址同源、登录名在白名单中。
每次登录成功或被拒绝都会写一行日志（`journalctl --user -u agent-cloud-studio -f` 中的
`[auth] Tailscale sign-in …`），登录名只显示前两个字符。

注意：

- 开启后，**本机上的任何程序**都能伪装成 Serve 访问 `127.0.0.1:3002`。只在你信任这台电脑上所有程序和用户时开启。
- 不要再用 cloudflared、ngrok、nginx 等其他反向代理把 3002 端口转发出去；它们可能原样转发伪造的请求头。
- 不要对 Studio 开启 Tailscale Funnel。
- 「退出登录」后刷新页面会自动重新登录；要关闭此功能，清空 `STUDIO_TAILSCALE_LOGINS` 并重启服务。

## 安全说明

- 只通过 Tailscale 暴露，不要把 3002 端口开放到公网。你的 tailnet 列表里有其他人共享的设备，建议在 Tailscale ACL 中只允许你自己的设备访问 443 / 8443。
- 项目目录是 AI 会话的**工作目录**，不是沙箱。Claude Code 在跳过权限确认的模式下可以访问目录外的文件；Codex 默认使用 workspace-write 沙箱。
- Trading 212 模块只发送读取请求。密钥只存在你指定的文件里，Studio 不会保存、显示或回传密钥。
