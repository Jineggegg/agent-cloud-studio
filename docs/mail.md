# 邮箱：Gmail 与 Outlook

Studio 的「邮箱」把你所有邮箱账户的收件箱汇总在一起，只读。

- 账户属于 Studio 用户本人，不属于某个项目；任何启用了「邮箱」模块的项目都能看到同一个统一收件箱。
- 只读：Gmail 以只读方式打开邮箱（IMAP `EXAMINE` + `BODY.PEEK`），Outlook 只申请 `Mail.Read`。打开邮件不会标记已读，Studio 也不会发送、删除或移动邮件。
- 密码和令牌用 AES-256-GCM 加密后存在本机数据库里，密钥文件是数据库目录下的 `studio-vault/mail.key`。浏览器永远拿不到它们。
- 邮件内容是不可信的外部资料：只以纯文本显示（HTML 会被去掉，正文最多 5 万字），不加载图片，也不打开链接。内容不会自动发给任何 AI；只有你在项目里点「保存摘要草稿」时，才会把内容写进一条自动化草稿，并附上“不可信资料”的说明。

> 网络要求：运行 Studio 服务的这台电脑必须能访问 `imap.gmail.com:993`（Gmail），以及 `login.microsoftonline.com` 和 `graph.microsoft.com`（Outlook）。在国内使用时，需要让服务器经过能访问这些地址的出口（例如 AJ 服务器的 Tailscale exit node）。

## Gmail（推荐：应用专用密码）

Gmail 走 IMAP，用 Google 的「应用专用密码」登录。不需要在服务器上做任何配置，也不会像未验证的 OAuth 测试应用那样每 7 天失效。

1. 打开 Google 账号的两步验证并确认已开启：<https://myaccount.google.com/signinoptions/twosv>
2. 打开「应用专用密码」页面：<https://myaccount.google.com/apppasswords>，名称填 `Studio`，点「创建」，复制显示的 16 位密码（形如 `abcd efgh ijkl mnop`）。
3. 在 Studio 里打开「设置 → 邮箱账户 → 添加 Gmail」，填 Gmail 地址和这 16 位密码（空格可以保留），点「验证并保存」。

Studio 会先真的登录一次 Gmail，成功后才保存账户。

说明：

- 修改 Google 账号密码后，所有应用专用密码都会失效；账户会显示「需重新验证」，移除后重新添加即可。
- 找不到「应用专用密码」页面，通常是两步验证没开、账号加入了只允许安全密钥的「高级保护计划」，或者公司/学校账号的管理员关闭了这个功能。
- Google Workspace（自定义域名）账号同样可用，前提是管理员允许 IMAP 和应用专用密码。
- 搜索支持 Gmail 搜索语法（通过 IMAP 的 `X-GM-RAW`），例如 `from:alice`、`subject:发票`、`is:unread`、`after:2026/09/01`、`has:attachment`、`label:工作`。搜索范围是「所有邮件」，不搜索时显示收件箱最新约 30 封。

常见错误：

| 提示 | 原因与处理 |
| --- | --- |
| Google 拒绝了登录：请确认已开启两步验证并使用应用专用密码 | 填的是 Google 账号密码而不是应用专用密码，或应用专用密码已被撤销。重新生成一个。 |
| 应用专用密码是 16 位字母 | 粘贴的内容不是应用专用密码。 |
| 无法连接 Gmail 服务器（imap.gmail.com:993） | 服务器所在网络连不上 Google，见上面的网络要求。 |
| 尝试次数过多，请 10 分钟后再试 | 为避免触发 Google 风控，每 10 分钟最多验证 6 次。 |

## Outlook.com / Hotmail（Microsoft 登录）

Outlook.com 已经不再接受 IMAP 密码和应用密码，只能用 OAuth2。Studio 使用「设备代码」登录：不需要回调地址，也不需要客户端密钥，只需要一个你自己注册的免费 Microsoft Entra 应用。

### 一次性：注册 Microsoft Entra 应用

