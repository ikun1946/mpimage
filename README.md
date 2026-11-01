# 画境 · Magpie 生图（前后端分离）

单张生图工作台 + 资产批量工作台。后端是纯 API（Fastify + TypeScript），前端是 Vite 承载的原生 ES Module，两者独立运行、独立部署。

## 目录结构

```text
huajing-image-web/
├── server/                    后端：只提供 API，不托管页面
│   ├── src/
│   │   ├── index.ts           启动、路由装配、CORS、错误处理
│   │   ├── config.ts          环境变量与画面比例定义（唯一来源）
│   │   ├── routes/
│   │   │   ├── images.ts      POST /api/images
│   │   │   ├── uploads.ts     POST /api/reference-images（角色面部参考图）
│   │   │   ├── files.ts       GET  /api/files/*
│   │   │   ├── meta.ts        GET  /api/config、/api/health
│   │   │   ├── auth.ts        登录、登入、当前用户、首次引导
│   │   │   ├── admin.ts       账号管理、生成统计
│   │   │   ├── projects.ts    项目增删改查（按账号隔离）
│   │   │   ├── styles.ts      风格库读写（按账号隔离）
│   │   │   ├── history.ts     当前账号的生成记录
│   │   │   ├── update.ts      GET /api/update/status（本机请求免登录）
│   │   │   └── upstream.ts    管理员读写上游地址、测试连通性
│   │   ├── services/
│   │   │   ├── magpie.ts      调上游 Magpie 生图接口
│   │   │   ├── imaging.ts     图片格式探测、像素尺寸读取
│   │   │   ├── storage.ts     存储抽象（本地盘，日后可换对象存储）
│   │   │   ├── user-store.ts  账号库
│   │   │   ├── usage-store.ts 生图统计与生成记录（含提示词、耗时、图片路径）
│   │   │   ├── project-store.ts 项目库（项目归属 ownerId）
│   │   │   ├── style-library.ts 风格库（每账号一份）
│   │   │   ├── settings-store.ts 运行期设置（上游地址）落盘 settings.json
│   │   │   └── update-checker.ts 版本检查：GitHub Releases / 自定义 JSON，带缓存
│   │   └── lib/
│   │       ├── errors.ts      统一错误码
│   │       ├── serial-gate.ts 生图闸门（并发数可配置）
│   │       ├── session.ts     会话表
│   │       ├── filename.ts    文件名合法性校验
│   │       ├── url.ts         图片 URL 构建（按请求 Host 推断）
│   │       └── password.ts    scrypt 密码哈希
│   ├── package.json
│   └── .env.example
├── web/                       前端：只在浏览器里跑的客户端
│   ├── batch.html             客户端主页面（资产批量 + 自由创作）
│   ├── login.html             登录页（登录 / 申请账号 / 首次初始化）
│   ├── src/
│   │   ├── ui/                共享设计层：tokens.css（令牌 + 暗色）/ base.css / components.css
│   │   ├── lib/               api.js / config.js / dom.js / guard.js / history-panel.js / prompt-tools.css
│   │   │   ├── asset-groups.js 角色/场景分组（同一主体的不同状态/区域）
│   │   │   ├── style-transfer.js 风格库 JSON 导出与导入合并
│   │   │   ├── overlay.js     弹层公共行为：ESC / 焦点陷阱 / 焦点归还 / 滚动锁
│   │   │   ├── ratio.js       画面比例唯一来源（服务端配置 + 内置兜底）
│   │   │   ├── format.js      文件名、画幅等纯函数
│   │   │   └── history-panel.css  生成记录面板样式（多页面共用）
│   │   ├── batch/             工作台样式按职责拆成 11 个 CSS（batch.css 只列 @import）+ batch.js
│   │   └── login/             登录页 CSS + JS（令牌取自 ui/）
│   ├── vite.config.ts
│   └── package.json
├── desktop/                   Electron：服务控制台 + 主服务进程
│   ├── main.mjs               窗口、菜单 / 托盘、控制台状态推送、优雅退出
│   ├── panel.html / panel-preload.cjs    服务控制台（服务、客户端入口、后台管理、维护）
│   ├── server.mjs             启停 server/dist/index.js（ELECTRON_RUN_AS_NODE=1），8787 探测与接管
│   ├── updater.mjs            检查更新、解析直链后按链路自适应单流/并发下载
│   ├── logs.html / logs-preload.cjs    运行日志窗口（读本地 logs/*.log）
│   ├── update.html / update-preload.cjs  下载进度窗口（进度 / 速度 / 取消 / 安装）
│   ├── config.mjs             读写 <数据目录>/config.env，把配置注入子进程
│   └── paths.mjs              安装目录 / 数据目录 / 日志目录
├── scripts/dev.mjs            一条命令同时起前后端
├── users.json                 账号库
├── projects.json              项目库（每个项目带 ownerId，按账号隔离）
├── usage.json                 生图统计与生成记录
├── styles/                    风格库目录（每个账号一份 <userId>.json）
├── logs/                      后端运行日志（按天 YYYY-MM-DD.log）
├── data/                      运行数据（traffic.json 流量、rate-limit.json 限流、quotas.json 额度、concurrency.json 并发上限、feedback.json 意见反馈、settings.json 上游地址、sessions.json 会话）
└── generated/                 生成的图片（按资产类型分文件夹）
    ├── 角色/                   角色资产图，文件名为资产名
    ├── 场景/                   场景资产图
    ├── 道具/                   道具资产图
    ├── 自由创作/                批量页的自由创作
    └── 单张创作/                历史遗留目录（单张页已并入自由创作）
```

## 启动

### 桌面端（Windows 应用，推荐给非开发者）

```powershell
npm install            # 首次：装 electron / electron-builder
npm run desktop:dev    # 开发模式直接跑起来
npm run desktop:build  # 出安装包 + 便携版，产物在 release/
```

