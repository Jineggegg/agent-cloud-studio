# Trading 212 交易代理（studio-trader）

## 为什么要单独一个交易代理

拿到 Studio 会话的人，可以打开 Studio 的终端。这个终端和 Studio 是同一个系统用户（`laosong`），所以他能读 Studio 能读的每个文件、改 Studio 的数据库、连接 `laosong` 能连接的每个本地 socket。以前下单密钥（`STUDIO_T212_ENV_FILE`）就在其中，他可以直接读出密钥，绕过面容 ID 和单笔上限自己下单。

现在改成**两把密钥**：

| 密钥 | 放在哪里 | 权限 | 谁能读 |
| --- | --- | --- | --- |
| 读取密钥 | `STUDIO_T212_ENV_FILE` / `STUDIO_T212_DEMO_ENV_FILE`（Studio，放在 WSL 里） | 只读：账户、持仓、历史、标的信息。**不要开 orders:execute** | `laosong` |
| 下单密钥 | `/var/lib/studio-trader/live.env`、`demo.env`（交易代理） | orders:execute，加上 account、portfolio、metadata 读取（交易代理要自己估值） | 只有 `studio-trader` 和 root |

交易代理是一个很小的独立程序，以专用系统用户 `studio-trader` 运行（systemd 系统服务）。它的状态目录 `/var/lib/studio-trader`（0700）里有下单密钥、它自己的 SQLite 数据库（通行密钥、注册码的哈希、待确认的挑战、下单审计）和配置 `config.json`。`laosong` 读不了也改不了其中任何东西。程序本身、它用的 Node 和依赖装在 root 所有的 `/opt/studio-trader`，由安装脚本从**你审阅过的提交**重新构建，`laosong` 和 `studio-trader` 都改不了。

## 威胁模型

- **不可信**：任何能以 `laosong` 身份执行代码的东西——Studio 终端、被篡改的 Studio 前端或服务端、`laosong` 的 shell 配置文件、`laosong` 可写的仓库、`dist-server/` 和 `node_modules/`。
- **可信**：WSL 的 root、`studio-trader`、Windows 用户本身（它随时可以 `wsl.exe -u root`）、你在 GitHub 上审阅过的提交、nodejs.org 公布的 SHA-256、`package-lock.json` 里的完整性哈希、Trading 212。
- **要做到的**：`laosong` 读不到下单密钥；没有你本人的面容 ID / 触控 ID 签名就下不了单，而且每笔、每天、每小时都有交易代理自己执行的上限；登记新的通行密钥需要只有通过 sudo 才能生成的一次性注册码。
- **做不到的**：root 或 Windows 用户被攻破之后的一切；只读密钥（`laosong` 本来就能用）；被篡改的 Studio 在面容 ID 弹窗背后换订单（见「仍然存在的风险」，只能限幅）。
- **前提**：`laosong` 不能变成 root，也不能变成 Windows 用户（第 0 步）。不满足时交易代理和设置页都会显示「隔离无效」，安装脚本会拒绝安装。

## 怎么工作

1. Studio 通过 unix socket `/run/studio-trader/broker.sock`（组 `studio-broker`，0660）和交易代理说话，协议是 socket 上的 HTTP。`laosong` 在这个组里，所以终端也能连上，交易代理因此**不信任任何调用者**。
2. 预览：交易代理检查来源网址是否在它自己的白名单、账户是否允许、代码和数量格式，用**自己的下单密钥**读持仓和标的币种，自己按汇率估值并检查单笔上限、每小时笔数、每日累计上限和实盘冷却，然后生成一个只能用一次、60 秒过期、绑定这笔订单 + 网址 + RP ID 的挑战，返回 WebAuthn 验证参数。
3. 浏览器用面容 ID / 触控 ID 签名（必须验证用户）。Studio 把签名转给交易代理。
4. 交易代理用**自己数据库里的通行密钥**验证签名（计数器必须前进），挑战作废，然后用下单密钥**只下一次单**，结果记为 placed / rejected / unknown。实盘订单没有「二次确认」这条路；模拟盘只有在 `config.json` 里明确打开 `demoConfirmWithoutPasskey` 时才允许不用通行密钥。连接在确认途中断开时，Studio 显示「订单状态未知」，不会自动重试。
5. 登记通行密钥需要一次性**注册码**：只能以 `studio-trader` 身份生成（`sudo -u studio-trader … enroll-code`，要输入你的 sudo 密码），10 分钟有效，只能登记一把，数据库里只存哈希。`laosong` 生成不了。移除通行密钥需要同一网址任意一把通行密钥的签名，或者一个新的注册码。

