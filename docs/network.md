# 连接方式：一个后端，两个入口

Studio 只在你的笔记本上运行（WSL 里的 `agent-cloud-studio.service`，监听 `127.0.0.1:3002`）。
外面的设备有两个入口可以进来，两个入口最后都连到**同一个进程、同一个数据库**：

```
                      ┌──────────── 入口 A：公网域名（默认）────────────┐
iPad / iPhone / 电脑 ─┤  https://studio.ajarche.com                     ├─┐
                      │  Cloudflare 边缘 →（Access 验证邮箱）→ Tunnel   │ │
                      └─────────────────────────────────────────────────┘ │
                                                                          ▼
                                                     笔记本 WSL：cloudflared / Tailscale Serve
                                                                          │  都转到 127.0.0.1:3002
                      ┌──────────── 入口 B：Tailscale · AJ 通道 ─────────┐ ▼
iPad / iPhone / 电脑 ─┤  https://laptop-acgghbuq.tail6e45f0.ts.net:8443  ├─► Studio（唯一的后端和数据库）
                      │  AJ 的 tailnet；需要时经 AJ 服务器的出口节点上网  │     ├─ Claude Code / Codex（本机登录）
                      └──────────────────────────────────────────────────┘     └─ SSH → AJ 服务器（只当算力主机）
```

## 为什么是「一个后端 + 两个入口」

你担心的「两台服务器信息不对称、不同步」，在这个方案里不会发生：

- **数据只有一份。** 项目、会话、设置、密钥库都在笔记本的 `.data/` 里。两个入口只是两条路，不是两份 Studio，
  所以不存在同步问题，也不会出现一边改了另一边看不到。
- **AJ 的服务器不跑第二个 Studio。** 它继续做两件事：SSH 远程主机（在上面跑 Claude / Codex 任务），
  以及网络通道（tailnet 和出口节点）。要是在它上面再装一个 Studio，就会有两份数据库、两套 CLI 登录，
  才真的需要同步，而且冲突没法自动解决。
- **两全其美：** 平时走公网域名，任何网络都能打开，不用先开 VPN；在国内或者公网不稳时，切到 Tailscale 通道，
  并让笔记本和 iPad 都用 AJ 服务器的出口节点，Claude / Codex 照常能连上它们的 API。

在 Studio 的「设置 → 连接方式」里可以看到两个入口、它们现在通不通（延迟），以及你正在用哪一个。
点另一个入口会**带着登录一起切过去**（见下文「切换入口」），不用重新输入密码。

## 入口 A：公网域名（Cloudflare Tunnel）

`ajarche.com` 的 DNS 在 Cloudflare，所以用 Cloudflare Tunnel：笔记本上的 `cloudflared` 主动连到 Cloudflare，
**不需要**在路由器上开端口，也不需要公网 IP。以下步骤都在 WSL 里、用你自己的用户执行，**不需要 sudo**。

### 1. 安装 cloudflared

```bash
cd ~/projects/agent-cloud-studio
bash scripts/wsl/install-cloudflared.sh          # 装到 ~/.local/bin/cloudflared；再运行一次不会重复下载
bash scripts/wsl/install-cloudflared.sh --update # 以后要升级时
```

脚本只从 Cloudflare 官方 GitHub Release 下载 Linux amd64 版本，并检查它能运行；不会登录、建隧道或启动任何东西。

### 2. 登录 Cloudflare（你本人在浏览器里操作）

```bash
cloudflared tunnel login
```

终端会打印一个链接。在浏览器里打开、登录 Cloudflare 账号，选中 `ajarche.com` 并授权。
完成后会生成 `~/.cloudflared/cert.pem`（只用来管理隧道，不要提交、不要发给别人）。

### 3. 创建隧道并绑定子域名

```bash
cloudflared tunnel create studio                       # 记下输出里的隧道 UUID
cloudflared tunnel route dns studio studio.ajarche.com # 在 Cloudflare 自动建 CNAME → <UUID>.cfargotunnel.com
```