- **形态**：Electron 外壳，**主窗口就是服务控制台**（`desktop/panel.html`，本地页面）：
  服务状态与启停 / 重启、客户端地址、「在浏览器打开客户端」、运行日志、检查更新、数据与日志目录、
  复制管理密钥，以及**后台管理**（账号、待审核、限流与并发、上游、反馈、统计、流量）。
  **生图客户端不在桌面端里跑**——一律在浏览器打开 `http://<本机或局域网IP>:8787/batch.html`
- **启停不依赖网页登录**：主进程用 `desktop/server.mjs` 自己拉起
  `server/dist/index.js`（`ELECTRON_RUN_AS_NODE=1`），控制台与菜单 / 托盘都能启停；
  菜单第一项只读显示「状态：运行中 / 已停止」，已在运行时「启动服务」自动置灰
- **控制台调管理接口不需要登录**：主进程每次启动生成一个随机 `DESKTOP_TOKEN` 注入给本机服务，
  控制台的请求由主进程代发并带上它（服务端只认回环地址 + 这个令牌，令牌不出主进程），
  所以账号、限流、上游这些后台功能在控制台里直接可用
- **菜单 / 托盘**：服务状态（只读）、启动服务、停止服务、重启服务、显示主窗口、
  在浏览器打开客户端、复制局域网地址、打开数据目录、运行日志…、打开日志目录、
  复制管理密钥、检查更新…、退出。关窗只收进托盘、服务继续跑，托盘「退出」才停服务
- **不依赖用户装 Node**：主服务由 Electron 自带的 Node 启动；打包产物里
  `resources/app-server/` 放着 `server/dist`、`server/node_modules`（仅运行期依赖）与 `web/dist`
- **数据目录（绝不写安装目录）**：
  - 安装版：`%APPDATA%\huajing\`（`config.env`、`users.json`、`usage.json`、
    `projects.json`、`styles/`、`generated/`、`data/`、`logs/`、`updates/`）
  - 便携版：exe 同目录的 `huajing-data\`，可随 U 盘搬走
- **首次使用**：数据目录为空时控制台会提示「账号库还是空的，先去浏览器完成初始化」
  并弹出管理密钥对话框（也已复制到剪贴板）。点「在浏览器打开客户端」进入登录页的「初始化画境」，
  粘贴密钥创建第一个管理员。之后菜单里的「复制管理密钥」随时可以再取
  （密钥保存在 `config.env` 的 `ADMIN_SETUP_KEY`，建好管理员后服务端会忽略它）
- **配置**：改 `config.env`（`PORT`、`HOST`、`MAGPIE_BASE_URL`、`SESSION_SECRET`、
  `IMAGE_CONCURRENCY` 等）后重启应用生效；桌面端不读 `server/.env`。
  上游地址、限流、并发这些运行期设置在**控制台的「后台管理」里**改，不必动 `config.env`
- **端口占用只剩 8787**：启动前先探测 8787——如果是本应用的服务在跑，直接接管，
  不再拉起第二份；如果被别的程序占用，弹窗说明后退出
- **退出是优雅的**：先 `POST /api/shutdown`（请求头 `x-shutdown-token`，每次启动随机生成、
  只注入给主服务），等服务把流量数据补写、日志流关掉、端口释放；超时未退才 `taskkill` 兜底
- **检查更新**：菜单「检查更新…」向本机 `/api/update/status?force=1` 拿版本信息，
  发现新版本时给三个按钮「下载安装包 / 前往发布页 / 稍后」
- **下载进度窗口**：下载会开一个独立小窗（「画境 · 更新下载」），显示进度条、百分比、
  已下载 / 总大小、速度、剩余时间与连接数，可以随时「取消」；主窗口任务栏与托盘提示同步显示比例，
  下载完窗口切到「立即安装 / 打开所在文件夹」。下载途中关窗只是收起来，不会丢进度
- **下载提速与代理**：先 `HEAD` 解析出 GitHub 的签名直链再下载（省掉重复 302），
  再用 1MB 探测吞吐——快链路保持单流，慢链路才切 4 段并发（并发在满速链路上反而更慢，所以不写死）。
  下载走 Electron 的 `net.fetch`，**自动沿用 Windows 系统代理与 PAC**（主进程自带的 Node fetch 不认系统代理，
  直连 GitHub 会直接失败）。安装包落在 `<数据目录>/updates/`，先写 `.part` 再改名
- **下载相关配置**（`config.env`）：`UPDATE_DOWNLOAD_CONNECTIONS` 默认 `auto`（`1` 强制单流、`2/4/6` 强制并发），
  `UPDATE_DOWNLOAD_MIRROR` 默认空（填了才把该地址作为下载镜像前缀，第三方镜像有被篡改风险，谨慎使用）
- 生成的 exe 未做代码签名，首次运行可能被 SmartScreen/杀软提示，属正常现象

#### 打不开安装包构建时（本机环境相关）

`electron-builder` 打包 Windows 目标时要下载 `winCodeSign` / `nsis` /
`nsis-resources` 三个二进制。如果遇到下面两种情况，会卡在打包而不是代码问题：

1. 无法访问 GitHub releases（国内网络常见）→ 设置镜像：
   `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
2. `winCodeSign` 解压报 `Cannot create symbolic link`（没开 Windows 开发者模式 /
   非管理员）→ 它只影响压缩包里的 macOS dylib 符号链接。做法：先用 7-Zip 把
   `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*.7z` 解到
   `Cache\winCodeSign\winCodeSign-2.6.0\`（缺少的两个 `.dylib` 建成空文件即可），
   再配合本地镜像目录（把 `nsis-3.0.4.1.7z`、`nsis-resources-3.4.1.7z` 一并放好）
   用 `ELECTRON_BUILDER_BINARIES_MIRROR=http://127.0.0.1:<端口>/` 打包。

只想先拿到可直接运行的目录（不生成安装包）时用 `npm run desktop:pack`，
产物在 `release/win-unpacked/`。