终端里的攻击者能做的：读状态（允许的账户、上限、通行密钥列表、隔离状态）、生成会过期的预览。不能做的：读下单密钥、登记自己的通行密钥（没有注册码）、伪造签名下单。

## 安装（只做一次）

下面所有命令都在 **Windows PowerShell** 里输入。需要 root 的地方一律用 WSL 里的 `sudo`，由你自己输入 sudo 密码。**不要在 Studio 终端里输入 sudo 密码**（被入侵的 shell 配置可以记下它），也不要在 `laosong` 的交互 shell 里输入；`wsl.exe -e` 直接运行命令，不经过 `laosong` 的 shell 配置文件。

### 0. 先让隔离成立

下面任何一条不满足，`laosong` 都能变成 root 或 Windows 用户，交易代理也就保护不了密钥。

**WSL 互操作（Linux 里启动 Windows 程序）。** 2026-10-02 在这台机器上实测（WSL 3.0.1.0，`systemd=true`，`/etc/wsl.conf` 里已经有 `[interop] enabled=false`）：

- `/proc/sys/fs/binfmt_misc/WSLInterop` 仍然是 `enabled`（flags `PF`，interpreter `/init`），`systemd-binfmt.service` 处于 failed；
- `/run/WSL/2_interop` 是 `srwxrwxrwx root`，`1_interop` 是指向它的链接；
- 以 `laosong` 启动 Windows 程序——不论经过 binfmt（`/mnt/c/Windows/System32/whoami.exe`），还是直接调用解释器（`/init /mnt/c/Windows/System32/cmd.exe /c echo x`，带不带 `WSL_INTEROP=/run/WSL/2_interop`）——都在约 10 秒后报 `UtilAcceptVsock:281: accept4 failed 110`，也就是**目前是 Windows 一侧拒绝了互操作**。

这个拒绝**不能依赖**：它取决于 WSL 的版本和 Windows 侧的实现，一次更新就可能变。还要注意，直接运行 `/init <程序.exe>` 根本不经过 binfmt 处理器，只要能连上 `/run/WSL` 里的 socket 就行——**只移除处理器是不够的**。所以安装脚本装了一个开机服务 `studio-trader-isolation.service`（root 所有的 `/opt/studio-trader/bin/studio-trader-isolation`），每次开机在交易代理之前运行（`systemd-binfmt` 被重启后也会再运行一次）：

1. 移除 `WSLInterop` 处理器（部分版本还有 `WSLInterop-late`），写 `-1`；
2. 把 `/run/WSL` 改成 `root:root 0700`：非 root 进程连不上里面任何 socket，包括 WSL 以后为新会话创建的；
3. 核对这两项，任何一项没做到就以失败退出（`systemctl status studio-trader-isolation` 显示 failed）。

安装脚本在检查隔离之前，会先对本次开机执行一次同样的操作。`/etc/wsl.conf` 里的 `[interop] enabled=false` 仍然要写（多一层），但不依赖它。

交易代理只看实际状态（`studio-trader check`、`GET /v1/status`、Studio「设置 → 交易安全」）：处理器启用，**或者**有非 root 用户能用的互操作 socket（`/run/WSL` 对其他人可进入、socket 对其他人可写），**或者**读不到这些状态，都算「隔离无效」。socket 仅仅存在不算——加锁之后它们还在，只是碰不到。

副作用：WSL 里不能再启动 Windows 程序（`code .`、`explorer.exe`、`clip.exe`、`powershell.exe`、`wslview` 等）。从 Windows 进入 WSL（`wsl.exe …`、Windows Terminal）不受影响。

