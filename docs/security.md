# 安全：防暴力破解、防越权、防拖垮

Studio 只有一个后端（这台笔记本），有两个入口（见 [network.md](network.md)）：

- **Tailscale 入口**：`https://<主机>.ts.net:8443`，只有你 tailnet 里的设备能到达，主人的设备可以免密码登录。
- **公网入口**：`https://studio.ajarche.com`，经 Cloudflare Tunnel，**任何人都能访问**，要输密码（或用面容 ID）。

Studio 能在这台电脑上运行 Claude Code、Codex 和终端，等于能执行任意代码，所以公网入口必须挡住：
猜密码的人、没登录就调接口的人、想用大量请求把服务拖垮的人。下面分两部分：**服务器自己做了什么**，
以及**你需要在 Cloudflare 后台做什么**。

## 一、服务器自己做的事

### 1. 认清「谁在请求」

所有限流、锁定和日志都按「入口 + 客户端地址」计数（`server/modules/auth/request-client.service.ts`）：

| 入口 | 怎么认出来 | 用哪个地址 |
| --- | --- | --- |
| 公网（cloudflare） | 连接来自本机回环（cloudflared）**并且**带 Cloudflare 边缘头（`CF-Ray` / `CF-Connecting-IP` / `CDN-Loop: cloudflare`） | `CF-Connecting-IP`（Cloudflare 会覆盖它，是真实访客地址） |
| Tailscale（tailnet） | 回环连接、`*.ts.net` 的 Host、符合 `STUDIO_TAILNET_ORIGIN`、`X-Forwarded-For` 恰好是一个 tailnet 地址 | 那台 tailnet 设备的地址 |
| 其他（direct） | 本机程序、局域网，或代理头对不上的请求 | 套接字的真实对端地址 |

不是从回环来的请求即使伪造 `CF-Connecting-IP`，也按它自己的地址计数，挑不了别人的额度。
`X-Forwarded-For` 只在上面 Tailscale 那一种情况下读取。每种限制还会**按入口单独计总数**：
公网被刷爆时，Tailscale 入口照常可用。

### 2. 密码登录：限流 + 账户锁定

- **按客户端限流**（内存）：每个地址 10 分钟内最多 5 次密码错误，每个入口合计 20 次；超过返回 429。
  登录、切换入口时的密码确认、设置里的密码确认共用这份额度。
- **账户锁定**（SQLite，重启不丢）：这个账户**不管从哪里来**，连续 5 次密码错误，就锁定密码登录：
  15 分钟，再犯 30 分钟、1 小时、2 小时……最长 24 小时。任意一次成功登录（密码、面容 ID、Tailscale）清零；
  最后一次锁定结束后安静一天，也会从 15 分钟重新算起。
- **不泄露用户名是否存在**：不存在的用户名也会做一次同样代价的 bcrypt 比较、同样计数、同样锁定，
  所有拒绝的措辞完全一样。
- 锁定期间返回 429（`AUTH_ACCOUNT_LOCKED`），提示还要等多久，并提示改用面容 ID 或 Tailscale 登录。
- 锁定**不会把你自己关在外面**：Tailscale 主人设备免密码登录、面容 ID 登录都照常可用，而且会顺便解除锁定。
  也可以在本机用命令解除（见第三部分）。

### 3. 面容 ID 登录（通行密钥）

- 登录页有「用面容 ID 登录」按钮（浏览器支持 WebAuthn 时才显示），不用输用户名和密码。
- 通行密钥按网址（RP ID）区分：`studio.ajarche.com` 和 Tailscale 地址要**分别**在「设置 → 安全」里启用。
  只有 `STUDIO_PUBLIC_ORIGIN` / `STUDIO_TAILNET_ORIGIN` 配置的入口能用。
- 必须通过设备验证（面容 ID / 触控 ID / 设备密码）；挑战一次性、60 秒过期、只在签发它的入口有效；
  每次登录都保存签名计数器，计数器倒退（克隆的密钥）会被拒绝。
- **添加和移除都需要已登录 + 当前密码**（设置里的二次确认，同样受限流和锁定约束），
  所以借用一台已登录的设备也加不了自己的通行密钥。
- 登录用的通行密钥和 Trading 212 下单用的通行密钥是两套，互不影响。

### 4. 退出所有设备

每个会话令牌（JWT）里都带一个「令牌版本」。「设置 → 安全 → 退出所有设备」会把版本加一：

- 之前签发的所有令牌（包括正在用的这台）立刻失效，HTTP 接口和 WebSocket 都拒绝；
- 已经连着的 WebSocket（对话、终端、通知）立即被关闭（关闭码 4401）；
- 还没兑换的「切换入口」一次性代码作废。

