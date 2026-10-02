# 安全：防暴力破解、防越权、防拖垮

Studio 只有一个后端（这台笔记本），有两个入口（见 [network.md](network.md)）：

- **Tailscale 入口**：`https://<主机>.ts.net:8443`，只有你 tailnet 里的设备能到达，主人的设备可以免密码登录。
- **公网入口**：`https://studio.ajarche.com`，经 Cloudflare Tunnel，**任何人都能访问**，要输密码（或用面容 ID）。

Studio 能在这台电脑上运行 Claude Code、Codex 和终端，等于能执行任意代码，所以公网入口必须挡住：
猜密码的人、没登录就调接口的人、想用大量请求把服务拖垮的人。下面分三部分：**服务器自己做了什么**、
**你需要在 Cloudflare 后台做什么**，以及**密码被锁了怎么办**。

## 一、服务器自己做的事

### 1. 认清「谁在请求」

所有限流、锁定和日志都按「入口 + 客户端」计数（`server/modules/auth/request-client.service.ts`）。
cloudflared 和 Tailscale Serve 都从本机回环地址连进来，所以**光看来源地址分不出是哪个入口**。

**推荐做法：给 cloudflared 单独一个端口。** 在 `.env` 里设置 `STUDIO_CLOUDFLARED_PORT`（例如 `3012`），
Studio 会另外监听 `127.0.0.1:3012`，并且：

- **只有**从这个端口进来的连接才算公网入口，按 `CF-Connecting-IP` 区分访客（Cloudflare 会覆盖这个头）；
- 其他端口上的 Cloudflare 头（`CF-Ray` / `CF-Connecting-IP` / `CDN-Loop`）一律不信，
  所以 tailnet 里的其他设备即使经 Tailscale Serve 伪造这些头，也冒充不了公网访客；
- 这个端口上的请求一律按公网对待：要过 Cloudflare Access 检查（开启时），永远不会被当作 Tailscale 入口。

设置方法见第二部分第 1 步。

**没设置这个端口时**（兼容旧配置）：回环连接只要带**任何一个** Cloudflare 头，就算公网入口，
不管它还带了什么（`Tailscale-*` 身份头、`*.ts.net` 的 Host、tailnet 的 `X-Forwarded-For` 都不能把它挪到本机或
Tailscale 入口），所以互联网上的人花不掉本机和 Tailscale 入口的额度。代价是：tailnet 里的设备可以伪造
`CF-Connecting-IP`，冒充成任意一个公网访客。只有上面的独立端口能堵住这一点，所以推荐设置它。

| 入口 | 怎么认出来 | 用哪个地址计数 |
| --- | --- | --- |
| 公网（cloudflare） | 见上 | `CF-Connecting-IP`；IPv6 按 /64 合并 |
| Tailscale（tailnet） | 回环连接、`*.ts.net` 的 Host、`X-Forwarded-For` 恰好是一个 tailnet 地址（未设专用端口时还要求没有任何 Cloudflare 头） | 那台 tailnet 设备的地址 |
| 其他（direct） | 本机程序、局域网，或代理头对不上的请求 | 套接字地址；IPv6 按 /64 合并 |

**IPv6 按 /64 合并**：一个家庭宽带或手机通常分到整个 /64，攻击者在里面随便换地址也还是同一个客户端。

每种限制还会**按入口单独计总数**：公网被刷爆时，Tailscale 入口照常可用。

### 2. 密码：限流 + 按入口分开的锁定