**Windows 盘不能对 `laosong` 可写。** 现在 `/mnt/c`（以及 D:、E:、F:）以 `uid=1000` 挂载，`laosong` 能写 `C:\Users\laosong`，包括启动项目录（`AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`）、PowerShell 配置文件和 `.wslconfig`。放进去的东西会在你下次登录 Windows、打开 PowerShell 或重启 WSL 时以 Windows 用户身份运行，而 Windows 用户可以 `wsl.exe -u root`，绕过上面所有的锁。安装脚本**不会修改** `/etc/wsl.conf`，只打印需要的几行，并在它们生效之前拒绝安装。用 sudo 编辑：

```powershell
wsl.exe -d Ubuntu --cd / -e sudo nano /etc/wsl.conf
```

确保里面有（`[boot] systemd=true` 等其他段保留不动）：

```ini
[interop]
enabled = false
appendWindowsPath = false

[automount]
options = "uid=0,gid=0,umask=022,fmask=133"
# 或者干脆不挂载 Windows 盘：
# enabled = false
```

然后 `wsl.exe --shutdown`，再打开 WSL。不要加 `metadata`：有了它，文件会带自己的 Linux 属主和权限，以前留下的可能仍然可写（交易代理会把带 `metadata` 的盘报告为无效）。

代价：

- `uid=0,gid=0,umask=022,fmask=133`：Windows 盘对所有 Linux 普通用户**只读**（目录 755、文件 644，属主 root）；`enabled = false`：WSL 里完全看不到 Windows 盘。
- Studio（`laosong`）不能再写 `/mnt/c` 下的任何文件。目前 Trading 212 的密钥文件放在 `/mnt/c` 上，**要搬进 WSL**：只读密钥放在 `laosong` 自己的目录（例如 `~/.config/agent-cloud-studio/t212-read.env`，0600），并修改 `STUDIO_T212_ENV_FILE`；下单密钥**不要搬**，换一把新的，用 `studio-trader set-key` 直接输入交易代理（第 3 步）。
- 用 `uid=0` 这一种时，Windows 盘对所有 Linux 用户仍然可读：旧密钥的副本仍可能被读到。所以旧的、带 orders:execute 的密钥必须在 Trading 212 里删除（第 7 步）。

**其他条件：**

- `laosong` 用 sudo 必须输入密码（`sudo -l` 里没有 `NOPASSWD`），并且不在 `docker`、`lxd`、`incus`、`disk`、`libvirt` 组。
- 安装用的代码不能来自 `laosong` 可写的工作区：`git status` 干净也不够，`dist-server/` 和 `node_modules/` 不受 git 管理，可以被悄悄植入后门。安装脚本因此只认一个**提交 SHA**：以 root 用 `git clone --mirror --no-local` 把仓库复制到 root 专用的临时目录（不在 `laosong` 的仓库里运行任何 git 命令，只用为不可信仓库设计的 `git upload-pack` 读取对象），用 `git archive` 导出这个提交，由一个临时系统用户 `studio-trader-build` 在导出的目录里构建（`npm ci --ignore-scripts` 按 `package-lock.json` 的完整性哈希安装，better-sqlite3 用 node-gyp 从源码编译，`tsc` 只编译交易代理），用的是你核对过 SHA-256 的 Node.js 官方压缩包。`laosong` 的 node、shell 配置、`dist-server/`、`node_modules/` 全都不用。安装脚本本身也必须来自这个提交，所以第 2 步用一条命令先以 root 导出它再运行。

### 1. 准备

1. **Trading 212**：把 Studio 现在用的密钥换成**只读**密钥（不勾 orders:execute），文件放进 WSL（见上面的「代价」）。下单密钥等第 3 步再建。
2. **构建工具**（better-sqlite3 要从源码编译）：

   ```powershell
   wsl.exe -d Ubuntu --cd / -e sudo apt-get install -y git build-essential python3
   ```

