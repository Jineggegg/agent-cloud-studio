# AI 开发：无人值守构建的权限策略

主屏幕点 + →「让 AI 开发」后，Studio 会新建 `~/projects/<名称>` 文件夹和本地 git 仓库，加一个图标，再让 Claude Code 在后台无人值守地开发。没有人会实时批准它的操作，所以每一次工具调用都由服务器按下面的策略当场决定。策略写在 `server/modules/studio/build-runner.service.ts`，这里是给主人看的说明。

## 两种模式

| | 沙箱模式 | 受限模式（默认） |
|---|---|---|
| 条件 | 设置了 `STUDIO_BUILD_SANDBOX=on`，并且 Linux 上装了 `bubblewrap` 和 `socat`（macOS 自带沙箱） | 其他所有情况 |
| 读写文件 | 只能在这次的项目文件夹里 | 同左 |
| 命令行 | 任意命令，但都在 Claude Code 的系统沙箱里运行 | 只允许几条不能执行代码的简单命令 |
| 安装依赖、运行、测试 | 可以 | 不可以 |
| 网络 | 只通向 npm 和 PyPI 软件包仓库 | 无 |

**沙箱模式必须手动开启。** 即使 `bubblewrap` 和 `socat` 都装好了，只要没有设置 `STUDIO_BUILD_SANDBOX=on`（必须正好是 `on`），构建就一直是受限模式。原因是沙箱模式下命令本身不再受检查，全靠沙箱兜底；在这台电脑上亲眼确认沙箱真的拦得住之前，不应该把命令交给它。

新建面板会显示当前是哪种模式，以及还差哪一步。受限模式下，AI 只能写代码、写 README 并提交到本地；README 会写明怎样安装、运行和测试，总结里会说明哪些还没运行验证过。

## 开启沙箱模式

1. 在运行 Studio 的这台电脑（WSL）上安装沙箱组件：

   ```bash
   sudo apt-get install -y bubblewrap socat
   ```

2. 在 Studio 的环境变量里设置 `STUDIO_BUILD_SANDBOX=on`，重启 Studio。
3. 马上做一遍下面的「沙箱检查」。任何一项没有被拒绝，就删掉 `STUDIO_BUILD_SANDBOX=on` 并重启，回到受限模式，再排查原因。

沙箱启动不了时（例如系统禁止了非特权用户命名空间），构建会直接失败并报错，而不会在沙箱外运行。

### 沙箱检查（开启后做一次，升级 Claude Code 后建议再做一次）

新建一个用来检查的 AI 开发，名称例如 `sandbox-check`，描述里让它**用 Bash** 依次运行下面的命令，原样报告每条命令的输出和退出码，不要绕过、不要重试（文件工具本身就会拒绝这些路径，所以必须用 Bash 才能检验沙箱）：

| 检查 | 让它运行的命令 | 期望结果 |
|---|---|---|
| 读不到 `~/.ssh` | `ls -la ~/.ssh; cat ~/.ssh/id_ed25519 ~/.ssh/id_rsa ~/.ssh/known_hosts` | 全部失败（没有这个文件或权限不足），看不到任何文件名或内容 |
| 写不了项目以外 | `touch ~/sandbox-escape-test; touch ../sandbox-escape-test` | 两条都失败（只读文件系统或权限不足） |
| 连不上软件包仓库以外的主机 | `curl -sS -m 15 https://example.com -o /dev/null -w '%{http_code}\n'` | 失败或被代理拒绝（例如 403），拿不到 200；对照 `curl -sSI -m 15 https://registry.npmjs.org/` 应该成功 |
| 写不了 `.git/hooks` | `touch .git/hooks/pre-commit; echo x >> .git/config` | 两条都失败 |

AI 报告完之后，再在服务器的终端里亲自核对一遍，不要只信它的总结：

```bash
ls -la ~/sandbox-escape-test ~/projects/sandbox-escape-test   # 都应该不存在
ls -la ~/projects/sandbox-check/.git/hooks                     # 不应该有 pre-commit
git -C ~/projects/sandbox-check config --list --local          # 不应该多出 x
```

四项都符合预期，沙箱模式才算可用。检查用的项目之后可以直接删掉。