`create` 会生成 `~/.cloudflared/<UUID>.json`，这是隧道的凭据文件，同样不要提交。

### 4. 写 `~/.cloudflared/config.yml`

```yaml
tunnel: <UUID>
credentials-file: /home/laosong/.cloudflared/<UUID>.json

ingress:
  - hostname: studio.ajarche.com
    service: http://127.0.0.1:3002
    originRequest:
      # 固定转给 Studio 的 Host，客户端无法通过隧道伪装成 *.ts.net 地址。
      httpHostHeader: studio.ajarche.com
  # 其余任何主机名一律 404，隧道不会被拿去访问别的东西。
  - service: http_status:404
```

检查配置：`cloudflared tunnel ingress validate`，以及
`cloudflared tunnel ingress rule https://studio.ajarche.com`（应命中第一条）。

### 5. 作为 systemd 用户服务运行

```bash
mkdir -p ~/.config/systemd/user
cp scripts/wsl/studio-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now studio-tunnel.service
journalctl --user -u studio-tunnel -f      # 看到 "Registered tunnel connection" 就好了
```

它和 `agent-cloud-studio.service` 一样是用户服务：Studio 能在你关掉终端后继续运行，隧道也一样。

### 6. 强烈建议：在前面加 Cloudflare Access

Studio 能在这台笔记本上运行 Claude Code、Codex 和终端，**等于能在你的电脑上执行代码**。
公网域名谁都能访问，只靠 Studio 自己的密码太单薄。在 Cloudflare 后台加一道 Access：

1. Cloudflare 后台 → Zero Trust → Access → Applications → Add an application → **Self-hosted**。
2. Application domain 填 `studio.ajarche.com`（整个域名，不填路径）。
3. 加一条 Policy：Action 选 **Allow**，Include 选 **Emails**，只填你自己的邮箱。
4. 登录方式用默认的 One-time PIN（邮箱验证码）即可；Session duration 可以设长一点（例如 1 个月），
   免得频繁验证。

之后打开 `https://studio.ajarche.com` 会先要求邮箱验证码，通过后才会看到 Studio 的登录页。
WebSocket（对话、终端）在 Access 后面照常工作。

- iPad「添加到主屏幕」后，主屏幕 App 有自己独立的 Cookie，第一次打开时要在里面再做一次邮箱验证。
- 如果主屏幕图标或名称显示不对，是因为 Access 挡住了 `manifest.json`：再建一个只针对
  `studio.ajarche.com/manifest.json` 和 `studio.ajarche.com/icons/*` 的 Access 应用，Policy 选 **Bypass**。
- 设置页里「延迟」检测请求的是 `/health`，在 Access 后面也能测出「通不通」，不需要为它放行。

### 7. 告诉 Studio 公网地址

在 WSL 的 `.env` 里：

```ini
STUDIO_PUBLIC_ORIGIN=https://studio.ajarche.com
STUDIO_TAILNET_ORIGIN=https://laptop-acgghbuq.tail6e45f0.ts.net:8443
```

然后 `systemctl --user restart agent-cloud-studio.service`。

注意：

- **两个都要写。** 以前 `STUDIO_PUBLIC_ORIGIN` 写的是 ts.net 地址；现在它改成公网域名，
  ts.net 地址要挪到 `STUDIO_TAILNET_ORIGIN`。只改前者、不写后者时，Tailscale 免密码登录会全部拒绝
  （日志原因 `pinned-origin-not-tailnet`），不会误放行。
- 如果你用了 Gmail 邮箱模块：OAuth 回调地址跟着 `STUDIO_PUBLIC_ORIGIN` 走，要在 Google Cloud Console
  里把授权回调改成（或加上）`https://studio.ajarche.com/api/studio/gmail/callback`。连接完成后会回到公网域名。

### 公网入口与免密码登录