3. **Node.js 官方压缩包**（20 或更新，建议和 Studio 同一个大版本，现在是 24）：把 `vX.Y.Z` 换成具体版本。压缩包放在哪里都行，安装脚本只认 SHA-256。

   ```powershell
   wsl.exe -d Ubuntu --cd /home/laosong -e curl -fLO https://nodejs.org/dist/vX.Y.Z/node-vX.Y.Z-linux-x64.tar.xz
   ```

   SHA-256 **在浏览器里**打开 `https://nodejs.org/dist/vX.Y.Z/SHASUMS256.txt`，复制 `node-vX.Y.Z-linux-x64.tar.xz` 那一行前面的 64 位十六进制。不要用 WSL 里算出来的值：那只说明文件没变，不说明它是官方的。
4. **要安装的提交**：在 GitHub 上打开你审阅过的提交（例如合并这个功能的那次合并提交），复制完整的 40 位 SHA。同样不要从 WSL 里复制。

### 2. 检查并安装

在同一个 PowerShell 窗口里依次执行（`$boot` 那一行原样复制）：

```powershell
$repo = '/home/laosong/projects/agent-cloud-studio'
$sha  = '<在 GitHub 上审阅过的提交的完整 40 位 SHA>'
$boot = 'set -euf -o pipefail; umask 077; w=$(mktemp -d /root/studio-trader-boot.XXXXXX); trap ''rm -rf -- $w'' EXIT; git -c safe.directory=* clone -q --mirror --no-local -- $1 $w/repo.git; git -C $w/repo.git archive $2 scripts/wsl | tar -x -C $w; bash $w/scripts/wsl/install-t212-broker.sh --repo $1 --commit $2 ${@:3}'

# 先只检查隔离（不改任何东西）
wsl.exe -d Ubuntu --cd / -e sudo /bin/bash -c $boot boot $repo $sha --studio-user laosong --check-only

# 再安装
wsl.exe -d Ubuntu --cd / -e sudo /bin/bash -c $boot boot $repo $sha `
  --studio-user laosong `
  --origins 'https://studio.ajarche.com,https://<机器名>.<tailnet>.ts.net:8443' `
  --node-tarball /home/laosong/node-vX.Y.Z-linux-x64.tar.xz `
  --node-sha256 '<SHASUMS256.txt 里那 64 位>'
```

`$boot` 以 root 把仓库镜像到 `/root` 下的临时目录，从 `$sha` 导出 `scripts/wsl`，再运行**导出的**安装脚本（安装脚本发现自己在别人可写的目录里会拒绝运行）。`--check-only` 只做检查：互操作处理器和 `/run/WSL` 这两项由安装本身修好，可以先不管；其他项（Windows 盘、sudo、组）必须先修好。

安装脚本依次：

1. 检查参数和构建工具；对本次开机执行 `studio-trader-isolation`（移除互操作处理器、锁 `/run/WSL`）；
2. **检查隔离**，有任何问题就列出问题和需要的 `/etc/wsl.conf` 内容，然后**拒绝安装**。只有显式加 `--accept-insecure` 才会继续，并醒目地警告交易代理此时保护不了密钥——不要这样做；
3. 镜像仓库，导出 `$sha`，打印提交标题和作者（`--commit` 不是完整 SHA 时会让你确认）；
4. 校验 Node 压缩包的 SHA-256，解压到 root 专用目录；
5. 以临时用户 `studio-trader-build` 构建（需要联网访问 npm）；结束后杀掉它的所有进程并删除这个用户；
6. 把结果复制成 root 所有的新目录，拒绝其中任何符号链接、FIFO、socket、设备文件和 setuid/setgid 位，检查每个文件都只有 root 能改，再替换 `/opt/studio-trader`（`/opt/studio-trader/COMMIT` 记着提交）；
7. 创建 `studio-trader` 用户和 `studio-broker` 组，把 `laosong` 加进组；建 `/var/lib/studio-trader`（0700）；**只在没有 `config.json` 时**按参数写一个（见第 4 步）；
8. 安装并启用 `studio-trader-isolation.service`、`studio-trader-broker.socket` 和 `studio-trader-broker.service`（NoNewPrivileges、ProtectSystem=strict、ProtectHome、只允许写 `/var/lib/studio-trader`、PrivateTmp 等加固），启动它们；
9. 以 `studio-trader` 运行 `studio-trader check` 自检，打印下一步。