重新登录后拿到的是新版本的令牌。项目里目前没有「修改密码」的接口；以后加的话，改密码时也应该调用同一个版本加一。

### 5. 速率限制（所有请求）

每个请求进来先扣令牌桶（`server/modules/request-guard`），按「客户端」和「入口」各一个桶，
用完返回 **429** 并带 `Retry-After`。桶在内存里，客户端桶是有上限的 LRU（最多 1 万个），刷不爆内存。

| 档位 | 范围 | 每个客户端 | 每个入口合计 |
| --- | --- | --- | --- |
| public | `/api/auth/*`、`/health`（不登录也能访问的接口） | 突发 30，之后每 2 秒 1 个 | 突发 300，每秒 10 个 |
| api | 其他 `/api/*` | 突发 600，每秒 20 个 | 突发 3000，每秒 150 个 |
| static | 网页和静态文件 | 突发 600，每秒 30 个 | 突发 4000，每秒 200 个 |
| upgrade | WebSocket 升级 | 突发 30，每 2 秒 1 个 | 突发 200，每秒 5 个 |

WebSocket 还限制同时在线的连接：每个客户端 64 个，每个入口 512 个。

### 6. 防拖垮的服务器上限

| 项 | 值 | 作用 |
| --- | --- | --- |
| `requestTimeout` | 180 秒 | 整个请求（头 + 正文）必须在这之内收完 |
| `headersTimeout` | 66 秒 | 请求头必须在这之内收完（防慢速攻击） |
| `keepAliveTimeout` | 65 秒 | 空闲的长连接关闭（比代理的复用时间长，避免 502） |
| `maxRequestsPerSocket` | 1000 | 一条连接最多处理的请求数 |
| `maxConnections` | 1024 | 同时打开的连接上限（含 WebSocket），超过直接断开 |
| WebSocket `maxPayload` | 16 MiB | 单条消息上限，超过以 1009 关闭 |

请求正文的大小按路由分组限制，**而且只在需要时才读**：

| 路由 | 上限 |
| --- | --- |
| 公开接口（`/api/auth/*` 等） | 32 KB |
| 自带凭据检查的接口（`/api/agent` API Key、`/api/browser-use-mcp` 本机令牌、`/api/studio/snr-site` Cookie） | 10 MB |
| 需要登录的接口 | 50 MB，**在令牌验证通过之后**才读正文 |

上传文件由各自的 multer 限制（图片 5 MB、附件 10 MB、语音 25 MB、文件树上传按设置）。
正文太大返回 413、格式错误返回 400，都不会在日志里留堆栈。未知的 `/api/*` 路径返回 JSON 404。

### 7. 不登录能访问什么（逐条审计）

除了下表，**所有** `/api/*` 路由都要先通过 `authenticateToken`（或路由自己的凭据检查），没有凭据一律 401，
响应里只有错误信息。测试 `server/modules/request-guard/tests/route-audit.test.ts` 会把服务器实际挂载的
每一条路由都不带凭据调用一遍（分别模拟公网入口和本机），出现表外的公开路由或返回了数据就失败。

| 路由 | 返回什么 | 为什么安全 |
| --- | --- | --- |
| `GET /health` | `status`、时间、版本号、安装方式 | 没有用户数据；网页靠版本号判断服务器是否已更新 |
| `GET /api/auth/status` | 是否需要首次创建账户 | 登录页需要；不含用户名 |
| `POST /api/auth/register` | 已有账户时 403 | 只在首次运行时能用，有账户后一律拒绝 |
| `POST /api/auth/login` | 会话令牌或统一的错误 | 限流 + 账户锁定 + 统一措辞 + 等时比较 |
| `POST /api/auth/passkey/options` | 一次性挑战 | 不含任何凭据 ID，看不出有没有账户 |
| `POST /api/auth/passkey` | 会话令牌或统一的 401 | 需要设备上的通行密钥并通过设备验证 |
| `POST /api/auth/tailscale-session` | 会话令牌或统一的 403 | 只给 Tailscale Serve 转来的、白名单里的主人设备；公网入口一律拒绝 |
| `POST /api/auth/handoff/redeem` | 会话令牌或统一的 400 | 一次性、60 秒、绑定目标入口的 256 位代码，兑换次数限流 |
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

SQLite 表 `auth_security_events`，只保留最新 500 条，记录：密码登录失败/成功、锁定和解除、
面容 ID 登录成功/失败、添加/移除登录通行密钥、设置里的密码确认失败、退出所有设备。
地址只存前半段（`198.51.*.*`），不存完整地址和密码。在「设置 → 安全」里能看到最近的事件。

## 二、Cloudflare 后台要做的事（studio.ajarche.com）