- **按客户端限流**（内存）：登录时每个客户端 10 分钟内最多 5 次密码错误，每个入口合计 20 次；超过返回 429。
- **账户锁定**（SQLite，重启不丢），**按入口分开计**：
  - **公网密码登录**：所有不能确认来自 Tailscale 的登录都算这里；
  - **Tailscale 密码登录**：经 Tailscale Serve 的登录；
  - **已登录会话的密码确认**：已登录后再次输入密码（设置里添加/移除通行密钥、创建或重新启用 API 密钥、
    从 Tailscale 会话切换到公网入口）。它**按会话**计数（每次登录得到一个会话 ID，刷新令牌时保持不变）：
    每个会话 10 分钟 5 次，再加持久锁定，**不受登录锁定和登录限流影响**，同样会限次和记录。
    被盗的令牌最多锁住它自己那个会话的密码确认，碰不到你的；任何一次证明是你本人的登录（密码、面容 ID、
    Tailscale）和「退出所有设备」都会清掉所有会话的这类锁定。

  每一类连续 5 次密码错误就锁 15 分钟，再犯 30 分钟、1 小时、2 小时……最长 24 小时；
  在同一类里成功一次就清零，最后一次锁定结束后安静一天也会从 15 分钟重新算起。
- **结果**：公网上有人猜密码时，只有公网的密码登录被锁。你仍然可以：在 Tailscale 入口登录（免密码或密码）、
  从 Tailscale 会话切换到公网入口、在公网入口已登录的页面上添加通行密钥——而攻击者面对的公网密码登录一直锁着。
- **不泄露用户名是否存在**：不存在的用户名也会做一次同样代价的 bcrypt 比较、同样计数、同样锁定，
  所有拒绝的措辞完全一样。记录锁定的表对「不存在的用户名」有上限（1 万行），满了按「最久没用到」淘汰；
  真实账户的记录单独标记、从不淘汰；正在锁定的记录最晚被淘汰，所以锁定状态对真假用户名看起来一样。
- 锁定期间登录返回 429（`AUTH_ACCOUNT_LOCKED`，带 `Retry-After`），提示还要等多久，并提示改用面容 ID 或 Tailscale。

### 3. 面容 ID 登录（通行密钥）

- 登录页有「用面容 ID 登录」按钮（浏览器支持 WebAuthn 时才显示），不用输用户名和密码。
- 通行密钥按网址（RP ID）区分：`studio.ajarche.com` 和 Tailscale 地址要**分别**在「设置 → 安全」里启用。
  只有 `STUDIO_PUBLIC_ORIGIN` / `STUDIO_TAILNET_ORIGIN` 配置的入口能用。
- 必须通过设备验证（面容 ID / 触控 ID / 设备密码）；每次登录保存签名计数器，计数器倒退（克隆的密钥）会被拒绝。
- 每次登录是一个「仪式」：服务器给出挑战和一个仪式令牌——对「挑战 + 入口 + 网址 + 过期时间」的 HMAC 签名
  （密钥只在进程内存里）。回答必须带着这个令牌、在 60 秒内、从同一个入口和同一个网址回来。**发出仪式时服务器什么都不存**，
  所以再多的请求也填不满、挤不掉、挡不住任何人的登录；只记住已经用过的挑战，直到它们过期，用来拒绝重放。
  服务器重启只会让还没完成的登录重来一次。
- **添加和移除都需要已登录 + 当前密码**，所以借用一台已登录的设备也加不了自己的通行密钥。
- 用面容 ID 登录成功会解除**这个入口**的密码锁定。
- 登录用的通行密钥和 Trading 212 下单用的通行密钥是两套，互不影响。

### 4. 退出所有设备

每个会话令牌（JWT）里都带一个「令牌版本」。「设置 → 安全 → 退出所有设备」会：

- 把版本加一：之前签发的所有令牌（包括正在用的这台）立刻失效，HTTP 接口和 WebSocket 都拒绝；
- **立即切断**这个用户所有打开的 WebSocket（对话、终端、通知），不等客户端配合；
- **停用这个用户所有的 API 密钥**（之后要重新启用，需要输入密码）；
- 关闭 SNR 研究入口的访问 Cookie；
- 删除这个用户所有的推送订阅（Web Push），各设备重新登录后再开启推送；
- 作废还没兑换的「切换入口」一次性代码。

完成后的提示会说明具体撤销了什么（例如「停用 2 个 API 密钥、断开 3 个连接、移除 1 个推送订阅」），安全事件里也会记录。
同时清掉所有会话的密码确认锁定。
重新登录后拿到的是新版本的令牌。