脚本从不修改 `/etc/wsl.conf`，从不打印密钥。重复运行就是升级（见「升级」），状态目录、密钥和 `config.json` 保持不变。

### 3. 写入新的下单密钥（输入时不回显）

在 Trading 212 新建一把**下单密钥**（orders:execute + account + portfolio + metadata，可以的话加 IP 限制），**只**输入到这里，不要存成文件：

```powershell
wsl.exe -d Ubuntu --cd / -e sudo -u studio-trader /opt/studio-trader/bin/studio-trader set-key live
wsl.exe -d Ubuntu --cd / -e sudo -u studio-trader /opt/studio-trader/bin/studio-trader set-key demo
wsl.exe -d Ubuntu --cd / -e sudo -u studio-trader /opt/studio-trader/bin/studio-trader check
```

`check` 末尾应当是「隔离：有效」，并且退出码为 0；隔离无效、缺密钥或没有 origins 时它会说明原因并返回 1。

### 4. 配置交易代理

`/var/lib/studio-trader/config.json`，安装脚本新写的内容如下（括号里是对应的安装参数）。字段缺省时交易代理用同样的默认值，只有 `allowedEnvs` 和 `origins` 缺省为空（不能下单）：

```json
{
  "allowedEnvs": ["demo"],
  "maxOrderValue": 500,
  "maxDailyOrderValue": 2000,
  "liveOrderCooldownSeconds": 60,
  "maxOrdersPerHour": 10,
  "origins": ["https://studio.ajarche.com", "https://<机器名>.<tailnet>.ts.net:8443"],
  "demoConfirmWithoutPasskey": false
}
```

- `allowedEnvs`（`--allowed-envs`，默认 `demo`）：允许下单的账户，`[]` 表示关闭。确认一切正常之后再加 `"live"`。
- `maxOrderValue`（`--max-order-value`，默认 500）：单笔上限（账户货币），交易代理按自己读到的持仓和汇率估值；没法换算汇率的订单直接拒绝。
- `maxDailyOrderValue`（`--max-daily-order-value`，默认 2000）：滚动 24 小时内已提交订单的累计金额上限，`0` 表示不启用。
- `liveOrderCooldownSeconds`（`--live-cooldown-seconds`，默认 60）：两笔实盘订单之间的最小间隔秒数，`0` 表示不启用；模拟盘不受影响。
- `maxOrdersPerHour`（`--max-orders-per-hour`，默认 10）：每滚动小时最多提交的订单数。
- `origins`（`--origins`）：允许下单和登记通行密钥的网址，必须和浏览器地址栏的来源完全一致（HTTPS，结尾没有 `/`；只有 localhost 可以用 HTTP）。
- `demoConfirmWithoutPasskey`：只对模拟盘有效，默认 `false`。
- 后四个上限一起限制「被诱导确认」能造成的损失（见「仍然存在的风险」）。不认识的字段或不合法的值会让交易代理拒绝启动，而不是退回到更宽松的设置。

修改：

```powershell
wsl.exe -d Ubuntu --cd / -e sudo nano /var/lib/studio-trader/config.json
wsl.exe -d Ubuntu --cd / -e sudo systemctl restart studio-trader-broker.service
wsl.exe -d Ubuntu --cd / -e sudo -u studio-trader /opt/studio-trader/bin/studio-trader check
```

### 5. 让 Studio 连上交易代理

1. 在 Studio 的 `.env` 里设置 `STUDIO_T212_BROKER_SOCKET=/run/studio-trader/broker.sock`，`STUDIO_T212_ENV_FILE`（和 `STUDIO_T212_DEMO_ENV_FILE`）指向 WSL 里的**只读**密钥文件。旧的 `STUDIO_T212_TRADING`、`STUDIO_T212_MAX_ORDER_VALUE`、`STUDIO_T212_REQUIRE_PASSKEY`、`STUDIO_T212_ALLOW_LOCALHOST` 已经不用了，可以删掉。
2. 从 Windows 运行 `wsl.exe --shutdown`，再打开 WSL：Studio 是 `laosong` 的用户服务，要重新登录后才拿到新加入的 `studio-broker` 组。
3. 打开 Studio「设置 → 交易安全」，「交易代理」应显示「已连接」，并且没有「隔离无效」。

