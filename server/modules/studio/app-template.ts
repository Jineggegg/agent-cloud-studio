/** The file an AI build finds in its project folder: how a Studio app runs and looks (STUDIO_APP_GUIDE). */
export const STUDIO_APP_GUIDE_FILE = 'STUDIO_DESIGN.md';

/**
 * Used by the builds service: the template every app Studio's AI builds follows, written into each new project (and
 * into older ones when the owner asks the AI for a change) so the apps run in Studio's 主页 and share one design and
 * motion language. A request that explicitly asks for another style or animation overrides the design part only.
 */
export const STUDIO_APP_GUIDE = `# Studio 应用模板

这个项目是 Agent Cloud Studio 里的一个应用。主人在 iPad 上点开图标，Studio 会在「主页」里直接运行它；顶部导航栏（产品名、主页 / AI 助手 / 设置）和右侧的 AI 侧栏由 Studio 提供，应用只负责自己的界面。除非需求里明确要求别的风格或动画，所有设计都按下面的约定来做。

## 运行约定（必须遵守，否则在 Studio 里打不开）

- 用 \`npm start\` 启动；监听 \`process.env.PORT\` 和 \`process.env.HOST\`（Studio 传 127.0.0.1），本地开发可以默认 3000。
- 优先只用 Node 自带模块；需要依赖时装在项目里，并写进 package.json。纯前端应用也可以只有 index.html（Studio 会直接提供静态文件）。
- 页面里的地址一律用相对路径：\`fetch('api/notes')\`、\`<link href="style.css">\`、\`<script src="app.js">\`，不要以 \`/\` 开头。应用挂在 Studio 的一个子路径下运行。
- 数据存在服务器上（项目里的 \`data/\` 目录，并加进 .gitignore），不要依赖 localStorage、sessionStorage 或 cookie：应用运行在沙箱 iframe 里，这些只在当前页面有效。
- 不要自带登录或密码：Studio 已经确认是主人本人。
- 不要注册 Service Worker，不要用 WebSocket（用轮询或 Server-Sent Events）。

## 设计语言

- Apple / iOS 风格，安静、低饱和、留白充足；中文界面。
- 字体：\`-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif\`，正文 17px，次要文字 13–15px。
- 颜色写成 \`:root\` 上的变量，并跟随 \`prefers-color-scheme\` 提供深色版本：
  - 浅色：背景 #efede8，卡片 #fbfaf8，文字 #1d1c1a，次要文字 #66635d，分隔线 rgba(60,55,45,.16)，强调色 #3b5b7a，成功 #3e7556，危险 #a63d38。
  - 深色：背景 #121315，卡片 #1c1d20，文字 #f2f0ec，次要文字 #a7a39b，分隔线 rgba(230,225,215,.12)，强调色 #9db4cc。
- 卡片圆角 18–22px，按钮和输入框 12px；阴影轻：\`0 1px 2px rgba(40,35,25,.04), 0 10px 30px rgba(40,35,25,.05)\`。
- 浮在内容上的工具栏、面板用毛玻璃：半透明底色 + \`backdrop-filter: blur(20px) saturate(1.4)\` + 一条亮色细边。
- 应用自己的顶栏要紧凑（不要再放大标题，Studio 的导航栏已经显示产品名）；触控目标至少 44px；适配 iPad 横竖屏、手机和电脑。

## 动画（统一的衔接方式）

- 缓动：\`cubic-bezier(.22, .8, .2, 1)\`；有弹性的出现用 \`cubic-bezier(.34, 1.3, .64, 1)\`。时长：按下 90ms，小变化 200ms，常规 380ms，页面级 560ms。
- 内容进入：淡入并上移 8–12px；列表项依次出现，每项延迟约 22ms，最多错开 12 项。
- 按下：缩放到 0.97；松开回弹。新增的条目展开出现，删除的条目淡出并收起高度。
- 面板从底部滑入（手机）或居中缩放淡入（iPad / 电脑），背后加一层浅色遮罩。
- 加载用细的转圈或骨架闪光，不要整页白屏；刷新按钮转整圈后再停。
- 尊重 \`prefers-reduced-motion\`：关掉位移和缩放，只保留淡入淡出。
- 不要闪烁、跳动或突兀的布局位移。
`;
