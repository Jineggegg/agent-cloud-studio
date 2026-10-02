# Trading 212 交易代理（studio-trader）

## 为什么要单独一个交易代理

拿到 Studio 会话的人，可以打开 Studio 的终端。这个终端和 Studio 是同一个系统用户（`laosong`），所以他能读 Studio 能读的每个文件、改 Studio 的数据库、连接 `laosong` 能连接的每个本地 socket。以前下单密钥（`STUDIO_T212_ENV_FILE`）就在其中，他可以直接读出密钥，绕过面容 ID 和单笔上限自己下单。

现在改成**两把密钥**：

| 密钥 | 放在哪里 | 权限 | 谁能读 |
| --- | --- | --- | --- |
| 读取密钥 | `STUDIO_T212_ENV_FILE` / `STUDIO_T212_DEMO_ENV_FILE`（Studio） | 只读：账户、持仓、历史、标的信息。**不要开 orders:execute** | `laosong` |
| 下单密钥 | `/var/lib/studio-trader/live.env`、`demo.env`（交易代理） | orders:execute，加上 account、portfolio、metadata 读取（交易代理要自己估值） | 只有 `studio-trader` 和 root |

交易代理是一个很小的独立程序，以专用系统用户 `studio-trader` 运行（systemd 系统服务）。它的状态目录 `/var/lib/studio-trader`（0700）里有下单密钥、它自己的 SQLite 数据库（通行密钥、注册码的哈希、待确认的挑战、下单审计）和配置 `config.json`。`laosong` 读不了也改不了其中任何东西。程序本身、它用的 Node 和依赖装在 root 所有的 `/opt/studio-trader`，`laosong` 和 `studio-trader` 都改不了代码。

## 怎么工作

1. Studio 通过 unix socket `/run/studio-trader/broker.sock`（组 `studio-broker`，0660）和交易代理说话，协议是 socket 上的 HTTP。`laosong` 在这个组里，所以终端也能连上，交易代理因此**不信任任何调用者**。
2. 预览：交易代理检查来源网址是否在它自己的白名单、账户是否允许、代码和数量格式，用**自己的下单密钥**读持仓和标的币种，自己按汇率估值并检查单笔上限和每小时笔数，然后生成一个只能用一次、60 秒过期、绑定这笔订单 + 网址 + RP ID 的挑战，返回 WebAuthn 验证参数。
3. 浏览器用面容 ID / 触控 ID 签名（必须验证用户）。Studio 把签名转给交易代理。
4. 交易代理用**自己数据库里的通行密钥**验证签名（计数器必须前进），挑战作废，然后用下单密钥**只下一次单**，结果记为 placed / rejected / unknown。实盘订单没有"二次确认"这条路；模拟盘只有在 `config.json` 里明确打开 `demoConfirmWithoutPasskey` 时才允许不用通行密钥。
5. 登记通行密钥需要一次性**注册码**：只能在服务器上以 `studio-trader` 身份生成，10 分钟有效，只能登记一把，数据库里只存哈希。`laosong` 生成不了。移除通行密钥需要同一网址任意一把通行密钥的签名，或者一个新的注册码。

终端里的攻击者能做的：读状态（允许的账户、上限、通行密钥列表）、生成会过期的预览。不能做的：读下单密钥、登记自己的通行密钥、伪造签名下单。

## 安装（只做一次）

### 0. 先确认隔离能成立

下面任何一条不满足，`laosong` 都能变成 root，交易代理也就保护不了密钥：

- **WSL 互操作必须关闭**：`/etc/wsl.conf` 里有 `[interop]` `enabled=false`，并且已经从 Windows 运行过 `wsl.exe --shutdown`。否则 Linux 里可以启动 `wsl.exe -u root`。检查：`cat /proc/sys/fs/binfmt_misc/WSLInterop` 不应显示 `enabled`。
- `laosong` 用 sudo 必须输入密码（`sudo -l` 里没有 `NOPASSWD`），并且不在 `docker`、`lxd`、`disk` 组。
- **不要在 Studio 终端或 laosong 的 shell 里输入 sudo 密码**：被入侵的 shell 配置可以记下它。所有管理操作都从 Windows PowerShell 用 `wsl.exe -d Ubuntu -u root -- …` 或 `-u studio-trader` 来做，下面的命令都是这样写的。
- 安装时代码来自 `laosong` 可写的仓库：只在你信任当前状态时安装（`git status` 干净、是你审阅过的提交）。

### 1. 在 Trading 212 准备两把密钥