### 6. 为每个网址登记通行密钥

通行密钥按网址（RP ID）区分，公网域名和 Tailscale 地址要分别登记。注册码只能通过 sudo 生成：

```powershell
wsl.exe -d Ubuntu --cd / -e sudo -u studio-trader /opt/studio-trader/bin/studio-trader enroll-code
```

把显示的注册码（形如 `ABCDE-FGHJK-MNPQR-STVWX`，10 分钟内有效，只显示这一次）输入 Studio「设置 → 交易安全」，再用面容 ID / 触控 ID 完成登记。取消面容 ID 不会浪费注册码；登记成功后它就失效了。记下你按下面容 ID 的时间。

**每次登记后**都用 CLI 核对，而且要看对地方：

```powershell
wsl.exe -d Ubuntu --cd / -e sudo -u studio-trader /opt/studio-trader/bin/studio-trader passkeys
```

- 列表里的**名称（label）是 Studio 传来的，被入侵的 Studio 可以随意伪造**（比如显示成「iPad」）。如果注册码在被入侵的 Studio 里输入，攻击者可以抢先用自己的软件认证器登记一把，并给你看「登记成功」；因为一个码只登记一把，数量也会和预期一样。所以**名字和数量对，证明不了什么**。
- 要核对的是交易代理自己记录、Studio 改不了的信息：
  - `AAGUID`：认证器型号。iPhone / iPad / Mac 的平台通行密钥通常是全 0 或一个固定值；和你之前登记过的设备对比，软件认证器往往不同。
  - `凭据 ID 前缀`：每把都不同，用来认出哪一把是刚登记的。
  - `单设备` / `可同步(多设备)` 和 `已备份`（WebAuthn 的 BE/BS 标志）：iCloud 钥匙串里的通行密钥一般是「可同步、已备份」；同一台设备再次登记却出现了不同的标志，值得警惕。
  - `登记` 时间（精确到秒）：应当正好是你按下面容 ID 的时间。
- 有任何一项对不上：立即 `revoke-passkey <id>` 移除它，换一把下单密钥（第 3 步），再重新登记。

### 7. 删除旧的下单密钥

确认新的下单密钥能用之后，在 Trading 212 里**删除旧的、带 orders:execute 的密钥**：它一直放在 `laosong` 能读的地方（`/mnt/c`），可能早已被复制。

## 日常操作

| 要做的事 | 命令（Windows PowerShell） |
| --- | --- |
| 生成注册码 | `wsl.exe -d Ubuntu --cd / -e sudo -u studio-trader /opt/studio-trader/bin/studio-trader enroll-code` |
| 查看通行密钥 | 同上，把 `enroll-code` 换成 `passkeys` |
| 直接移除一把通行密钥（比如设备丢了） | 同上，`revoke-passkey <id>` |
| 查看最近的下单审计 | 同上，`audit --limit 50` |
| 检查配置、密钥文件和隔离 | 同上，`check` |
| 查看日志 | `wsl.exe -d Ubuntu --cd / -e sudo journalctl -u studio-trader-broker -n 100` |
| 查看开机隔离 | `wsl.exe -d Ubuntu --cd / -e systemctl status studio-trader-isolation` |

日志只记录事件（请求路径、状态码、通行密钥登记/移除及其 AAGUID 和标志、订单结果），不记录密钥、注册码或请求内容。

## 升级

审阅新的提交，然后用第 2 步同样的命令，把 `$sha` 换成新提交的完整 SHA（`--origins` 等只在没有 `config.json` 时才用得上，可以照抄）。脚本会重新检查隔离、重新构建并替换 `/opt/studio-trader`，状态目录、密钥和 `config.json` 不变。`/opt/studio-trader/COMMIT` 记着当前安装的提交。

## 轮换密钥