**API 密钥**：创建新的 API 密钥、或重新启用被停用的密钥，都要输入当前登录密码（停用不需要）。
项目里目前没有「修改密码」的接口；以后加的话，改密码时也应该调用同一个版本加一。

### 5. 速率限制（所有请求）

每个请求进来先检查（`server/modules/request-guard`）：

1. **同时进行中的请求数**：每个客户端最多 100 个，每个入口最多 800 个（从读完请求头到响应结束），
   超过返回 429（`Retry-After: 5`）。慢慢发请求体、或者挂着连接不放的客户端占不满服务器。
2. **令牌桶**：按「客户端」和「入口」各一个桶，用完返回 **429** 并带 `Retry-After`。
   桶在内存里，客户端桶是有上限的 LRU（最多 1 万个），刷不爆内存。

| 档位 | 范围 | 每个客户端 | 每个入口合计 |
| --- | --- | --- | --- |
| public | 不登录也能调用的接口（见第 7 节的表），包括大小写、末尾斜杠、重复斜杠的各种写法 | 突发 30，之后每 2 秒 1 个 | 突发 300，每秒 10 个 |
| api | 其他 `/api/*`，包括已登录才能用的 `/api/auth/*`（user、refresh、security、handoff、logout 等） | 突发 600，每秒 20 个 | 突发 3000，每秒 150 个 |
| static | 网页和静态文件 | 突发 600，每秒 30 个 | 突发 4000，每秒 200 个 |
| upgrade | WebSocket 升级 | 突发 30，每 2 秒 1 个 | 突发 200，每秒 5 个 |

已登录的 `/api/auth/*` 不在 public 档，所以公网有人刷登录接口时，你的页面照样能加载。
WebSocket 还限制同时在线的连接：每个客户端 64 个，每个入口 512 个。

### 6. 防拖垮的服务器上限

| 项 | 值 | 作用 |
| --- | --- | --- |
| `headersTimeout` | 20 秒 | 每个请求从第一个字节起，请求头必须在这之内收完（防慢速攻击）；空闲的长连接不算在内 |
| `requestTimeout` | 600 秒 | 整个请求（头 + 正文）必须在这之内收完；文件上传最大 200 MB，2.7 Mbit/s 也能传完。只管收请求，不影响长时间的响应流（事件流、对话流式回复） |
| 未登录前读正文的期限 | 公开接口 30 秒、自带凭据的接口 60 秒 | 这些正文都很小；慢慢发的请求到期就回 408 并断开，占不住进行中名额。只有登录后的上传才用 600 秒 |
| `keepAliveTimeout` | 65 秒 | 空闲的长连接关闭（比代理的复用时间长，避免 502） |
| `maxRequestsPerSocket` | 1000 | 一条连接最多处理的请求数 |
| `maxConnections` | 1024 | 同时打开的连接上限（含 WebSocket），cloudflared 端口另有同样的上限 |
| WebSocket `maxPayload` | 16 MiB | 单条消息上限，超过以 1009 关闭 |

请求正文的大小按路由分组限制，**而且只在需要时才读**：

| 路由 | 上限 |
| --- | --- |
| 公开接口（`/api/auth/*` 等） | 32 KB |
| 自带凭据检查的接口（`/api/agent` API Key、`/api/browser-use-mcp` 本机令牌、`/api/studio/snr-site` Cookie） | 10 MB |
| 需要登录的接口 | 50 MB，**在令牌验证通过之后**才读正文 |

上传文件由各自的 multer 限制（图片 5 MB、附件 10 MB、语音 25 MB、文件树上传 200 MB）。
正文太大返回 413、格式错误返回 400，都不会在日志里留堆栈。未知的 `/api/*` 路径返回 JSON 404。

### 7. 不登录能访问什么（逐条审计）

除了下表，**所有** `/api/*` 路由都要先通过 `authenticateToken`（或路由自己的凭据检查），没有凭据一律 401，
响应里只有错误信息。测试 `server/modules/request-guard/tests/route-audit.test.ts` 会把服务器实际挂载的
每一条路由都不带凭据调用一遍（分别模拟公网入口和本机），并且对下表每个公开接口试大小写和斜杠的各种写法，
出现表外的公开路由、返回了数据、或某种写法绕开了 public 档就失败。