Tailscale 免密码登录**只在** Tailscale 通道上生效。经隧道进来的请求同样来自本机回环地址，
而且 Cloudflare 不会删掉客户端自己伪造的 `Tailscale-User-Login` 头，所以 Studio 用三道检查拒绝它们：

1. Host 必须是 `*.ts.net` 名称，并且 Origin 必须正好等于 `STUDIO_TAILNET_ORIGIN`；隧道转来的 Host 是
   `studio.ajarche.com`（上面的 `httpHostHeader` 把它固定住了）。
2. 带有 Cloudflare 边缘必加的 `CF-Ray` / `CF-Connecting-IP` / `CDN-Loop: cloudflare` 头的请求一律拒绝。
3. Cloudflare 会把真实客户端地址追加到伪造的 `X-Forwarded-For` 后面，变成多个地址，同样被拒绝。

所以公网入口永远要输密码（加上 Access 的邮箱验证）。

## 入口 B：Tailscale · AJ 通道

这就是原来的访问方式（见 [WSL 部署](deployment-wsl.md)）：Windows 上的 Tailscale Serve 把
`https://laptop-acgghbuq.tail6e45f0.ts.net:8443` 转到 `127.0.0.1:3002`：

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:3002
```

- 只有 AJ 的 tailnet 里、被允许的设备能打开；证书由 Tailscale 自动签发。
- 可以开启「用自己的 Tailscale 身份免密码登录」（`STUDIO_TAILSCALE_LOGINS`，见部署文档第 8 节）。
  它只接受 Origin 等于 `STUDIO_TAILNET_ORIGIN` 的页面；没设这个变量时才退回 `STUDIO_PUBLIC_ORIGIN`（兼容旧配置）。
- 不要对 Studio 开 Tailscale Funnel。公网访问请用上面的 Cloudflare 入口。

## 切换入口（带着登录走）

两个入口是两个不同的网址，浏览器把它们当成两个网站，登录状态（token）各存各的。
「设置 → 连接方式」里点另一个入口时：

1. 当前页面向 Studio 要一个**一次性切换码**（`POST /api/auth/handoff`）。切换码是 32 字节随机数，
   服务器只存它的哈希，**60 秒**内有效、只能用一次，并且绑定你的账号和目标入口的网址。
2. 浏览器打开目标入口的同一个页面，地址里带着 `?handoff=<切换码>`。
3. 目标页面一启动就把切换码从地址栏里删掉，再用它换取登录（`POST /api/auth/handoff/redeem`）。
   服务器会核对请求的 Origin 必须就是目标入口；换取接口有频率限制。
4. 换取成功后和正常登录一样保存 token；失败（过期、已用过、网址不对）时照常显示登录页并说明原因。

会话类型的规则：**切换后得到的会话不会比原来的更「宽」。**

| 当前会话 | 切到 Tailscale 通道 | 切到公网域名 |
| --- | --- | --- |
| 密码登录的会话 | 得到同样的密码会话 | 得到同样的密码会话 |
| Tailscale 免密码会话 | 保留 Tailscale 标记，白名单变化时仍会被撤销 | **必须输入一次账户密码**，之后得到普通密码会话 |

原因：免密码登录只证明了「这是你在 tailnet 里的设备」，并不能证明公网上的请求也是你，
所以不能凭它直接换一个公网会话。设置页会在需要时弹出密码框。

设置页还会在每台设备上记住你上次选的入口（`localStorage` 的 `studio-ingress-v1`，每个网址各存一份）。
如果你从主屏幕图标打开的入口和上次选的不一样，会出现一个「切换过去」的快捷按钮。

iPad 小提示：主屏幕上的 Web App 绑定在一个网址上。两个入口都常用的话，可以各「添加到主屏幕」一个图标。

## 在国内使用：AJ 服务器做出口节点

在国内时，Claude / Codex 的 API 和 Cloudflare 都可能连不上或很慢。做法是走 Tailscale 通道，
并让 tailnet 里一台在境外、由 AJ 管理的机器（他的服务器）当**出口节点**：设备的上网流量从那台机器出去。

**需要 AJ 在他那边做的（tailnet 管理员）：**

1. 在他的服务器（Linux）上开启转发并宣告出口节点：

   ```bash
   echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-tailscale.conf
   echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
   sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
   sudo tailscale set --advertise-exit-node
   ```

2. 在 Tailscale 管理后台 → Machines → 这台服务器 → Edit route settings → 勾选 **Use as exit node**（批准）。
3. 如果 tailnet 用了自定义 ACL：允许你的账号使用出口节点（目标 `autogroup:internet:*`），
   并允许你的设备访问笔记本的 8443 端口。
4. 建议给你的笔记本节点点 **Disable key expiry**，否则节点密钥过期（默认 180 天）时 Tailscale 通道会突然断开，
   要你回到电脑前重新登录 Tailscale。

**你这边要做的：**

- **笔记本也要选出口节点**，不只是 iPad：Claude Code / Codex 是在笔记本上运行的，它们访问 API 的流量要从
  AJ 的服务器出去。在 Windows 右下角 Tailscale 菜单 → Exit node → 选 AJ 的服务器；WSL 用的是镜像网络，会跟着走。
  建议同时勾选 **Allow local network access**，免得局域网设备（打印机、NAS）连不上。
- **iPad / iPhone：** Tailscale App → Exit Node → 选 AJ 的服务器，然后打开 Tailscale 通道的地址。
- 可以做一个 iOS 快捷指令，一键完成：用 Tailscale App 提供的快捷指令动作「连接」和「使用出口节点」
  （不同版本名称可能略有差别），最后加一个「打开 URL」动作：
  `https://laptop-acgghbuq.tail6e45f0.ts.net:8443`。放到主屏幕或控制中心即可。