- **下单密钥**：在 Trading 212 新建一把，用 `sudo -u studio-trader … set-key live`（或 `demo`）写入，不需要重启，下一笔订单就会使用新密钥；确认能用后在 Trading 212 删除旧密钥。怀疑泄露时**先**在 Trading 212 删除旧密钥。
- **读取密钥**：在 Trading 212 新建一把只读密钥，替换 `STUDIO_T212_ENV_FILE` 指向的文件内容（Studio 每次请求都重新读取），然后删除旧密钥。
- 迁移到交易代理时：Studio 原来的密钥换成只读的；新的下单密钥只经 `set-key` 进入交易代理；旧的、带 orders:execute 的密钥在 Trading 212 里删除（第 7 步）。

## 验证隔离

在 Studio 终端（也就是 `laosong`）里运行，下面每一条都应该失败或被拒绝：

```bash
cat /var/lib/studio-trader/live.env          # Permission denied
ls /var/lib/studio-trader                    # Permission denied
touch /opt/studio-trader/app/main.js         # Permission denied（代码是 root 的）
sudo -n true                                 # 需要密码

# 互操作：处理器和 socket 两处都要看，缺一不可
cat /proc/sys/fs/binfmt_misc/WSLInterop      # No such file or directory（处理器已移除）
stat -c '%U:%G %a' /run/WSL                  # root:root 700
ls /run/WSL                                  # Permission denied
/init /mnt/c/Windows/System32/cmd.exe /c echo x   # 应当失败：连不上 /run/WSL 里的 socket（Windows 盘不挂载时文件不存在，也算失败）

# Windows 盘：对 laosong 应当不可写（enabled=false 时 /mnt/c 不存在）
touch /mnt/c/Users/laosong/test 2>&1          # Permission denied / No such file or directory
grep -E ' (9p|drvfs|virtiofs) ' /proc/self/mounts   # 每个 aname=drvfs 都应有 uid=0;gid=0，且没有 metadata

S=/run/studio-trader/broker.sock
curl -s --unix-socket $S http://broker/v1/status          # 可以读状态（只读）；isolation.ok 应为 true
# 没有通行密钥签名的确认、没有注册码的登记都会被拒绝：
curl -s --unix-socket $S -H 'Content-Type: application/json' \
  -d '{"origin":"https://studio.ajarche.com","id":"00000000-0000-0000-0000-000000000000","confirmed":true}' \
  http://broker/v1/orders/confirm                         # 404 / T212_PREVIEW_GONE
curl -s --unix-socket $S -H 'Content-Type: application/json' \
  -d '{"origin":"https://studio.ajarche.com","enrollmentCode":"AAAAA-AAAAA-AAAAA-AAAAA"}' \
  http://broker/v1/passkeys/registration-options           # 403 / T212_ENROLL_CODE_INVALID
```

在 PowerShell 里：

```powershell
wsl.exe -d Ubuntu --cd / -e sudo -u studio-trader /opt/studio-trader/bin/studio-trader check   # 「隔离：有效」，退出码 0
wsl.exe -d Ubuntu --cd / -e systemctl status studio-trader-isolation                            # active (exited)
wsl.exe -d Ubuntu --cd / -e cat /opt/studio-trader/COMMIT                                        # 等于你审阅过的 SHA
```

再确认 WSL 里没有遗留的下单密钥副本（只列文件名，不打印内容）：

```bash
grep -rl TRADING212_API_SECRET ~ 2>/dev/null
```

列出的文件应该只含只读密钥。Windows 一侧（下载目录、同步盘、备份）也要找一遍旧的密钥文件并删除。也可以运行 `wsl.exe -d Ubuntu --cd / -e sudo systemd-analyze security studio-trader-broker` 看服务的加固评分。

## 仍然存在的风险

- **被篡改的 Studio 可以在任何一次面容 ID 弹窗背后换成攻击者的订单——不只是你下单的时候。** RP ID 就是 Studio 的网址，它的前端和服务端都由 `laosong` 控制。攻击者可以自己向交易代理发起 `/v1/orders/preview`（任何能连上 socket 的人都能），拿到挑战后在 Studio 页面上**随时**弹出 `navigator.credentials.get`：伪装成「会话过期，请重新验证」「移除通行密钥」，或者就在你自己下单的时候。面容 ID 弹窗不显示订单内容，你每按一次，就可能成交一笔攻击者的订单。
  限制损失的是交易代理自己执行、Studio 改不了的：单笔上限（默认 500）、每日累计上限（默认 2000）、每小时笔数（默认 10）、实盘冷却（默认 60 秒）、只允许 `allowedEnvs` 里的账户，以及记录真实下单的审计。下单后留意 Trading 212 App 的通知，定期看 `audit`。这些只是限幅，**不能阻止**调包；根治需要一个 `laosong` 控制不了的确认通道（交易代理自己在独立主机名上提供确认页、TLS 由 root 所有的代理终止，或带订单详情的带外确认），**尚未实现**。