调试时设 `HUAJING_DATA_DIR=<目录>` 可以把数据根指到别处，避免动到真实的账号与图片；
`HUAJING_DESKTOP_SMOKE=<毫秒>` 让应用启动后自动走一遍退出流程（可配
`HUAJING_DESKTOP_SMOKE_ACTION=start|stop|restart` 顺带验证服务控制）。

### 后台管理（在桌面控制台里）

网页端没有后台页了：`/admin.html` 已下线，后台管理只存在于**桌面控制台窗口**。
控制台是本地页面，通过主进程代发请求调用 `/api/admin/*`，凭据是每次启动随机生成的
`DESKTOP_TOKEN`（只注入给本机服务，服务端只认回环地址 + 该令牌，令牌不出主进程），
所以打开就能用，不需要再登录一次。

- **账号**：待审核申请与账号管理。申请来自客户端登录页，带用户名、显示名、申请时间；
  点「通过」后账号**立刻可登录**（`pending` 置否），点「拒绝」删掉该条记录。
  待审数量直接显示在「账号」页签的小角标上，为 0 时角标隐藏、整段换成一行提示，
  不再摆一张空表头。账号管理可新建账号、改显示名 / 密码、停用 / 启用、删除
- **运行配置**：请求限流的开关 + 窗口秒数 + 每窗口最大请求数（超额 429）与生图并发上限 1–8，
  改完**即时生效**，分别落盘到 `data/rate-limit.json`、`data/concurrency.json`；
  下面是上游 Magpie 地址（默认 `http://127.0.0.1:3425`）与「测试连通」——
  后者探一次该地址的 `/v1/models`，有 HTTP 响应就算可达（401 也算）。上游地址保存写进
  `data/settings.json`（桌面端为 `<数据目录>\data\settings.json`），**不用重启**
  （生图与配置接口每次请求现取）。只接受 http/https、不能带账号密码，
  非法地址返回 400 `UPSTREAM_INVALID`；这里保存的值优先于 `MAGPIE_BASE_URL` 环境变量
- **反馈**：未处理数量角标、全部 / 未处理 / 已处理筛选；点开看完整内容，
  操作列在「标记已处理 / 标记未处理」之间切换，处理结果同步到客户端的状态列表
- **数据**：累计生成、参与账号、占用空间的统计卡，服务流量（总请求、流量、运行时间、
  限流状态，`data/traffic.json` 重启不丢），生图趋势（今天 / 七天 / 一个月 / 三个月 /
  六个月切换，悬停某个时间点看明细；切回本组时按当前宽度重画一次，隐藏期间不会按兜底宽度定格），
  以及按账号细分、最近生成记录两张长表——它们默认折叠，summary 上写着条数，点开才展开

运行日志按天写入 `logs/YYYY-MM-DD.log`，用桌面端菜单的「运行日志…」直接看，或「打开日志目录」取文件。

### 手动启动

```powershell
npm run install:all   # 首次：装根目录、web/、server/ 的依赖
npm run dev           # 开发模式，热重载
```

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:8787

生产构建（前端产物由后端直接托管）：

```powershell
npm run build          # 构建前端
npm run build:server   # 编译后端
npm start              # 直接启动主服务
```

启动器会读取 `server/.env`（若存在），其中的 `PORT`、`MAGPIE_BASE_URL` 等配置优先于默认值。
桌面端不读 `server/.env`，改 `<数据目录>/config.env`。

旧的 `启动后端.bat` / `停止服务.bat` 已移除；启动、停止、重启在桌面端菜单里做。

## 接口契约