服务器自己的限制挡得住大多数情况，但在 Cloudflare 边缘先挡一层，坏流量就根本到不了你的电脑。

### 1. 强烈建议：Cloudflare Access + 邮箱验证码，只允许你自己

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
   - 改完重启 `agent-cloud-studio.service`。之后不带有效 Access 凭据、经 Cloudflare 进来的请求一律 403
     （上面三个 Bypass 路径除外）。详见 [network.md 第 6b 步](network.md#6b-可选让-studio-自己核对-access)。

### 2. WAF 限流规则：`/api/auth/*`

Cloudflare 后台 → 选中 `ajarche.com` → **Security → WAF → Rate limiting rules** → Create rule：

- Rule name：`studio auth`
- If incoming requests match（Edit expression）：

  ```text
  (http.host eq "studio.ajarche.com" and starts_with(http.request.uri.path, "/api/auth/") and http.request.method eq "POST")
  ```

  只限 POST：页面加载时会 GET `/api/auth/status`、`/api/auth/user`，不该算进去。
- With the same characteristics：**IP**
- 阈值（按套餐能选的为准）：
  - Free 套餐：周期只能选 10 秒，例如「10 秒内 5 次」，Action **Block**，持续 10 秒；
  - Pro 及以上：例如「1 分钟内 10 次」，Action **Block** 或 **Managed Challenge**，持续 10 分钟。
- Deploy。

Studio 自己还有限流和账户锁定，这条规则的作用是让刷接口的流量停在 Cloudflare，不占用你的电脑和带宽。

### 3. Bot Fight Mode

Cloudflare 后台 → `ajarche.com` → **Security → Bots** → 打开 **Bot Fight Mode**。

它会对识别为自动程序的流量发挑战，正常浏览器（包括 iPad 主屏幕 App）不受影响。
如果之后用脚本从公网访问 `/api/agent`，可能会被挑战拦下：脚本请走 Tailscale 入口。

### 4. 可选

- 遇到正在进行的攻击：Security → Settings → **Under Attack Mode** 临时打开。
- Security → Events 里能看到被 WAF 和 Bot Fight Mode 拦下的请求。

## 三、密码登录被锁了怎么办

锁定只影响**密码登录**。按方便程度：

1. **用 Tailscale 入口**：在已经加入 tailnet 的主人设备上打开 `https://<主机>.ts.net:8443`，免密码登录，锁定随即解除。
2. **用面容 ID 登录**：在已经启用了通行密钥的网址点「用面容 ID 登录」，成功后锁定解除。
3. **在这台笔记本上用命令解除**（不需要服务器在运行，也不需要密码；能运行它的人已经控制了这台电脑）：

   ```bash
   cd ~/projects/agent-cloud-studio
   node scripts/clear-login-lock.mjs            # 解除所有锁定和错误计数
   node scripts/clear-login-lock.mjs andrew     # 只解除某个用户名
   ```

   脚本读取和服务器相同的数据库（环境变量或 `.env` 里的 `DATABASE_PATH`，默认 `~/.cloudcli/auth.db`），
   立即生效，无需重启。等价的一行命令（在应用目录里运行；`.env` 里改过 `DATABASE_PATH` 的话先 `export DATABASE_PATH=...`）：

   ```bash
   node -e "const D=require('better-sqlite3');const p=process.env.DATABASE_PATH||require('os').homedir()+'/.cloudcli/auth.db';console.log(new D(p).prepare('DELETE FROM auth_login_lockouts').run().changes)"
   ```

4. **等待**：锁定到期自动解除（时间见登录页提示）。

注意：每个地址「10 分钟 5 次」的限流是内存里的，脚本清不掉；它 10 分钟后自动恢复，换个网络或用 Tailscale 入口也不受影响。

## 环境变量

本功能没有新增必填的环境变量。相关的已有变量：

| 变量 | 作用 |
| --- | --- |
| `STUDIO_PUBLIC_ORIGIN` / `STUDIO_TAILNET_ORIGIN` | 两个入口的地址；面容 ID 登录只在这两个地址可用，RP ID 就是它们的主机名。 |
| `STUDIO_CF_ACCESS_TEAM_DOMAIN` / `STUDIO_CF_ACCESS_AUD` | 让 Studio 自己核对 Cloudflare Access（见上文）。 |
| `STUDIO_TAILSCALE_LOGINS`（及 `_NODES`、`_USER`） | 允许免密码登录的 Tailscale 身份和设备，见 network.md。 |
| `DATABASE_PATH` | 数据库位置；锁定、通行密钥、事件日志和令牌版本都在这里。 |
| `JWT_SECRET` | 令牌签名密钥；更换它会让所有会话失效（「退出所有设备」不需要换它）。 |