## 两种模式都适用的规则

- **默认拒绝。** 每一次工具调用（包括子任务里的）都会先经过一个 PreToolUse 钩子，它在 Claude Code 自己的规则和自动批准之前运行，只回答“允许”或“拒绝”。不在下面列表里的工具一律拒绝，包括 MCP 工具、Skill、Monitor、worktree 等。
- **不加载任何配置。** 构建的这一轮不读取你的 `~/.claude/settings.json`、项目里的 `.claude/settings*.json`，也不启动 MCP 服务器，所以那些地方的允许规则、钩子和 MCP 服务器都不会让构建拿到更多权限。
- **只带必要的环境变量。** 构建这一轮的 Claude Code 进程不继承 Studio 服务器的全部环境变量，只带：`PATH`、`HOME`、`USER`、`SHELL`、`TMPDIR`、`LANG` 和 `LC_*`、`TERM`；Claude Code 自己登录需要的 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_CONFIG_DIR`（用 Bedrock 或 Vertex 登录时再加上对应的 `AWS_*` 或 Google 云变量）；访问 API 需要的代理设置（`HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`、`NODE_EXTRA_CA_CERTS`）；以及包管理器缓存位置和提交身份（`GIT_AUTHOR_*`、`GIT_COMMITTER_*`）。Studio 自己的密钥、数据库地址、其他工具的令牌都不会进入构建。
- **文件工具**（Read、Glob、Grep、Write、Edit、MultiEdit、NotebookEdit）：每个表示路径的参数都必须落在项目文件夹里，而且从项目文件夹往下逐级检查（lstat），**路径上任何一级是符号链接就直接拒绝**，不去解析它指向哪里，哪怕它指向项目里面。Glob 的 pattern 和 Grep 的 glob 不能含 `..`、`~`，也不能指向文件夹以外的绝对路径。
- **控制文件不能写。** 项目里任何位置的 `.claude/`、`.codex/`、`.git/`（含 hooks 和 config）、`.mcp.json`、`.vscode/`、`.idea/`、`.husky/` 都不能被写入，防止 AI 给之后的运行（包括你在工作台里接着跑的会话）偷偷加权限、钩子或 MCP 服务器。`CLAUDE.md`、`AGENTS.md` 只是说明文字，不能授予权限，可以写。
- **不能上网查资料。** WebFetch 和 WebSearch 在构建里被移除。
- **不问问题。** AskUserQuestion 和计划模式会被拒绝，并告诉 AI 自己做合理的决定、把假设写进 README。

## 沙箱模式的细节

- 沙箱由 Claude Code 自带的 sandbox 功能提供（Linux 上用 bubblewrap 隔离文件系统，用 socat 做网络代理），设置为 `failIfUnavailable`，并且关闭了让命令跳出沙箱的开关。
- 可写：项目文件夹（上面的控制文件除外）和沙箱自己的临时目录。npm、pnpm、yarn、pip、uv 的缓存被指到项目里的 `.studio-cache/`，这个文件夹已写进仓库的 `.git/info/exclude`，不会被提交。
- 可读：家目录整个不可读，只放开这个项目文件夹和常见工具链的安装位置（`~/.local/bin`、`~/.local/lib`、`~/.nvm`、`~/.volta`、`~/.bun`、`~/.deno`、`~/.pyenv`、uv 的 Python、pnpm 和 fnm 的安装目录）——这些地方只有程序和库，没有配置。`~/.ssh`、`~/.claude`（包括 shell 快照）、`~/.config`、`~/.gitconfig`、`~/.npmrc`、其他项目和 Studio 自己的数据都读不到。工具链装在别处时，命令会因为读不到而失败。
- 读不到 `~/.gitconfig`（里面可能有凭据助手、带令牌的 URL 改写或 include），所以 Studio 启动时在沙箱外读一次你的 `user.name` 和 `user.email`，通过 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 交给沙箱里的 git。Claude Code 的 shell 快照（你的别名和函数）也读不到，命令在没有它们的干净 shell 里运行。
- 网络：`registry.npmjs.org`、`registry.yarnpkg.com`、`repo.yarnpkg.com`、`pypi.org`、`files.pythonhosted.org`。用镜像源时，把主机名加进 `STUDIO_BUILD_EXTRA_DOMAINS`（逗号分隔）。Rust、Go 等需要其他仓库的技术栈目前装不了依赖。

## 受限模式的细节

受限模式不解析 shell 语法，而是只接受“纯参数列表”形式的命令：检查的是原始命令文本，只去掉首尾的 ASCII 空格（制表符、换行等其他空白不会被去掉，而是直接导致拒绝）。整条命令只能包含字母、数字、空格和 `. _ - / : = + , @ %`，所以引号、`$` 展开、通配符、花括号展开、管道、重定向、`&&`、分号、换行都会被拒绝。程序名必须是下面之一，每个路径参数都要落在项目文件夹里、不经过符号链接，写入类命令不能碰控制文件：

- `pwd`、`ls`、`cat`、`head`、`tail`、`wc`（只读）
- `mkdir`、`touch`、`rm`、`mv`、`cp`（不能删除项目文件夹本身）
- `git init`、`git status`、`git diff`、`git log`、`git add`、`git commit -m <一个词>`，每个子命令只接受固定的几个选项（例如不能用 `--output`、`--template`、`-c`）

不能运行 node、python、npm、npx、bash 等任何会执行代码的程序。提交信息因此只能是一个不含空格的词（例如 `git commit -m first-version`）。

## 环境变量

- `STUDIO_BUILDS_ROOT`：新项目放在哪里，默认 `~/projects`。必须在家目录里，否则开始构建时会报配置错误。
- `STUDIO_BUILDS_MAX_PARALLEL`：同时运行几个构建，默认 2。
- `STUDIO_BUILD_MODEL` / `STUDIO_BUILD_EFFORT`：构建使用的 Claude 模型和推理强度，默认用 Claude 运行时的默认值。
- `STUDIO_BUILD_SANDBOX=on`：开启沙箱模式（需要沙箱组件已装好，并且做过上面的沙箱检查）。不设置或设置成其他任何值都是受限模式。
- `STUDIO_BUILD_EXTRA_DOMAINS`：沙箱里额外允许访问的软件包仓库主机名。

## 已知限制和剩余风险

- **符号链接检查不是原子的。** 文件工具在钩子里检查完路径之后，Claude Code 才真正打开文件，中间有一个很短的窗口。逐级拒绝符号链接把这个窗口缩到了“检查时链接还不存在、使用时刚好出现”的竞争：受限模式下 AI 没有任何能创建符号链接的命令，所以实际上利用不了；沙箱模式下，AI 可以在沙箱里启动一个后台命令，反复创建、删除指向项目外的链接，赶在检查和使用之间替换路径，让在沙箱外运行的 Read 读到项目外的文件。要彻底关上它，需要文件工具本身用 `O_NOFOLLOW` 逐级打开，这不在 Studio 的控制范围内。沙箱模式仍应只在你信任构建描述时使用。
- **Glob 和 Grep 遍历目录。** 检查的是它们的起始路径和匹配模式；遍历过程中遇到的、指向项目外的符号链接是否被跟随，取决于 Claude Code 的实现（ripgrep 默认不跟随）。
- **Claude Code 的登录变量对沙箱里的命令可见。** `ANTHROPIC_API_KEY` 之类的变量必须交给 Claude Code，而沙箱里的命令继承 Claude Code 的环境，所以也看得到它们。沙箱的网络只通向软件包仓库，它们发不出去；受限模式下 AI 根本运行不了能读环境变量的程序。用 OAuth 登录（凭据在 `~/.claude` 里，沙箱读不到）时没有这个问题。
- 沙箱模式依赖 Claude Code 自带的 sandbox 实现，这就是它默认关闭、开启前要做沙箱检查的原因。
- 你在工作台里手动接着跑同一个会话时，用的是你平时的权限设置，不受这里的策略约束。
- 控制文件的保护靠文件工具的检查和沙箱的写入限制；如果你怀疑某次构建出了问题，先看看项目里有没有 `.claude/`、`.mcp.json` 或 `.git/hooks/` 下的新文件。