```text
POST /api/images
  请求  { prompt, ratio, category, name, source, referencePath? }   需要登录
        referencePath 为上传接口返回的相对路径（参考图/<文件名>）；
        带它时后端走 Magpie 的 /v1/images/edits（图生图），不带则走文本生成
  成功  { id, imageUrl, model, mimeType, bytes, width, height, ratio }
  失败  { error, code }

POST /api/reference-images
  请求  { name, dataUrl }   data:image/(png|jpeg|webp);base64,...   需要登录
        单张上限 8 MiB（路由 bodyLimit 12 MiB）
  成功  { path, url, width, height, bytes }   201

GET    /api/config      画面比例、原生尺寸、提示词上限、默认值
GET  /api/health      后端与上游 Magpie 的连通状态
POST /api/shutdown    优雅退出：补写流量、关日志流后退出
                      需请求头 x-shutdown-token（桌面端每次启动注入随机值；
                      服务端未配置令牌时不注册此接口）
GET  /api/queue       生图闸门状态：{ busy, active, limit, waiting }
GET  /api/files/*     生成图片（支持 类别/文件名 与旧版 UUID 两种形式）
GET  /api/history     当前账号的生成记录（提示词、耗时、画幅、像素、图片地址、token 用量）

GET    /api/projects            项目列表（仅当前账号自己的）{ projects, activeProjectId }
GET    /api/projects/:id        项目详情（仅限本人项目）
POST   /api/projects            新建项目 { name?, fileName? }（归属当前账号）
PATCH  /api/projects/:id        更新项目 { name?, assets?, styles?, defaultStyle?, bulkParams? }
DELETE /api/projects/:id        删除项目
POST   /api/projects/:id/activate  设为当前项目

GET /api/styles   当前账号的风格库
PUT /api/styles   保存当前账号的风格库

POST /api/auth/login   登录 { username, password } → { user }
POST /api/auth/logout  登出
GET  /api/auth/me      当前登录用户
PATCH /api/auth/me    自助修改显示名 { displayName }（用户名不变；重名 409）
GET  /api/auth/status  账号库状态（登录页用）{ needsSetup, setupEnabled, registrationOpen }
POST /api/auth/setup   引导创建首个管理员（需管理密钥，且账号库为空）
POST /api/auth/register 自助申请账号 { username, displayName?, password }
                        只落一条待审核记录，账号还不能登录；
                        返回 { status: 'pending', username }，
                        待审核申请超过 30 条后返回 429（防止灌队列）

GET    /api/admin/users   账号列表            管理员
POST   /api/admin/users   新建账号            管理员
PATCH  /api/admin/users/:id  改显示名/密码/启停  管理员
DELETE /api/admin/users/:id  删除账号          管理员
GET    /api/admin/stats   生图统计            管理员
                          （accounts 按累计 token 降序，带 tokenCount/avgTokens；
                          另返回 avgTokens 与 ratioStats[]：画幅→张数/累计 token/均值）
GET    /api/admin/registrations          待审核的自助申请列表  管理员
POST   /api/admin/registrations/:id/approve  通过申请（账号立即可登录）  管理员
POST   /api/admin/registrations/:id/reject   拒绝申请（删除该记录）      管理员
GET    /api/admin/quotas  每账号每日额度与今日用量  管理员
PUT    /api/admin/users/:id/quota  设置每日额度 { dailyLimit }（0=不限额） 管理员
GET    /api/admin/concurrency  生图并发上限与在途情况  管理员
PUT    /api/admin/concurrency  运行时调整并发上限 { limit: 1–8 }，立即生效并落盘  管理员
GET    /api/quota        当前账号的今日额度状态（登录即可）
POST   /api/feedback     提交意见反馈 { category: bug|suggestion|other, content, page?, appVersion? }
                         内容 5–2000 字；同一账号 60 秒内最多 3 条，超出返回 429（登录即可）
GET    /api/feedback/mine?limit=20  本人最近反馈（按时间倒序，登录即可）
GET    /api/admin/feedback?status=all|new|resolved&limit=200  反馈列表 + counts  管理员
PATCH  /api/admin/feedback/:id  标记处理状态 { status: new|resolved }  管理员
GET    /api/admin/upstream   上游地址与来源（后台设置 / 环境变量）  管理员
PUT    /api/admin/upstream   保存上游地址 { baseUrl }，立即生效、不用重启  管理员
                              只接受 http/https、不带账号密码；非法返回 400 UPSTREAM_INVALID
POST   /api/admin/upstream/test  按传入地址探一次连通性，不保存  管理员
GET    /api/update/status   版本检查（?force=1 绕过缓存）
                            本机回环请求免登录，局域网其他设备需登录
                            返回 currentVersion / latestVersion / hasUpdate / releaseNotes /
                            pageUrl / downloadUrl / downloadName / publishedAt / checkedAt /
                            source(github|custom|none) / disabled / error
GET    /api/admin/stats/trend?range=today|7d|30d|90d|180d
                          生图趋势折线图数据  管理员
                          （today 按小时分桶，其余按天分桶，取自本地 usage.json）
```

错误码：`INVALID_PROMPT`、`PROMPT_TOO_LONG`、`RATIO_INVALID`、`FEEDBACK_INVALID`、`AUTH_REQUIRED`、`AUTH_INVALID`、`AUTH_FORBIDDEN`、`AUTH_PENDING`、`UPSTREAM_UNREACHABLE`、`UPSTREAM_TIMEOUT`、`UPSTREAM_ERROR`、`UPSTREAM_BAD_RESPONSE`、`UPSTREAM_INVALID`、`IMAGE_INVALID`、`IMAGE_UNSUPPORTED`、`CONCURRENCY_INVALID`、`RATE_LIMITED`、`QUOTA_EXCEEDED`、`INTERNAL_ERROR`。

`imageUrl` 是后端绝对地址（依据 `PUBLIC_BASE_URL` 或请求 Host 推断），因此前端部署在任何端口都能正确取图。

### 图片落盘规则

生成后自动存到本地 `generated/`，**按资产类型分文件夹，文件名用资产名**：

```text
generated/
├── 角色/苏晚棠-1086x1448.png
├── 场景/潇湘馆正厅-1672x941.png
├── 道具/青霜剑-1254x1254.png
├── 自由创作/自由创作-20261025-110448-1254x1254.png
└── 单张创作/单张-20261025-143052-1254x1254.png
```

- 文件名主体是资产名，后缀是实际像素尺寸，方便肉眼核对画幅。
- 同名资产重复生成不会互相覆盖，自动加 `-2`、`-3` 序号。
- 资产名里的 Windows 保留字符（`< > : " / \ | ? *`）会被替换成下划线，`..` 等路径片段也会被清洗，杜绝越权写入。
- 需要改存储位置就设 `STORAGE_DIR` 环境变量（见 `server/.env.example`）。

## 画面比例与输出尺寸

画幅只在后端 `server/src/config.ts` 定义一次，前端通过 `/api/config` 动态渲染，不再硬编码两遍。

| 画幅 | 上游原生输出 | 比例偏差 |
| --- | --- | ---: |
| `1:1` | 1254 × 1254 | 0.000% |
| `4:3` | 1448 × 1086 | 0.000% |
| `3:4` | 1086 × 1448 | 0.000% |
| `16:9` | 1672 × 941 | -0.053% |
| `9:16` | 941 × 1672 | 0.053% |

处理方式：

- **画幅靠提示词锁定**。服务端把「画面比例 16:9，宽银幕横向构图，宽幅画幅」这类描述追加到提示词末尾，上游会按此构图。
- **尺寸直接交付原图**。上游按画幅输出的原生尺寸已足够准确，因此不做任何缩放、裁切或补边，交付的就是上游原图。

同一提示词重复生成三次，输出尺寸完全稳定（1:1 恒为 `1254×1254`，16:9 恒为 `1672×941`），
说明尺寸由模型内部按画幅固定。接口返回的 `width` / `height` 取自图片文件头读取的真实像素，
而不是配置里的声明值。

### 为什么没有分辨率选项

上游**不认任何尺寸参数，也不认提示词里的分辨率描述**。Magpie 的 `/v1/images/generations`
会把请求体原样透传给上游，以下调用全部返回**同一尺寸**，说明参数被直接忽略：

