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

## 6. SNR 实验室（可选）

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

## 安全说明

- 只通过 Tailscale 暴露，不要把 3002 端口开放到公网。你的 tailnet 列表里有其他人共享的设备，建议在 Tailscale ACL 中只允许你自己的设备访问 443 / 8443。
- 项目目录是 AI 会话的**工作目录**，不是沙箱。Claude Code 在跳过权限确认的模式下可以访问目录外的文件；Codex 默认使用 workspace-write 沙箱。
- Trading 212 模块只发送读取请求。密钥只存在你指定的文件里，Studio 不会保存、显示或回传密钥。