- 把 Studio 现有的密钥换成**只读**密钥（不勾 orders:execute），放在 `STUDIO_T212_ENV_FILE` 指向的文件里。
- 新建一把**下单密钥**（orders:execute + account + portfolio + metadata），可以的话加 IP 限制。不要把它存在 `laosong` 能读的地方（包括 `/mnt/c` 下的 Windows 文件夹）。

### 2. 构建并安装（Windows PowerShell）

```powershell
wsl.exe -d Ubuntu --cd /home/laosong/projects/agent-cloud-studio -e bash -lc "npm run build:server"
wsl.exe -d Ubuntu -u root -- bash /home/laosong/projects/agent-cloud-studio/scripts/wsl/install-t212-broker.sh `
  --studio-user laosong --origins https://studio.ajarche.com,https://<机器名>.<tailnet>.ts.net:8443 --allowed-envs demo
```

脚本会：创建 `studio-trader` 用户和 `studio-broker` 组，把 `laosong` 加进组；建 `/var/lib/studio-trader`（0700）；没有 `config.json` 时按参数写一个；把程序、Node 和依赖复制到 root 所有的 `/opt/studio-trader`；安装并启用 `studio-trader-broker.socket` 和 `studio-trader-broker.service`（NoNewPrivileges、ProtectSystem=strict、ProtectHome、只允许写 `/var/lib/studio-trader`、PrivateTmp 等加固）；最后自检。它会提醒上面第 0 步里不满足的项。

已经有下单密钥文件时可以加 `--live-key-file /path/live.env --remove-source`，但更推荐下一步直接输入。

### 3. 写入下单密钥（输入时不回显）

```powershell
wsl.exe -d Ubuntu -u studio-trader -e /opt/studio-trader/bin/studio-trader set-key live
wsl.exe -d Ubuntu -u studio-trader -e /opt/studio-trader/bin/studio-trader set-key demo
```

### 4. 配置交易代理

`/var/lib/studio-trader/config.json`（以 root 编辑，改完重启交易代理）：

```json
{
  "allowedEnvs": ["demo"],
  "maxOrderValue": 500,
  "maxOrdersPerHour": 10,
  "origins": ["https://studio.ajarche.com", "https://<机器名>.<tailnet>.ts.net:8443"],
  "demoConfirmWithoutPasskey": false
}
```

- `allowedEnvs`：允许下单的账户，`[]` 表示关闭。
- `maxOrderValue`：单笔上限（账户货币），交易代理按自己读到的持仓和汇率估值；没法换算汇率的订单直接拒绝。
- `origins`：允许下单和登记通行密钥的网址，必须和浏览器地址栏的来源完全一致（HTTPS，结尾没有 `/`；只有 localhost 可以用 HTTP）。
- 不认识的字段或不合法的值会让交易代理拒绝启动，而不是退回到更宽松的设置。

```powershell
wsl.exe -d Ubuntu -u root -- nano /var/lib/studio-trader/config.json
wsl.exe -d Ubuntu -u root -- systemctl restart studio-trader-broker.service
wsl.exe -d Ubuntu -u studio-trader -e /opt/studio-trader/bin/studio-trader check
```

### 5. 让 Studio 连上交易代理

1. 在 Studio 的 `.env` 里设置 `STUDIO_T212_BROKER_SOCKET=/run/studio-trader/broker.sock`。旧的 `STUDIO_T212_TRADING`、`STUDIO_T212_MAX_ORDER_VALUE`、`STUDIO_T212_REQUIRE_PASSKEY`、`STUDIO_T212_ALLOW_LOCALHOST` 已经不用了，可以删掉。
2. 从 Windows 运行 `wsl.exe --shutdown`，再打开 WSL：Studio 是 `laosong` 的用户服务，要重新登录后才拿到新加入的 `studio-broker` 组。
3. 打开 Studio「设置 → 交易安全」，「交易代理」应显示「已连接」。

### 6. 为每个网址登记通行密钥

通行密钥按网址（RP ID）区分，公网域名和 Tailscale 地址要分别登记。

```powershell
wsl.exe -d Ubuntu -u studio-trader -e /opt/studio-trader/bin/studio-trader enroll-code
```

把显示的注册码（形如 `ABCDE-FGHJK-MNPQR-STVWX`，10 分钟内有效，只显示这一次）输入 Studio「设置 → 交易安全」，再用面容 ID / 触控 ID 完成登记。取消面容 ID 不会浪费注册码；登记成功后它就失效了。**每次登记后**都核对一下列表里只有你自己的设备：

```powershell
wsl.exe -d Ubuntu -u studio-trader -e /opt/studio-trader/bin/studio-trader passkeys
```

## 日常操作

| 要做的事 | 命令（Windows PowerShell） |
| --- | --- |
| 生成注册码 | `wsl.exe -d Ubuntu -u studio-trader -e /opt/studio-trader/bin/studio-trader enroll-code` |
| 查看通行密钥 | `… studio-trader passkeys` |
| 直接移除一把通行密钥（比如设备丢了） | `… studio-trader revoke-passkey <id>` |
| 查看最近的下单审计 | `… studio-trader audit --limit 50` |
| 查看日志 | `wsl.exe -d Ubuntu -u root -- journalctl -u studio-trader-broker -n 100` |
| 更新交易代理代码 | 先 `npm run build:server`，再重新运行安装脚本（保留状态和配置） |

日志只记录事件（请求路径、状态码、通行密钥登记/移除、订单结果），不记录密钥、注册码或请求内容。

## 轮换密钥

- **下单密钥**：在 Trading 212 新建一把，运行 `studio-trader set-key live`（或 `demo`）写入，不需要重启，下一笔订单就会使用新密钥；确认能用后在 Trading 212 删除旧密钥。怀疑泄露时先在 Trading 212 删除旧密钥。
- **读取密钥**：在 Trading 212 新建一把只读密钥，替换 `STUDIO_T212_ENV_FILE` 指向的文件内容（Studio 每次请求都重新读取），然后删除旧密钥。
- 迁移完成后，旧的、带 orders:execute 的 Studio 密钥一定要在 Trading 212 里删除：它可能已经被复制过。

## 验证隔离

在 Studio 终端（也就是 `laosong`）里运行，下面每一条都应该失败或被拒绝：

```bash
cat /var/lib/studio-trader/live.env          # Permission denied
ls /var/lib/studio-trader                    # Permission denied
touch /opt/studio-trader/app/main.js         # Permission denied（代码是 root 的）
sudo -n true                                 # 需要密码
cat /proc/sys/fs/binfmt_misc/WSLInterop      # 不应显示 enabled