| 调用方式 | 实际输出 |
| --- | --- |
| 不传任何参数 | 1312 × 1199 |
| `size: "1024x1024"` | 1312 × 1199 |
| `size: "2048x2048"` | 1312 × 1199 |
| `quality: "high"` | 1312 × 1199 |
| `quality: "hd"` | 1312 × 1199 |
| `size` + `quality` 组合 | 1374 × 1145 |
| `output_format` / `response_format` | 1374 × 1145 |

提示词层面同样无效，以 1:1 为主体追加十种分辨率写法，输出尺寸**全部是 `1254×1254`**：

| 提示词追加内容 | 实际输出 |
| --- | --- |
| （不追加，仅写比例） | 1254 × 1254 |
| `输出分辨率 1024x1024` | 1254 × 1254 |
| `输出分辨率 2048x2048` | 1254 × 1254 |
| `输出分辨率 4096x4096` | 1254 × 1254 |
| `分辨率 1024 像素` | 1254 × 1254 |
| `宽 1024 高 1024 像素` | 1254 × 1254 |
| `2K 分辨率` | 1254 × 1254 |
| `4K 超高清分辨率` | 1254 × 1254 |
| `Render at 1024x1024 pixels` | 1254 × 1254 |
| `Render at 2048x2048 pixels` | 1254 × 1254 |

结论：**画幅（宽高比）能被提示词控制，像素尺寸不能**。既然如此，提供分辨率选项只会让用户
误以为能控制它 —— 所以界面只保留画幅，像素尺寸完全交给上游决定。

`codex/gpt-image-2` 也是 Magpie 中唯一能真正绘图的模型，其余模型在该端点只会返回文字。

## 账号与统计

### 首次部署

账号库为空时，登录页会显示引导界面。需要 `server/.env` 里配置管理密钥：

```ini
ADMIN_SETUP_KEY=换成你自己的长随机串
```

用它创建第一个管理员（会自动登录并进入后台）。**创建完成后这个接口就失效了**（账号库非空即拒绝），
所以管理密钥只在首次部署时有用。管理页建好管理员后，建议把 `ADMIN_SETUP_KEY` 清空。

### 登录与权限

| 角色 | 能做什么 |
| --- | --- |
| 管理员 | 生图 + 在桌面控制台里管账号（建账号、看统计、停用/删除账号） |
| 普通用户 | 只能生图 |

- 客户端可以**自助申请**账号，但注册不由申请人自己完成：
  `POST /api/auth/register` 只写入一条 `pending` 记录，登录接口对这类账号一律返回
  403 `AUTH_PENDING`（密码正确才告知「等待审核」，密码错误仍按「用户名或密码不正确」处理，
  不泄露账号状态）。管理员在**桌面控制台的「待审核」**里点「通过」之后，
  `pending` 置为 false，账号才算真正注册成功、才能登录；点「拒绝」会删除这条记录。
- 审核期间账号不出现在账号列表、额度表和统计里（它们只认已通过审核的账号）。
- 密码用 `scrypt` 加随机盐哈希存储，文件里没有明文。
- **显示名唯一**：去掉首尾空格后不区分大小写比对，待审核的申请也占名；
  自助改名、管理员改名、注册与新建账号都走同一条校验，重复时返回「这个名称已被使用，换一个试试」。
  登录用的**用户名不可改**（它是账号主键，改了会连带影响登录与历史归属）。
- 会话用 HttpOnly Cookie，有效期 7 天；会话令牌落盘到 `<dataDir>/sessions.json`，
  **重启服务、停用后再启动都不会掉登录**，只有主动退出、账号被停用/删除或超过 7 天才失效。
  `SESSION_SECRET` 只用于 Cookie 签名，留空时每次启动随机生成也不影响登录状态。
- 停用账号后该账号立即无法登录。

页面与接口双重把关：未登录访问工作台会跳转到登录页，未登录调用生图接口直接拒绝。

### 数据按账号隔离

- **项目**：每个项目记录归属账号（`ownerId`），项目列表、详情、修改、删除、激活
  全部只针对本人项目，访问他人项目一律返回 404，不泄露存在性。
- **风格库**：每个账号一份独立文件 `styles/<userId>.json`，互不可见。
- **生成记录**：`/api/history` 只返回当前账号自己的生图记录，含提示词全文、
  生成耗时、画幅、像素尺寸、文件大小与图片地址。

### 局域网访问

- 后端默认监听 `0.0.0.0:8787`，CORS 放行本机回环与私有网段（192.168 / 10 / 172.16-31）来源。
- 开发模式 Vite 监听 `0.0.0.0:5173`，前端 API 走同源相对路径，由 Vite 把 `/api`
  代理给本机后端；局域网设备直接访问 `http://<主机IP>:5173` 即可。
- 生产构建由后端直接托管前端产物，天然同源，局域网设备访问 `http://<主机IP>:8787`。

### 生图统计

每次生图都会记一条，落在 `usage.json`。统计记录的是**账号**，不是浏览器，
所以换设备登录同一账号，历史记录照样在。

后台能看到的：

- 累计生成张数、占用空间、参与账号数
- **生图趋势折线图**：今天（按小时）/ 七天 / 一个月 / 三个月 / 六个月（按天），
  纯前端 SVG 绘制，零依赖；数据取自本地 `usage.json`，悬停数据点可看具体数值
- **按账号细分**：每个账号生成了多少张、占了多少空间、最近生成时间、占比条
- 最近 50 条生成明细：时间、账号、资产类型、名称、画幅、像素尺寸、文件大小

### token 用量

每次生图都会记录 token 消耗，展示在生成记录里（大图下方也有一份）：

- **上游返回真实值**时记 `tokensSource: upstream`（OpenAI 系图像接口的
  `usage.input_tokens / output_tokens / total_tokens`，网关透传即可拿到）
