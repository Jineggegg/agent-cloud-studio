# 远程主机（通过 Tailscale + SSH 在别人的服务器上跑 Claude / Codex）

Studio 可以把一个项目放到远程主机上运行：点开项目后，「AI 助手」里的 Claude Code、Codex 和终端都通过
SSH 连到那台主机，在它的目录里工作。会话运行在远程主机的 tmux 里，关掉页面不会中断，再次打开会接回同一个会话。

## 工作方式

- 远程主机只能来自服务器上的 `STUDIO_SSH_HOSTS`（`.env`），浏览器不能指定任意主机或命令。
- 启动命令由服务器生成：`ssh <别名> 'cd <目录> && tmux new-session -A -s studio-<agent>-<hash> …'`。
  目录只允许 `~`、`~/…` 或绝对路径里的字母、数字和 `._/-`。
- SSH 使用 WSL 里你自己的 `~/.ssh/config` 和密钥（`sp-remote` 已配置好，经 Tailscale 子网路由到 192.168.1.186）。
- Claude Code 和 Codex 在远程主机上使用**单独的配置目录**，不会碰主机主人自己的登录：
  - Claude Code：`CLAUDE_CONFIG_DIR=~/.studio/claude`
  - Codex：`CODEX_HOME=~/.studio/codex`

## 本机配置（已完成）

```ini
STUDIO_SSH_HOSTS=[{"name":"aj","label":"AJ 服务器","target":"sp-remote","dir":"~/projects/super-professor"}]
```

`dir` 会为新用户自动生成一个「AJ 服务器」项目；已有账号里我已经手动建好。在「设置 → 远程主机」可以看到在线状态和主机上装了哪些工具。

## 第一次登录你的账号（在 AJ 装好之后）

1. 打开「AJ 服务器」项目 → AI 助手 → **Claude Code**。第一次会提示登录：选订阅账号登录，按提示在你自己的浏览器里打开链接、粘贴代码。
2. 打开 **Codex**，第一次选「Sign in with ChatGPT」。远程主机上没有浏览器，如果回调失败，打开**终端**运行
   `CODEX_HOME=~/.studio/codex codex login --help` 查看登录方式，新版 Codex 可用设备码登录（`--device-auth`）。

> 注意：你的 Claude / ChatGPT 登录凭据会保存在 AJ 的电脑上（`~/.studio/`）。主机的主人有权限读取这些文件。
> 只在你信任 AJ 时这样用；不用时可以在终端里 `rm -rf ~/.studio/claude ~/.studio/codex` 退出。

---

## Checklist for the host owner (AJ)

Andrew's Studio connects to this machine over SSH (`aryan@192.168.1.186`, via Tailscale) and runs
Claude Code / Codex inside `~/projects/super-professor`. Please install two things, both for your own user:

1. **tmux** (keeps sessions alive when the iPad disconnects):

   ```bash
   sudo apt update && sudo apt install -y tmux
   ```

2. **Claude Code** (native installer, goes to `~/.local/bin/claude`, no sudo):

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   Then check from a fresh SSH session: `command -v claude tmux`.

That's all. Andrew signs in with **his own** accounts; they are stored separately under `~/.studio/claude`
and `~/.studio/codex`, so your own `~/.claude` and `~/.codex` logins are not touched or used.
Codex is already installed on this machine. Sessions show up in `tmux ls` as `studio-claude-…`,
`studio-codex-…` or `studio-shell-…`; you can end one with `tmux kill-session -t <name>`.