1. 用你的 Microsoft 账户登录 Microsoft Entra 管理中心 <https://entra.microsoft.com>（或 Azure 门户 <https://portal.azure.com> → Microsoft Entra ID）。如果个人账户还没有可用的目录，按页面提示创建免费的目录/Azure 账户即可，注册应用本身不收费。
2. 进入「应用注册 → 新注册」：
   - 名称：`Agent Cloud Studio`
   - 受支持的帐户类型：选择包含**个人 Microsoft 帐户**的选项（「仅限个人 Microsoft 帐户」，或「任何组织目录中的帐户和个人 Microsoft 帐户」）
   - 重定向 URI：留空
   - 点「注册」
3. 打开「身份验证」，在「高级设置」里把**允许公共客户端流**（Allow public client flows）设为「是」，保存。
4. 打开「API 权限」：默认已有 Microsoft Graph 的 `User.Read`；点「添加权限 → Microsoft Graph → 委托的权限」，勾选 `Mail.Read`，添加。个人账户不需要管理员同意，登录时由你本人同意。
5. 回到「概述」，复制**应用程序（客户端）ID**，写进服务器的 `.env`：

   ```env
   STUDIO_OUTLOOK_CLIENT_ID=00000000-0000-0000-0000-000000000000
   ```

   然后重启 Studio 服务。客户端 ID 不是密钥，但也不必公开。

### 连接 Outlook

1. 打开「设置 → 邮箱账户 → 添加 Outlook」，页面会显示一串代码。
2. 点「打开验证页面」（或在任意设备上打开 <https://microsoft.com/link>），输入代码，登录 Outlook 账户，同意「读取你的邮件」和「保持对已授予访问权限的数据的访问」。
3. 回到 Studio，几秒内会自动显示「已连接」。代码 15 分钟内有效。

说明：

- 刷新令牌加密保存，访问令牌按需自动刷新。长期不用或你撤销了授权时，账户会显示「需重新验证」，移除后重新添加即可。
- 随时可以在 <https://account.live.com/consent/Manage> 撤销 Studio 的访问权限。
- Outlook 的搜索使用 Microsoft 的 KQL 语法，例如 `from:alice`、`subject:发票`，也可以直接输入关键词。

常见错误：

| 提示 | 原因与处理 |
| --- | --- |
| Outlook 尚未配置 | 服务器没有设置 `STUDIO_OUTLOOK_CLIENT_ID`，或设置后没有重启。 |
| Outlook 应用配置有误 | 应用不支持个人 Microsoft 帐户，或没有开启「允许公共客户端流」。 |
| Outlook 应用缺少权限 | 在「API 权限」里添加 `Mail.Read` 和 `User.Read`。 |
| 这个 Microsoft 账户没有可读取的 Outlook 邮箱 | 登录的账户没有 Outlook.com 邮箱（例如只用于 Xbox 的账户）。 |

## 旧的 Gmail OAuth（可选）

如果服务器配置了 `STUDIO_GMAIL_CLIENT_ID` / `STUDIO_GMAIL_CLIENT_SECRET`（见 `.env.example`），项目的「邮箱」页底部会出现「Google OAuth（高级）」，可以用 Google 授权把 Gmail 连到某个项目，连接后它也会出现在统一收件箱里。未经 Google 验证的“测试”应用，刷新令牌每 7 天失效，所以更推荐上面的应用专用密码方式。

## 接口

全部位于 `/api/studio/mail`，需要登录，响应不缓存：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /accounts` | 账户列表（不含任何密码或令牌）和 `outlookConfigured` |
| `POST /accounts/imap` | `{ email, password }`：先登录验证 Gmail，成功后加密保存 |
| `POST /accounts/outlook/device` | 开始 Outlook 设备代码登录，返回 `pollId`、`userCode`、`verificationUri` |
| `POST /accounts/outlook/device/:pollId` | 查询一次登录状态：`pending`、`connected`、`expired` 或 `error` |
| `DELETE /accounts/:id` | 移除账户（删除本机保存的凭据） |
| `GET /messages?accountId=&q=&limit=` | 统一收件箱（省略 `accountId` 为全部账户，`limit` 默认 30、最多 50） |
| `GET /messages/:accountId/:messageId` | 一封邮件的纯文本正文 |