- **上游不返回**时降级为本地估算并标注「估算」——中日韩字符按 1 字 1 token、
  其余按 4 字符 1 token 粗算，只用于判断提示词长度，**不能当计费依据**
- 图像生成的「输出 token」在上游不提供时为 null，只有提示词（输入）可计

### 本地数据文件

全部落在项目根目录（路径可用环境变量改）：

```text
users.json    账号库（用户名、密码哈希、角色、启停状态）
usage.json    生图统计与生成记录（含提示词、耗时、图片相对路径）
styles/       风格库目录（每个账号一份 <userId>.json）
generated/    图片文件
```

`usage.json` 会随生图量增长，长期使用建议定期归档。

## 生图并发闸门

打向上游的生图请求有全局上限（默认 5，范围 1–8），可在**桌面控制台 → 后台管理 → 限流与并发**里运行时调整：
保存后立即生效，写入 `data/concurrency.json`，服务重启后沿用。批量页的「并行数」不会超过它。

- 前端默认并行 5（实测上游约 5 个并发槽），可在批量页 1–8 之间调整；调到 1 即逐张生成。
- 上限对所有标签页、所有账号合计生效，避免多端同时刷上游触发风控。
- 优先级：`data/concurrency.json`（后台设置）> `IMAGE_CONCURRENCY` 环境变量 > 默认 5。
- 每日额度按「今日已用 + 在途」判断，并行时不会超发。
- `/api/queue` 可查看 `{ busy, active, limit, waiting }`。

## 资产批量工作台

位于 `http://127.0.0.1:5173/batch.html`。

- **导入一个 JSON = 新建一个项目**。每个项目是一份独立的资产数据，互不干扰，
  可随时切换、删除。项目存在后端 `projects.json`（可用 `PROJECT_DATABASE_PATH` 改路径），
  换浏览器、换机器打开同一地址都能读到同一批项目。
- 点右上角「项目」打开项目抽屉：查看全部项目、切换、删除，或新建空项目。
- 导入顶层为 `role`、`scene`、`prop` 的资产 JSON。
- 角色解析 `【字段】: 内容`，场景和道具解析分号分隔字段。
- 角色、场景、道具分别成页，自动统计数量，支持搜索与分页。
- **同一角色 / 同一场景自动归组**：
  - 角色名按 `-`、`·`、`（…）` 等后缀或「状态 / 形态 / 阶段 / 时期」字段识别状态；
  - 场景名按同一套后缀规则或「子场景 / 区域 / 分区 / 场景类型」字段识别区域，
    例如 `皇宫-主殿`、`皇宫·偏殿`、`皇宫（外景）` 归到「皇宫」；
  - 父行汇总全部状态/区域（整组勾选、展开/收起、整组进度），展开后缩进列出；分页按组切分，
    同一主体不会被拆到两页。道具不做分组。
- **角色面部参考图**：角色表「面部参考」列可上传一张脸（PNG / JPEG / WebP，≤ 8 MB），该角色的所有状态共用，
  生成时连同图片一起发给 Magpie 的 `/v1/images/edits`，并在提示词里追加面部一致性要求。
  参考图存在图片目录的 `参考图/` 下，项目里只记相对路径；「清除」只解绑，不删除文件。
- **历史生成图与主要图片**：每条资产保留最近 20 张历史（新→旧），编辑弹窗底部列出，点「设为主要」选定主图。
  表格结果列、弹窗预览、单张下载都取主图；每次重新生成会把新图设为主图。
  打开弹窗时会按「名称 + 类型」从账号生成记录回填最多 500 条里的旧图（不同项目的同名资产可能混入，属已知限制）。
- **批量下载所选**：工具栏按钮只下载所选资产的主图，没有图的自动跳过；
  浏览器可能询问是否允许下载多个文件，文件名为 `<资产名>-主图-<尺寸>-<时间>`。
- 风格设定页提供三套互不干扰的风格库（角色/场景/道具），每套可新建、编辑、删除、设默认。
  风格属于**当前项目**，不同项目可以各用各的。
- **风格库导出 / 导入**：风格库标题右侧的两个按钮可把三套风格与各自默认项导出为
  `画境-风格库-YYYYMMDD-HHmmss.json`（`format: huajing-styles`、`version: 1`）；
  导入按名称合并（同名覆盖描述、保留本地 id，新名称追加，不删除现有风格），
  文件里的默认项能按名称对上时会一并设为默认。单文件上限 2 MB。
- 生成时以风格描述为最高优先级，拼接在资产内容之前。
- 每项资产独立保存提示词、比例、风格、状态与结果；导入数据存在浏览器 `localStorage`。
- **自由创作的提示词草稿、画面比例、上次生成结果都会随刷新保留**（存在同一份本地数据里），
  用最大化编辑器修改后同样会立即写入，不会因为刷新丢字。
- **自由创作支持参考图**：在提示词框里**粘贴图片**或把图片**拖进提示词框**即可添加，
  缩略图悬浮在文本框上沿（悬停出现「替换 / 移除」，点缩略图看大图），工具栏不新增按钮；
  有参考图时生成走 `/v1/images/edits`（图生图），提示词留空会用一句默认描述兜底。
  参考图只记相对路径与地址，刷新后仍在；单张 ≤8 MB，仅支持 PNG / JPEG / WebP。
- **改自己的名称**：头像菜单 →「修改名称」可以改自己的**显示名**（登录用的用户名不变）。
  名称在账号库里唯一，重名会被拒绝并给出提示；最多 24 个字，改完头像首字与菜单里的名字立即更新。
- **关于画境 / 检查更新**：头像菜单 →「关于画境 v1.0.6」显示当前版本，打开时自动检查一次，
  也可点「重新检查」；有新版本时列出更新说明，并给「下载安装包 / 前往发布页」
  （没有直链就只去发布页）。启动 6 秒后还会静默查一次，有更新时头像出现红点、
  菜单项显示「有新版本 vX」；同一标签页 2 小时内不重复检查。桌面端菜单里也有「检查更新…」

