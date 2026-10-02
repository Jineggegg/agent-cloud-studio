# AI 开发：无人值守构建的权限策略

主屏幕点 + →「让 AI 开发」后，Studio 会新建 `~/projects/<名称>` 文件夹和本地 git 仓库，加一个图标，再让 Claude Code 在后台无人值守地开发。没有人会实时批准它的操作，所以每一次工具调用都由服务器按下面的策略当场决定。策略写在 `server/modules/studio/build-runner.service.ts`，这里是给主人看的说明。

## 两种模式

| | 沙箱模式 | 受限模式 |
|---|---|---|
| 条件 | Linux 上装了 `bubblewrap` 和 `socat`（macOS 自带沙箱） | 其他情况，或设置了 `STUDIO_BUILD_SANDBOX=off` |
| 读写文件 | 只能在这次的项目文件夹里 | 同左 |
| 命令行 | 任意命令，但都在 Claude Code 的系统沙箱里运行 | 只允许几条不能执行代码的简单命令 |
| 安装依赖、运行、测试 | 可以 | 不可以 |
| 网络 | 只通向 npm 和 PyPI 软件包仓库 | 无 |

新建面板会显示当前是哪种模式。受限模式下，AI 只能写代码、写 README 并提交到本地；README 会写明怎样安装、运行和测试，总结里会说明哪些还没运行验证过。

**想要完整开发，在运行 Studio 的这台电脑（WSL）上执行：**

```bash
sudo apt-get install -y bubblewrap socat
```

装好后新开始或继续的构建就会自动进入沙箱模式，不需要重启 Studio（启动日志里的提示要重启后才会消失）。如果装了却启动不了沙箱（例如系统禁止了非特权用户命名空间），构建会直接失败并报错，而不会在沙箱外运行；这时可以设置 `STUDIO_BUILD_SANDBOX=off` 退回受限模式，再排查原因。

## 两种模式都适用的规则

- **默认拒绝。** 每一次工具调用（包括子任务里的）都会先经过一个 PreToolUse 钩子，它在 Claude Code 自己的规则和自动批准之前运行，只回答“允许”或“拒绝”。不在下面列表里的工具一律拒绝，包括 MCP 工具、Skill、Monitor、worktree 等。
- **不加载任何配置。** 构建的这一轮不读取你的 `~/.claude/settings.json`、项目里的 `.claude/settings*.json`，也不启动 MCP 服务器，所以那些地方的允许规则、钩子和 MCP 服务器都不会让构建拿到更多权限。
- **文件工具**（Read、Glob、Grep、Write、Edit、MultiEdit、NotebookEdit）：每个表示路径的参数都会解析符号链接，必须落在项目文件夹里；Glob 的 pattern 和 Grep 的 glob 不能含 `..`、`~`，也不能指向文件夹以外的绝对路径。
- **控制文件不能写。** 项目里任何位置的 `.claude/`、`.codex/`、`.git/`（含 hooks 和 config）、`.mcp.json`、`.vscode/`、`.idea/`、`.husky/` 都不能被写入，防止 AI 给之后的运行（包括你在工作台里接着跑的会话）偷偷加权限、钩子或 MCP 服务器。`CLAUDE.md`、`AGENTS.md` 只是说明文字，不能授予权限，可以写。
- **不能上网查资料。** WebFetch 和 WebSearch 在构建里被移除。
- **不问问题。** AskUserQuestion 和计划模式会被拒绝，并告诉 AI 自己做合理的决定、把假设写进 README。

## 沙箱模式的细节

- 沙箱由 Claude Code 自带的 sandbox 功能提供（Linux 上用 bubblewrap 隔离文件系统，用 socat 做网络代理），设置为 `failIfUnavailable`，并且关闭了让命令跳出沙箱的开关。
- 可写：项目文件夹（上面的控制文件除外）和沙箱自己的临时目录。npm、pnpm、yarn、pip、uv 的缓存被指到项目里的 `.studio-cache/`，这个文件夹已写进仓库的 `.git/info/exclude`，不会被提交。
- 可读：家目录整个不可读，只放开这个项目文件夹和常见的工具链位置（`~/.local/bin`、`~/.local/lib`、`~/.nvm`、`~/.volta`、`~/.bun`、`~/.deno`、`~/.pyenv`、uv 和 pnpm 的安装目录、`~/.gitconfig`，以及 Claude Code 的 shell 快照）。`~/.ssh`、`~/.claude`、`~/.config`、`~/.npmrc`、其他项目和 Studio 自己的数据都读不到。工具链装在别处时，命令会因为读不到而失败。
- 网络：`registry.npmjs.org`、`registry.yarnpkg.com`、`repo.yarnpkg.com`、`pypi.org`、`files.pythonhosted.org`。用镜像源时，把主机名加进 `STUDIO_BUILD_EXTRA_DOMAINS`（逗号分隔）。Rust、Go 等需要其他仓库的技术栈目前装不了依赖。

## 受限模式的细节

受限模式不解析 shell 语法，而是只接受“纯参数列表”形式的命令：整条命令只能包含字母、数字、空格和 `. _ - / : = + , @ %`，所以引号、`$` 展开、通配符、花括号展开、管道、重定向、`&&`、分号、换行都会被拒绝。程序名必须是下面之一，每个路径参数都要解析到项目文件夹里，写入类命令不能碰控制文件：

- `pwd`、`ls`、`cat`、`head`、`tail`、`wc`（只读）
- `mkdir`、`touch`、`rm`、`mv`、`cp`（不能删除项目文件夹本身）
- `git init`、`git status`、`git diff`、`git log`、`git add`、`git commit -m <一个词>`，每个子命令只接受固定的几个选项（例如不能用 `--output`、`--template`、`-c`）

不能运行 node、python、npm、npx、bash 等任何会执行代码的程序。提交信息因此只能是一个不含空格的词（例如 `git commit -m first-version`）。

## 环境变量

- `STUDIO_BUILDS_ROOT`：新项目放在哪里，默认 `~/projects`。必须在家目录里，否则开始构建时会报配置错误。
- `STUDIO_BUILDS_MAX_PARALLEL`：同时运行几个构建，默认 2。
- `STUDIO_BUILD_MODEL` / `STUDIO_BUILD_EFFORT`：构建使用的 Claude 模型和推理强度，默认用 Claude 运行时的默认值。
- `STUDIO_BUILD_SANDBOX=off`：即使沙箱可用也使用受限模式。
- `STUDIO_BUILD_EXTRA_DOMAINS`：沙箱里额外允许访问的软件包仓库主机名。

## 已知限制

- 沙箱模式依赖 Claude Code 自带的 sandbox 实现，这台服务器装好 `bubblewrap` 和 `socat` 之前还没有实际跑过；第一次使用时建议在工作台里看一下构建过程。
- 你在工作台里手动接着跑同一个会话时，用的是你平时的权限设置，不受这里的策略约束。
- 控制文件的保护靠文件工具的检查和沙箱的写入限制；如果你怀疑某次构建出了问题，先看看项目里有没有 `.claude/`、`.mcp.json` 或 `.git/hooks/` 下的新文件。
