# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Two tabs sit next to the page title. **App usage** is the transcript-based view described below;
**Personal plan** gathers everything you pay for — subscription providers and model service supplier
plans — across every connected environment.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

## Mobile server settings

After pairing a phone with an environment, **Settings → Server settings** edits the settings
owned by that Code Work server. Runtime switches, new-thread defaults, worktree behavior,
background activity policy, source-control writing style, and observability endpoints are sent
through the server and are shared with desktop and web clients connected to the same environment.
The same page also controls the default model for new agent tasks and an optional dedicated
source-control writer model.

The phone does not copy server credentials or start local desktop processes; it only controls the
selected, already-running Code Work server.

## 手机端电脑预览

手机端线程页的“电脑预览”读取的是同一 Code Work Server 上电脑端预览标签页的状态。手机不
运行 Chromium，也不把电脑上的页面内容复制到手机；电脑端仍负责实际渲染，手机通过已授权的
WebSocket 远程控制对应的标签页。

手机可以新建、关闭、导航、刷新、后退、前进标签页，选择电脑端的视口预设，并控制强制刷新、
缩放、外观、静音、弹出预览、开发者工具和预览分区的缓存/Cookie。电脑端回报的 URL、加载状态、
前进后退可用性、视口、缩放、外观、静音、弹出状态和录屏状态会同步回手机。手机还可以发起截
图，截图由电脑执行后通过预览事件返回手机；在该截图上点按会按截图的 CSS 像素坐标点击电脑页
面，也可以向电脑当前焦点输入文本、发送按键和滚动。截图不是持续视频流：执行导航、改视口、
缩放、换外观、截图或直接页面操作后，手机会将旧截图标为过期，必须重新截图才能查看或继续操
作最新画面。手机可以开始或停止录
屏，但录屏文件仍保存在电脑端。手机也可以启动或取消电脑端元素拾取；选择动作仍在电脑端完成，
受限的元素摘要和可选截图会通过预览事件返回手机；当前页面也可以要求电脑端用系统浏览器打开。

手机端和电脑端不是两份独立的预览数据：标签页元数据由服务器统一维护，电脑端桥接负责执行
浏览器动作；电脑离线时手机只会保留最后一次已知状态，无法确认新的操作已在电脑执行，应重新
连接对应环境后再操作。

## Mobile pull requests

The mobile home header opens the same server-backed pull-request workspace as the desktop client.
After choosing an environment, the phone can filter and search pull requests, load additional
server pages, and open a detail page. The detail page reads the summary, labels, checks, commits,
activity, reviewers, mergeability, and code diff; checks and the host URL can be opened externally.
The code view renders parsed files and line numbers, supports loading additional diff pages, and
lets a permitted reviewer select lines and attach pending line comments to a review. When the
server reports the matching capability and permission, it can also edit the title and description,
post comments, submit a review, reply to or resolve review threads, manage reactions and reviewers,
change draft/open state, update a branch, merge, and manage auto-merge. The mobile client does not
copy credentials or run provider CLIs: every read and operation is executed by the selected,
already-running Code Work environment, and provider capabilities still decide which controls are
available.

These operations run on the selected Code Work server. The phone is a remote control and does not
run GitHub/GitLab/Bitbucket CLIs locally; unavailable provider capabilities remain hidden or are
reported by the server.

## Mobile thread goals

The thread goal shown by the desktop client is stored on the Code Work server, so the mobile client
can open the same goal from the expanded thread composer. It can read the current objective, status,
duration, and token usage, and can set or update the objective, pause, resume, or clear the goal. The
desktop and mobile clients therefore operate on one server-side goal rather than separate phone data.

**IDE sessions** is the mobile counterpart of the desktop IDE Runtime settings. It can add, edit,
enable, disable, and remove Cursor, VS Code, or browser MCP sessions, and it reads each session's
server-side connection status and verified operations. WebSocket headers are bound to environment
variables on the server; sensitive values remain there and can be left blank on the phone to keep
the stored value.

**Agent runtime** reports the same server-side Driver availability and verified capability surfaces
shown on desktop. It is intentionally read-only on both clients: task execution remains subject to
the server's authorization and capability checks.

**Keybindings** edits the selected server's shortcut rules from the phone, including command, key,
`when` condition, delete, and restore-default actions. **Source control** scans that server for Git,
hosting integrations, versions, and authentication state; pull to rescan after changing the server.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Activity overview

Above the provider breakdown, the page keeps a rolling year of activity:

- **Total tokens**, **Peak tokens**, **Active days**, **Current streak**, and **Longest streak**
  summarize the whole year. A day counts as active once any provider recorded tokens, and the
  current streak survives an inactive today so the page does not read as a broken streak before
  your first turn.
- **Token activity** is a calendar heatmap of the same year. **Daily** colors each day by that
  day's volume, **Weekly** collapses to one cell per week, and **Cumulative** colors each day by
  how much has accumulated so far.
- **Daily token trend** plots the heaviest models over the selected range (daily windows only),
  and **Model usage** shows the token share per model with the tail grouped as other models.

## Personal plan

The **Personal plan** tab has two sections:

- **Subscriptions** gives Claude Code, Codex, and Grok Build one card each with lifetime tokens,
  sessions, active days, and streaks, derived from the same transcript scan as the app-usage tab.
- **Model service plans** lists every supplier balance configured on your connected environments — merged
  across devices so a supplier configured on two machines is counted once — with per-window
  usage, remaining amounts, reset times, and query health. An environment that fails to answer is
  reported by name instead of silently dropping its suppliers.