#### 意见反馈

- 入口在客户端右上角头像菜单 →「意见反馈」：类型分「缺陷 / 建议 / 其他」，正文 5–2000 字，
  提交时一并带上当前页面与版本号，方便定位问题。
- 反馈落在服务端 `data/feedback.json`（桌面端为 `<数据目录>/data/feedback.json`）；
  同一账号 60 秒内最多 3 条，超出会提示「提交得有点频繁」。
- 提交成功后弹窗切到「已提交」，并列出本人最近 3 条反馈的处理状态；关掉再打开仍能看到。
- 管理员在后台页「用户反馈」区块查看：未处理数量角标、全部/未处理/已处理筛选、
  内容点击展开整条，操作列在「标记已处理 / 标记未处理」之间切换，处理结果会同步到客户端的状态列表。
- 最多保留最近 2000 条，超出后丢弃最旧的。

#### 本地缓存按账号隔离

同一台电脑、同一个浏览器上换账号，**不能再看到上一个人的工作区**。做法与约定：

- 快照键带账号 id：`moying.assetStudio.v2.<userId>`（资产、风格、批量参数、
  自由创作草稿 / 比例 / 上次生成图、当前页签都在里面，并额外记一份 `ownerId`）；
  未完成任务的键同理：`moying.pendingJob.v2.<userId>`（值里也带 `userId`，双重校验）。
- **启动顺序是「先认人、再渲染」**：页面先等 `/api/auth/me` 拿到当前账号，再读该账号的
  快照并渲染。以前是同步读全局快照再渲染、身份后到，所以换账号会先把上一账号的
  草稿和图片画上屏，而且之后不再覆盖 —— 这就是「换账号还是上一个账号页面」的根因。
  身份校验失败（非 401/403）时页面保持空态并提示刷新，不会把旧内容当正常状态显示。
- **旧键 `moying.assetStudio.v1` 只在能证明归属时迁移**，两条证据任一成立即认领：
  1）快照里的 `activeProjectId` 属于当前账号（`GET /api/projects/:id` 查他人项目返回 404）；
  2）快照里上次生成的图片出现在当前账号的生成记录里（按路径比对，换 IP 访问也能对上）。
  两条都不成立就**原样保留、绝不猜测**。旧版 `moying.pendingJob.v1` 同理：
  用任务查询接口证明归属后才接回，否则不接。
- **退出登录保留工作区、清未完成任务**：快照按账号各自留存，下次登录还在；
  只删除当前账号的 `pendingJob`（停掉「后台仍在生成」的假状态）。
- 风格播种（服务端没有风格时用本地风格做初始值）现在只会写当前账号自己的，
  不会再出现「B 继承 A 的风格」。

#### 客户端登录页视觉规范

登录页（`web/login.html` + `web/src/login/login.css`）的令牌来自 `web/src/ui/tokens.css`，与工作台、后台完全同源：

- **同一套暖纸色系**：`--paper #f4f0e6` / 墨绿 `--moss #425a46`，与工作台一致；
  暗色 `prefers-color-scheme: dark` 下换成深纸底，主按钮反白（`--on-moss` 深墨色文字）
- **版式**：420px 单列卡片，品牌标（衬线「境」+ 墨绿圆角块）→ 标题 → 一句说明 →
  分段胶囊切换「登录 / 申请账号」。去掉了原来标题上方的全大写英文小标签
- **表单**：40px 输入框 + 标签在上；焦点是双环（边框转墨绿 + 3px 淡光环）而不是浏览器
  outline；密码框带「显示/隐藏」按钮（内联 SVG，不用 emoji）
- **提示位**：没有错误时显示一句引导语（如「忘记密码可以联系管理员重置」），
  出错时原地变红，不新增元素、不推移按钮（实测按钮位移 0.0px）
- **申请账号**：用户名 / 显示名（可选）/ 密码 / 确认密码，前端先按服务端同一套规则校验，
  提交成功后换成「申请已提交」态并回填用户名，点「返回登录」直接进入登录态
- **对比度**：说明文字 5.55:1、字段提示与页脚 4.6:1（暗色 7.14 / 5.08），均 ≥ 4.5
- **移动端**：390px 下卡片 358px 贴顶排布，无横向溢出；触控目标 ≥ 44px

#### 客户端视觉规范

与桌面控制台、登录页共用一套思路（任务优先、精确克制）。令牌统一在 `web/src/ui/tokens.css`（两页共用，暗色只在那里改值），控件在 `web/src/ui/components.css`，工作台样式按职责拆在 `web/src/batch/*.css`：

- **视觉令牌**：保留暖纸色、墨绿与陶土橙品牌色，统一 `--surface-raised/subtle`、边框、圆角与控件高度；外壳只留一层轻边界和淡投影，内部工作区用细线与低明度差分层，不叠卡片阴影。字号只用 12/13/14/16/20/28 六档，间距为 4 的倍数
- **页面外壳不做入场淡入**：`opacity: 0` 起始的容器动画在窗口被遮挡、最小化或截图取景时会停在首帧，整页看起来是空的；微动效只留在弹层、缩略图与状态胶囊上
- **顶栏与导航**：42px 品牌标 +「画境 / 资产创作工作台」组成紧凑顶栏；六个主入口使用下划线指示当前页，资产数量保留等宽数字，窄屏可横向滚动
- **文字与控件**：正文和表格主要内容使用 12–14px，辅助信息使用 11–12px；按钮、输入框和选择器统一 40px 标准高度，焦点环、选区、光标和滚动条从调色板取色
- **批量工具栏**：第一行放搜索与选择，第二行放画幅/风格/并行参数和生成/下载操作；所有原操作保持不变，宽表只在自身容器内横向滚动
- **自由创作**：提示词表单与画面预览为并列主工作区，输入、比例、生成、进度形成明确顺序；空态使用内联 SVG，下载/最大化仍只在有图后可用
- **弹层与风格页**：风格类型切换、列表和编辑器复用同一套表面与控件；资产弹窗、项目抽屉、提示词编辑器和生成记录统一圆角、间距、关闭按钮及滚动行为
- **提示词悬浮按钮**：只在鼠标进入输入框右上角热区（右 150px × 上 56px）时浮现，
  不再一进输入框就出现；键盘 Tab 聚焦按钮时同样显示