- **在 Studio 里输入的注册码可能被劫持，而且从名称和数量上看不出来。** 被入侵的 Studio 可以抢先用它登记攻击者自己的软件认证器，并伪造成功界面。每次登记后按第 6 步核对 AAGUID、凭据 ID 前缀、单设备/可同步（BE/BS）标志和精确到秒的登记时间；对不上就 `revoke-passkey` 并换下单密钥。
- **sudo 密码是在属于 `laosong` 的终端里输入的。** `wsl.exe -e sudo …` 不经过 `laosong` 的 shell 配置，但这个终端设备归 `laosong` 所有，已经被入侵的 `laosong` 进程理论上可以抢读终端输入，从而拿到 sudo 密码，也就是 root。只在你认为 `laosong` 当前没有被入侵时输入 sudo 密码；怀疑被入侵时先不要输入，先在 Trading 212 删除下单密钥。
- **互操作的锁靠开机服务维持。** 如果 WSL 更新后在开机服务之后又注册了处理器、重新创建或放开了 `/run/WSL`，在下次开机或重新运行 `sudo systemctl restart studio-trader-isolation` 之前，互操作可能重新打开；交易代理会把它报告为「隔离无效」（设置页、`check`），看到就立即处理。直接用 `AF_VSOCK` 连接 Windows 主机这条路没有专门封锁，目前依赖 WSL 服务不接受它没有发起的连接。
- **安装时信任的东西。** 你复制的 `$boot` 命令、WSL 里 root 所有的 `sudo`、`git`、`tar`、你审阅的提交、npm 上与 `package-lock.json` 完整性哈希相符的包、nodejs.org 的 SHA-256。构建会运行第三方代码（node-gyp 编译 better-sqlite3、`tsc`），但只以临时用户 `studio-trader-build` 运行，产物在复制成 root 所有之前和之后都会检查。
- **拒绝服务。** 终端里的人可以停掉 Studio、刷满失败次数（触发 15 分钟锁定）、占满待确认挑战或每小时笔数；这些都不会让他下单。
- **root 和 Windows。** WSL 里的 root、Windows 用户（能运行 `wsl.exe -u root`）、Windows 一侧的恶意软件，以及 Windows 盘、备份和同步盘上的旧密钥副本，都在这个隔离之外。

## 故障排查

- 设置里显示「未安装」：Studio 的 `.env` 没有 `STUDIO_T212_BROKER_SOCKET`，或 Studio 没有重启。
- 显示「无法连接」：`systemctl status studio-trader-broker.socket studio-trader-broker.service`；如果提示无权连接，确认 `id laosong` 里有 `studio-broker`，并在加组后运行过 `wsl.exe --shutdown`。
- 显示「隔离无效」：看提示里是哪一项。互操作：`systemctl status studio-trader-isolation`，`sudo systemctl restart studio-trader-isolation`；Windows 盘：检查 `/etc/wsl.conf` 的 `[automount]`，改完要 `wsl.exe --shutdown`。
- 安装脚本拒绝安装：它列出的每一项都要修好；`--check-only` 可以只重复检查。「run this installer from a root-owned export」说明你直接运行了仓库里的脚本，要用第 2 步的 `$boot` 命令。构建失败时多半是缺 `build-essential` / `python3`，或连不上 npm。
- 交易代理起不来：`journalctl -u studio-trader-broker`，多半是 `config.json` 有不认识的字段或值不合法；`studio-trader check` 会说明原因。
- 「当前网址不在交易代理的白名单」：把浏览器地址栏里的来源原样加入 `config.json` 的 `origins`，重启交易代理。