| 路由 | 返回什么 | 为什么安全 |
| --- | --- | --- |
| `GET /health` | `status`、时间、版本号、安装方式 | 没有用户数据；网页靠版本号判断服务器是否已更新 |
| `GET /api/auth/status` | 是否需要首次创建账户 | 登录页需要；不含用户名 |
| `POST /api/auth/register` | 已有账户时 403 | 只在首次运行时能用，有账户后一律拒绝 |
| `POST /api/auth/login` | 会话令牌或统一的错误 | 限流 + 按入口的锁定 + 统一措辞 + 等时比较 |
| `POST /api/auth/passkey/options` | 一次性挑战和签名的仪式令牌 | 不含任何凭据 ID，看不出有没有账户；服务器不存任何东西 |
| `POST /api/auth/passkey` | 会话令牌或统一的 401 | 需要设备上的通行密钥并通过设备验证 |
| `POST /api/auth/tailscale-session` | 会话令牌或统一的 403 | 只给 Tailscale Serve 转来的、白名单里的主人设备；公网入口一律拒绝 |
| `POST /api/auth/handoff/redeem` | 会话令牌或统一的 400 | 一次性、60 秒、绑定目标入口的 256 位代码；每个客户端限次。格式正确的代码不计入整个入口的总数（猜不中，也就挡不住你切换），格式不对的才计入 |
| `GET /api/studio/gmail/callback` | 跳转或 400 | OAuth `state` 绑定到已登录用户发起的请求 |
| `/api/studio/snr-site/*` | 无有效 Cookie 时 401 | 先检查短期范围 Cookie，写操作还要同源 |
| `POST /api/agent` | 无 API Key 时 401 | 外部 API，用设置里创建的 API Key |
| `/api/browser-use-mcp/*` | 无令牌时 401 | 本机 MCP 桥的随机令牌 |

静态路径：

| 路径 | 内容 | 为什么安全 |
| --- | --- | --- |
| `public/` 下的文件（`/manifest.json`、`/icons/*`、`/sw.js`、`/favicon.*`、`/logo-*.png`、`/api-docs.html`、`/screenshots/*` 等） | 仓库里自带的公开文件 | 不含任何用户数据 |
| `dist/` 下的构建产物（`/assets/*`） | 前端代码 | 和开源代码一样；路径穿越（`..`、编码的分隔符）被拒绝 |
| 其他不带扩展名的路径 | `index.html`（应用外壳） | 外壳本身没有数据，数据都要登录后从接口取 |

WebSocket（`/ws`、`/shell`、`/desktop-notifications`、`/plugin-ws/*`）没有有效令牌时一律 401。

### 8. 安全事件日志

SQLite 表 `auth_security_events`，分三类各保留最新 500 条：

- **重要事件**：锁定、解除锁定、添加/移除登录通行密钥、退出所有设备、停用 API 密钥；
- **成功登录**：密码登录、面容 ID 登录、Tailscale 免密码登录、切换入口登录；
- **失败尝试**：密码登录失败、面容 ID 登录失败、设置里的密码确认失败。

三类分开保留，所以再多的失败尝试也挤不掉一条锁定、一次通行密钥变更或「谁真的登录过」的记录。
任何人都能随手触发的面容 ID 登录失败（不管什么原因），每个客户端每分钟只记一条（日志也一样）；
密码失败本身就受限流约束。地址只存前半段（`198.51.*.*`、IPv6 只存前两组），不存完整地址和密码。
「设置 → 安全」里分「重要事件」「最近登录」和「最近的安全事件」显示。

旧版本（只有两个入口不分开锁定的那一版）建的数据库会在启动时自动升级：补上新列，旧的锁定记录归到公网入口。

## 二、Cloudflare 和本机要做的事（studio.ajarche.com）

服务器自己的限制挡得住大多数情况，但在 Cloudflare 边缘先挡一层，坏流量就根本到不了你的电脑。