- 回到境外时，在两边都把出口节点改回「无」，再用公网域名即可。

出口节点开着时 Cloudflare 隧道仍然能用（`cloudflared` 的连接也会从 AJ 的服务器出去，延迟会高一些）。

## 笔记本睡眠或关机时

两个入口都依赖这台笔记本开机、联网、WSL 在运行。笔记本睡眠时：

- 公网域名会显示 Cloudflare 的 502 / 1033 错误页；Tailscale 通道打不开（设置页显示「不可达」）。
- 正在运行的 Claude / Codex 任务会暂停；SSH 到 AJ 服务器上跑在 tmux 里的任务不受影响。

短期办法：Windows「电源和睡眠」里把插电时的睡眠设为「从不」，合盖时「不采取任何操作」。

长期办法：把「中枢」挪到一台一直开着的机器上（例如一台小主机或你自己的云服务器），在那里运行 Studio 服务，
把 Cloudflare 隧道和 Tailscale Serve 都指向它，再把笔记本当成一台 SSH 远程主机。迁移时复制 `.data/`
（数据库和 `studio-vault`）和 `.env`，并在那台机器上重新登录 Claude / Codex。方案不变：始终只有一个后端、
一份数据，入口只是路。

## 新增的环境变量

| 变量 | 作用 |
| --- | --- |
| `STUDIO_PUBLIC_ORIGIN` | 公网入口的完整地址，例如 `https://studio.ajarche.com`（不带路径）。也用于 Gmail OAuth 回调。 |
| `STUDIO_TAILNET_ORIGIN` | Tailscale 入口的完整地址，例如 `https://laptop-acgghbuq.tail6e45f0.ts.net:8443`。免密码登录只接受这个地址的页面。 |

两者都写成 `https://主机[:端口]`，不带路径（本地开发 `npm run dev` 用的 `http://127.0.0.1:5174` 也接受）。
写错时设置页会提示「格式不对」，对应入口不能切换；免密码登录则全部拒绝（日志 `pinned-origin-invalid`）。
修改 `.env` 后需要重启 `agent-cloud-studio.service`。