- **滚轮不外溢**：生成记录面板的滚动区设了 `overscroll-behavior: contain`，
  再用「原生优先」的滚轮守卫兜底：方向与速度全部交给浏览器原生滚动，
  只在**已经到顶/到底还继续往外滚**时 `preventDefault`，所以不会带动后面的页面，
  也不会和系统里的反向滚动设置打架（早前版本手动 `scrollTop += delta`，
  方向取决于自己算的增量，增量单位和浏览器对不上时就会「滚轮往下、内容往上」）；
  指针落在面板标题或搜索框上时把滚动转交给列表；列表本身不可滚时照常滚页面
- **移动端**：680px 以下隐藏重复品牌副标题，操作按钮换行，工具组按内容换行；自由创作改为单列、主生成按钮通栏，表格保留内部横向滚动，页面本身不出现横向溢出
- **暗色主题**：`prefers-color-scheme: dark` 下统一使用深纸底与三级深色表面，覆盖卡片、表单、表格、弹层和玻璃按钮；正文与辅助文字保持清晰对比，字重整体调细一档抵消黑底白字的光晕
- **生成中刷新不会丢结果**：提交时前端生成一个任务 ID 并存本地，服务端按该 ID 记录任务状态
  （`GET /api/images/jobs/:id`，仅本人可查）。刷新后页面自动接回进度条并轮询，
  生成完成即显示图片；任务过期或服务重启过则提示重新生成。
- 工具栏的**批量比例与批量风格**按资产类型分别记住，刷新页面后保持上次选择。
  标题下的说明会显示当前批量比例；点「应用到所选」会同时套用比例与风格。
- **风格库存放在后端** `styles.json`（可用 `STYLE_LIBRARY_PATH` 改路径），
  因此换浏览器、换机器打开同一地址都能读到同一份风格；`localStorage` 仅作为离线兜底。
- 批量生成默认并行 5；在工具栏把**并行数**调到 1–8（不超过后台设置的全局上限）即可改变，
  前端用同样多的 worker 分发任务，服务端闸门按当前上限放行。并行时队列面板会同时显示多张进度。
  在桌面控制台调整上限后，刷新批量页即可看到新的可选值。
- **每条资产有独立的进度条**。状态列显示该条资产自己的进度与阶段
  （正在理解画面 → 搭建构图 → 细化光影 → 完成渲染 → 接收图像 → 即将完成），
  排队中的资产显示队列位置，等待时进度条为空但可见。上游生图没有进度回调，
  这里的百分比是按阶段推进的模拟值，完成后会跳到 100%。

## 环境变量

见 `server/.env.example`。常用项：

```text
HOST / PORT                后端监听地址与端口（局域网访问设 HOST=0.0.0.0）
PUBLIC_BASE_URL            对外地址；留空按请求 Host 推断
MAGPIE_BASE_URL            上游 Magpie 网关，默认 http://127.0.0.1:3425（后台保存过 settings.json 后以文件为准）
MAGPIE_IMAGE_MODEL         生图模型，默认 codex/gpt-image-2
IMAGE_CONCURRENCY          同时打向上游的生图请求上限，默认 5（1–8）；后台保存过 data/concurrency.json 后以文件为准
IMAGE_TIMEOUT_MS           单次生成超时，默认 300000
MAX_PROMPT_LENGTH          提示词上限，默认 12000
STORAGE_DIR                图片存储目录，默认项目根 generated/
STYLE_LIBRARY_PATH        风格库目录（每账号一份 <userId>.json），默认项目根 styles/
USER_DATABASE_PATH        账号库文件，默认项目根 users.json
USAGE_DATABASE_PATH       生图统计文件，默认项目根 usage.json
PROJECT_DATABASE_PATH     项目库文件，默认项目根 projects.json
SESSION_SECRET            会话签名密钥，留空则每次启动随机生成（会话令牌已落盘，不影响登录状态）
SHUTDOWN_TOKEN            优雅退出令牌，留空则不注册 POST /api/shutdown（桌面端每次启动注入随机值）
ADMIN_SETUP_KEY           引导创建首个管理员的管理密钥，留空则禁用引导
CORS_ORIGINS              允许的前端来源（已改为自动放行回环与私有网段，此项保留兼容）

APP_VERSION               当前版本号；桌面端注入 app.getVersion()，留空则读 server/package.json
UPDATE_REPO               更新检查的 GitHub 仓库（owner/repo），默认 ikun1946/huajing-image-web
UPDATE_FEED_URL           自定义更新源 JSON 地址；非空时优先于 GitHub，
                          格式 { version, notes?, downloadUrl?, pageUrl?, publishedAt? }
UPDATE_TOKEN              访问 GitHub 的令牌；公开仓库留空即可，私有仓库或触发限流时再填
UPDATE_CHECK_DISABLED     设为 1 则完全不联网查版本，默认关闭（离线环境用）
```

更新检查的默认行为：源为 `https://api.github.com/repos/<UPDATE_REPO>/releases/latest`，
资产优先取名字含 `Setup` 的 exe，其次 `portable`；成功结果缓存 10 分钟、失败 60 秒，
同一时刻只发一个请求、8 秒超时；失败不抛错，只在返回里带中文 `error` 文案。

## 依赖

- 无需安装 `ffmpeg`：图片按上游原生尺寸直接交付，不做缩放或裁切。
- 端口默认：后端 8787，前端 5173。