### 1. 本机：给 cloudflared 单独一个端口（推荐）

1. 在 Studio 的 `.env` 里加一行（端口任选，不要和 `SERVER_PORT` 相同）：

   ```ini
   STUDIO_CLOUDFLARED_PORT=3012
   ```

2. 重启 `agent-cloud-studio.service`，日志里会出现 `Cloudflare Tunnel listener: http://127.0.0.1:3012`。
3. **马上**把 `~/.cloudflared/config.yml` 里 `studio.ajarche.com` 那条的 `service` 改成
   `http://127.0.0.1:3012`（完整示例见 `scripts/wsl/cloudflared-config.example.yml`），然后重启
   `studio-tunnel.service`。检查：`cloudflared tunnel ingress validate`。
4. Tailscale Serve 保持不变，继续指向原来的端口（3002）。

在第 2、3 步之间，经隧道进来的请求还落在原端口上，会被当作「其他（direct）」：仍然要密码、仍然受限流和锁定，
只是按本机地址合并计数，所以两步之间不要隔太久。

### 2. 强烈建议：Cloudflare Access + 邮箱验证码，只允许你自己

这是最有效的一步：开启后，陌生人连 Studio 的登录页都看不到，密码和面容 ID 变成第二道门。

1. Cloudflare 后台 → **Zero Trust** → Access → Applications → Add an application → **Self-hosted**。
2. Application domain 填 `studio.ajarche.com`（整个域名，不填路径）。
3. 加一条 Policy：Action 选 **Allow**，Include 选 **Emails**，只填你自己的邮箱。
4. 登录方式（Login methods）用 **One-time PIN**（邮箱验证码）；Session duration 可以设长一点（例如 1 个月）。
5. 再建一个 **Bypass** 应用，只放行 `studio.ajarche.com/health`、`studio.ajarche.com/manifest.json`、
   `studio.ajarche.com/icons/*`（详见 [network.md 第 6 步](network.md#6-强烈建议在前面加-cloudflare-access)）。
6. 让 Studio 自己也核对 Access（防止哪天 Access 应用被误删），在服务器 `.env` 加：

   ```ini
   STUDIO_CF_ACCESS_TEAM_DOMAIN=<团队名>.cloudflareaccess.com
   STUDIO_CF_ACCESS_AUD=<Access 应用的 AUD 标签>
   ```

   - 团队名：Zero Trust → Settings → Custom Pages 里的 **Team domain**。
   - AUD 标签：Zero Trust → Access → Applications → Studio 应用 → Overview 里的 **Application Audience (AUD) Tag**。
   - 改完重启 `agent-cloud-studio.service`。之后经 Cloudflare 进来（或从 cloudflared 专用端口进来）、
     没有有效 Access 凭据的请求一律 403（上面三个 Bypass 路径除外）。
     详见 [network.md 第 6b 步](network.md#6b-可选让-studio-自己核对-access)。

### 3. WAF 限流规则：`/api/auth/*`

Cloudflare 后台 → 选中 `ajarche.com` → **Security → WAF → Rate limiting rules** → Create rule：

- Rule name：`studio auth`
- If incoming requests match（Edit expression）：

  ```text
  (http.host eq "studio.ajarche.com" and starts_with(http.request.uri.path, "/api/auth/") and http.request.method eq "POST")
  ```

  只限 POST：页面加载时会 GET `/api/auth/status`、`/api/auth/user`，不该算进去。
- With the same characteristics：**IP**。IPv6 访客可以在自己的 /64 里随意换地址：如果你的套餐支持
  自定义计数表达式（Counting expression / Enterprise 的高级特征），把 IPv6 按 /64 前缀计数；
  否则就用 IP，再把阈值设低一些，并保留下面的 Bot Fight Mode——Studio 自己已经按 /64 合并计数。
- 阈值（按套餐能选的为准）：
  - Free 套餐：周期只能选 10 秒，例如「10 秒内 5 次」，Action **Block**，持续 10 秒；
  - Pro 及以上：例如「1 分钟内 10 次」，Action **Block** 或 **Managed Challenge**，持续 10 分钟。
- Deploy。

### 4. Bot Fight Mode

Cloudflare 后台 → `ajarche.com` → **Security → Bots** → 打开 **Bot Fight Mode**。

它会对识别为自动程序的流量发挑战，正常浏览器（包括 iPad 主屏幕 App）不受影响。
如果之后用脚本从公网访问 `/api/agent`，可能会被挑战拦下：脚本请走 Tailscale 入口。

### 5. 可选

- 遇到正在进行的攻击：Security → Settings → **Under Attack Mode** 临时打开。
- Security → Events 里能看到被 WAF 和 Bot Fight Mode 拦下的请求。

## 三、密码登录被锁了怎么办

锁定只影响**被锁的那个入口的密码登录**，按方便程度：

1. **用 Tailscale 入口**：在已经加入 tailnet 的主人设备上打开 `https://<主机>.ts.net:8443`，免密码登录。
   公网的密码锁定不影响这里；Tailscale 入口自己的密码锁定会随免密码登录一起解除。
   （Tailscale 登录**不会**解除公网的锁定：它在每次打开应用时都会运行，否则等于每次都给猜密码的人新的机会。
   它会清掉「已登录会话的密码确认」锁定。）
2. **用面容 ID 登录**：在被锁的那个网址点「用面容 ID 登录」，成功后这个入口的锁定解除。
   公网入口还没有通行密钥的话：先在 Tailscale 入口登录，切换到公网入口（需要输一次密码，用的是已登录会话的额度，
   不受公网锁定影响），再在公网入口的「设置 → 安全」里添加通行密钥。
3. **在这台笔记本上用命令解除**（不需要服务器在运行，也不需要密码；能运行它的人已经控制了这台电脑）：

   ```bash
   cd ~/projects/agent-cloud-studio
   node scripts/clear-login-lock.mjs            # 解除所有锁定和错误计数（各个入口）
   node scripts/clear-login-lock.mjs andrew     # 只解除某个用户名（各个入口）
   ```

   脚本读取和服务器相同的数据库（环境变量或 `.env` 里的 `DATABASE_PATH`，默认 `~/.cloudcli/auth.db`），
   立即生效，无需重启。等价的一行命令（在应用目录里运行；`.env` 里改过 `DATABASE_PATH` 的话先 `export DATABASE_PATH=...`）：

   ```bash
   node -e "const D=require('better-sqlite3');const p=process.env.DATABASE_PATH||require('os').homedir()+'/.cloudcli/auth.db';console.log(new D(p).prepare('DELETE FROM auth_login_lockouts').run().changes)"
   ```

4. **等待**：锁定到期自动解除（时间见登录页提示）。

注意：每个客户端「10 分钟 5 次」的限流是内存里的，脚本清不掉；它 10 分钟后自动恢复，换个网络或用 Tailscale 入口也不受影响。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `STUDIO_CLOUDFLARED_PORT` | 新增，推荐：cloudflared 专用的本机端口（例如 `3012`）。设置后只有从这个端口进来的连接算公网入口，隧道的 ingress 要指向它。不设置时按 Cloudflare 头判断（见第一部分第 1 节）。和 `SERVER_PORT` 相同或格式不对时会被忽略，日志里有提示。 |
| `STUDIO_PUBLIC_ORIGIN` / `STUDIO_TAILNET_ORIGIN` | 两个入口的地址；面容 ID 登录只在这两个地址可用，RP ID 就是它们的主机名。 |
| `STUDIO_CF_ACCESS_TEAM_DOMAIN` / `STUDIO_CF_ACCESS_AUD` | 让 Studio 自己核对 Cloudflare Access（见上文）。 |
| `STUDIO_TAILSCALE_LOGINS`（及 `_NODES`、`_USER`） | 允许免密码登录的 Tailscale 身份和设备，见 network.md。 |
| `DATABASE_PATH` | 数据库位置；锁定、通行密钥、事件日志和令牌版本都在这里。 |
| `JWT_SECRET` | 令牌签名密钥；更换它会让所有会话失效（「退出所有设备」不需要换它）。 |