S=/run/studio-trader/broker.sock
curl -s --unix-socket $S http://broker/v1/status          # 可以读状态（只读）
# 没有通行密钥签名的预览/确认/登记都会被拒绝：
curl -s --unix-socket $S -H 'Content-Type: application/json' \
  -d '{"origin":"https://studio.ajarche.com","id":"00000000-0000-0000-0000-000000000000","confirmed":true}' \
  http://broker/v1/orders/confirm                         # 404 / T212_PREVIEW_GONE
curl -s --unix-socket $S -H 'Content-Type: application/json' \
  -d '{"origin":"https://studio.ajarche.com","enrollmentCode":"AAAAA-AAAAA-AAAAA-AAAAA"}' \
  http://broker/v1/passkeys/registration-options           # 403 / T212_ENROLL_CODE_INVALID
```

再确认没有遗留的下单密钥副本（只列文件名，不打印内容）：

```bash
grep -rl TRADING212_API_SECRET ~ /mnt/c/Users 2>/dev/null
```

列出的文件应该只含只读密钥。也可以运行 `wsl.exe -d Ubuntu -u root -- systemd-analyze security studio-trader-broker` 看服务的加固评分。

## 仍然存在的风险

- **被篡改的 Studio 界面可以骗你确认另一笔订单。** 面容 ID 弹窗不显示订单内容；能改 Studio 前端或服务端代码的人，可以给你看订单 A，却让交易代理为订单 B 生成挑战。交易代理的单笔上限、每小时笔数和允许的账户限制了损失，审计记录了真实下的单。下单后留意 Trading 212 App 的通知。
- **在 Studio 里输入的注册码可能被截获。** 被入侵的 Studio 可以抢先用它登记攻击者的通行密钥。所以每次登记后都运行 `studio-trader passkeys` 核对，有陌生的就 `revoke-passkey`。
- **拒绝服务。** 终端里的人可以停掉 Studio、刷满失败次数（触发 15 分钟锁定）或占满待确认挑战；这些都不会让他下单。
- **root 和 Windows。** WSL 里的 root、能运行 `wsl.exe -u root` 的 Windows 用户，以及 Windows 盘上的密钥副本，都在这个隔离之外。

## 故障排查

- 设置里显示「未安装」：Studio 的 `.env` 没有 `STUDIO_T212_BROKER_SOCKET`，或 Studio 没有重启。
- 显示「无法连接」：`systemctl status studio-trader-broker.socket studio-trader-broker.service`；如果提示无权连接，确认 `id laosong` 里有 `studio-broker`，并在加组后运行过 `wsl.exe --shutdown`。
- 交易代理起不来：`journalctl -u studio-trader-broker`，多半是 `config.json` 有不认识的字段或值不合法；`studio-trader check` 会说明原因。
- 「当前网址不在交易代理的白名单」：把浏览器地址栏里的来源原样加入 `config.json` 的 `origins`，重启交易代理。
