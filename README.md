# MoeKoe Siri Control

Siri Shortcut → Control Server → iPad MoeKoeMusic WebUI 播放桥接。

实现遵循 `docs/实施计划` 中**唯一选定方案**：客户端搜索 + `PlayerControl.addSongToQueue()` + 原生
Audio 链路，Control Server 只做 `query/pending` 透传。

## 当前进度

- ✅ **Phase 1**：`getPlayerControl()` 最终实现 + production probe。**设备端已验证通过**
  （可继续 Phase 3）。
- ✅ **Phase 2**：Vite/PWA 构建图内注入 `siri-control.<hash>.js`，`verify:web` 全部通过。
- ✅ **Web host（原 Phase 6 前置，提前实现）**：`server/web-host.js` 同时完成
  `8080 /` → `MoeKoeMusic/dist` 与 `8080 /api/*` → `127.0.0.1:6521/*` 反向代理；
  `/api/register/dev` 经代理返回正确 JSON 与 `KUGOU_API_*` cookies，SPA fallback、
  no-store/immutable 缓存策略均验证通过。
- ✅ **Phase 3（WS 认证/心跳/重连）**：服务端 `server/control-server.js`（8200 `/ws`，
  Origin 校验 + auth + JSON ping/pong 心跳 + `/health`）与客户端 `createWsClient`
  （auth、心跳应答、指数退避重连 ±20% 抖动、liveness 超时）已实现。
  51 个测试全部通过；端到端验证：真实连接 auth.ok + 跨 2 个心跳周期存活；
  生产脚本浏览器冒烟通过（`connected/authenticated=true`）。
- ✅ **Phase 4（搜索→play→ACK）**：客户端命令处理器 `createCommandHandler`
  （play.req 单飞执行：过期检查→同源搜索→`extractFirstSong`→`waitForPlayerControl`→
  `addSongToQueue`→`play.ack`），服务端接收 `play.ack` + `broadcast()`。69 个测试全部
  通过，含端到端全链路（broadcast play.req → 客户端搜索+播放 → 服务端收到 ack）。
  浏览器冒烟：`window.__siri.play('...')` 可直接实机调用。
- ✅ **Phase 5（HTTP API/pending）**：`server/pending.js` pending 协调器（submit 生成
  reqId/expiresAt，ack 到达或 `HTTP_ACK_WAIT_MS` 超时结算）+ `server/http-api.js`
  （`POST /api/siri/play`、`GET /debug/status`，`x-siri-token`/`?token=` 常量时间校验）。
  83 个测试全部通过，含 HTTP 全链路（POST → WS play.req → play.ack → 200 ok）。已重启
  服务实测：curl `/health` OK、`/debug/status` 返回客户端与 pending 状态、node 脚本全链路
  返回 `HTTP 200 {"ok":true,...}`。**Siri 快捷指令现在可以直接调**
  `POST http://192.168.10.236:8200/api/siri/play`。实机验证通过（iPad 登录态恢复后
  play 返回 `ok:true` 并开始播放）。
- ✅ **Phase 5 修复（多客户端抢答）**：实机发现「音乐已播放但 HTTP 返回 `SEARCH_FAILED`」——
  根因是本机与 iPad 同时存在已认证 WS 客户端，`play.req` 广播后本机（未登录）先回
  `SEARCH_FAILED`、pending 只取第一个 ack。修复：① 服务端新增 `sendPlayRequest`，`play.req`
  **只发给一个目标客户端**（优先非 loopback 的 iPad，其次最近认证者），消除重复播放与抢答；
  ② pending 增加 `PENDING_SUCCESS_GRACE_MS`，失败 ack 不再立即结算，短暂等待可能的成功 ack
  （优先成功）。88 个测试全部通过，实机复测 `{"ok":true,"song":{"name":"七里香",...}}`。
- ✅ **Phase 6（PowerShell 启动脚本 + 开机自启）**：`scripts/start-all.ps1`（幂等一键启动
  6521 API + 8080/8200 服务，日志重定向到 `run/`）、`scripts/stop-all.ps1`、
  `scripts/status.ps1`；`npm run start:all / stop:all / status` 可用。进程用
  **WMI（ShowWindow=0）+ 批次文件**完全脱离启动命令的进程树且**无黑框**，命令数秒即返回，
  不再「卡住」。已配置**开机自启**（启动文件夹 VBS 无窗口执行 start-all.ps1）。
- ✅ **Phase 5.5（登录态自动续期 / token 持久化）**：定位到「反复 152」根因 = KuGou
  **登录 token 服务端过期**，而 WebUI 从不调用 `/login/token`（`login_by_token` 刷新接口），
  会话永不复新。客户端新增 `refreshLoginSession`：定期（每 45 分钟，页面可见时）POST
  `/api/login/token` 用当前 token 换取新 token/t1/userid，写回 `localStorage['MoeData']` 并
  同步到实时 Pinia store（WebUI 自身请求也继续用新 token）；搜索遇 `SESSION_EXPIRED` 时
  自动刷新+重试一次，仍失败才向 Siri 回 `SESSION_EXPIRED`。99 个测试全部通过（含
refreshLoginSession 成功/152/网络错/无 token 与 152→刷新→重试成功/失败）。
   已重建 `dist/siri-control.2bcbb4ff28.js`。
- ✅ **Phase 5.6（会话自动恢复 / iPad 配对）**：被挤掉或过期的会话不再需要重新扫码。
  ① `.env` 保存酷狗账号密码（`KUGOU_USERNAME`/`KUGOU_PASSWORD`，只在 Windows 侧）；
  ② iPad 打开一次 `http://192.168.10.236:8080/siri/pair` 输入 `SIRI_HTTP_TOKEN`，
  服务端下发 HMAC 派生的 HttpOnly 配对 Cookie（服务重启仍有效，`/siri/pair` 按 IP
  限 5 次/分钟）；③ WS 握手校验 Cookie，仅配对连接可发 `session.reauth.req`；
  ④ 客户端恢复流程：先 `/login/token`，152/无 token 时经 WS 请求账号密码重登
  （`server/session-auth.js`，15s 超时、单飞、失败 60s 冷却、识别
  RISK_REQUIRED/AUTH_REJECTED/UPSTREAM_UNAVAILABLE），成功仅回传
  `{token,t1,userid,vip_type,vip_token}`，客户端合并进 MoeData 后重试搜索一次；
  ⑤ 风控（error_code 20028 / ssaCode）返回 `RISK_REQUIRED` → Siri 报
  `SESSION_REAUTH_REQUIRED`，iPad 进 `/#/login` 人工验证一次，不强制扫码。
  调试态 `window.__siri.sessionState` / `recoverSession()` 不含任何凭据。
151 个测试全部通过（session-auth 单飞/冷却/超时/风控、配对 HMAC/限流、
   WS reauth 仅回发原 socket、恢复器共享 Promise、恢复搜索单次重试与 reauth 码映射）。
   已重建 `dist/siri-control.2bcbb4ff28.js`。
- ✅ **后台按需唤醒（Media Session 修正 + 离线单槽命令）**：iPad 暂停后页面被系统挂起
   时，Siri 点歌不再返回 `NO_CLIENT`。① **MoeKoeMusic 媒体会话修正**（独立提交
   `55e9a70`）：拆分明确的系统媒体键 `play`/`pause`（原先都调 `toggle`）、维护
   `playbackState`（playing/paused/none）、普通暂停**保留** position 与元数据（不再
   `setPositionState(null)`）、以 `audio` 原生 play/pause 事件为最终状态源——让系统级
   Play 有机会在后台恢复主 Audio（不静音保活、无第二 Audio）；② **离线单槽命令**
   `server/offline-command.js`：无在线 WS 客户端时 `POST /api/siri/play` 返回
   `202 {"ok":true,"status":"queued",reqId,expiresIn}`（TTL 60s），下一条 iPad 认证后自动
   下发，发送连接断线自动重新 queued，状态（queued/dispatched/succeeded/failed/expired/
   superseded，终态保留 120s）可经 `GET /api/siri/commands/:reqId` 查询；在线发送出现
   断线竞态也转入离线槽；③ **客户端唤醒重连**：pageshow/visibilitychange/online/focus
   幂等强制 WS 重连（`window.__siri.ensureConnectedNow()`），加速接收 queued 命令。
   172 个测试全部通过（offline-command 单测 + HTTP 202/状态接口/竞态转 queued）。
   已重建 `dist/siri-control.fe6b848352.js`。
- ✅ **WebUI 音频输出修复（独立 MoeKoeMusic 提交）**：`applyAudioOutputDevice` 按
  [W3C Audio Output](https://www.w3.org/TR/audio-output/) 规范改为空字符串表示默认输出；
  iPad 默认输出不再调用 `setSinkId`、不再弹错误；从非默认设备切回默认调用
  `setSinkId('')`；桌面端明确选择非默认设备且失败时恢复原错误提示。已提交
  `fix(audio): 精确处理音频输出设备切换...`，MoeKoeMusic 工作树恢复 clean，构建守卫保留。

## 目录

```
MoeKoeSiriControl\
├── package.json
├── .env.example          # 复制为 .env 并填写 token
├── .gitignore
├── client\
│   └── siri-control.cjs  # 客户端核心 + probe + WS client + 命令处理器（浏览器/Node 双环境）
├── server\
│   ├── index.js          # 入口：Web host(8080) + 控制服务(8200) + HTTP API + pending/offline 接线
│   ├── config.js         # .env 加载与校验（端口/路径/Origin/token，v1 固定参数）
│   ├── protocol.js       # WS 消息构造/校验/常量时间 token 比较
│   ├── control-server.js # 8200：/health + /ws（Origin/auth/心跳 + play.ack + broadcast + reauth + sendTo）
│   ├── pending.js        # Phase 5：在线 pending 协调器（reqId/expiresAt/ack 结算/超时）
│   ├── offline-command.js # 离线单槽命令（202 queued / 认证后自动下发 / 断线重发 / 状态保留）
│   ├── http-api.js       # Phase 5/7：POST /api/siri/play + GET /api/siri/commands/:reqId + /debug/status
│   ├── session-auth.js   # Phase 5.6：账号密码登录（单飞/冷却/超时/风控识别），凭据不落日志
│   ├── pairing.js        # Phase 5.6：配对 Cookie HMAC 派生/校验 + 每 IP 限流
│   ├── pair-page.html    # Phase 5.6：/siri/pair 配对页
│   └── web-host.js       # 8080 静态 dist + /api → 6521 反向代理 + /siri/pair
├── scripts\
│   ├── build-web.mjs     # 构建 MoeKoeMusic dist + 注入 Siri 脚本
│   ├── verify-build.mjs  # 校验构建产物完整性
│   ├── start-all.ps1     # Phase 6：一键启动 API + Web/控制服务（幂等，日志重定向）
│   ├── stop-all.ps1      # Phase 6：停止相关 node 进程
│   └── status.ps1        # Phase 6：端口监听与进程状态检查
├── test\
│   ├── client-core.test.cjs
│   ├── command-handler.test.js   # Phase 4：命令管线单测
│   ├── phase4-e2e.test.js        # Phase 4：broadcast→play→ack 全链路
│   ├── pending.test.js           # Phase 5：pending 协调器单测
│   ├── offline-command.test.js   # Phase 7：离线单槽命令单测（过期/覆盖/断线重发/终态清理）
│   ├── http-api.test.js          # Phase 5/7：HTTP 全链路（401/400/202/504/200 + 状态接口）
│   ├── protocol.test.js          # Phase 3：消息构造/校验
│   ├── control-server.test.js    # Phase 3：认证/心跳/Origin + Phase 4：ack/broadcast
│   ├── ws-client.test.js         # Phase 3：客户端认证/退避重连/liveness
│   └── fixtures\
│       ├── search-complex.success.json     # ⚠️ 需替换为真实登录抓包
│       ├── search-complex.empty.json
│       ├── search-complex.invalid.json
│       └── search-complex.wrapped-error.txt
└── vite.siri.config.mjs  # 外部 Vite 配置（注入插件）
```

## 前置条件

- Node >= 20（实测 24.19.0）。
- MoeKoeMusic 已 `npm install`（本项目的构建复用其 `node_modules` 与 `vite.config.js`）。

## 安装与配置

```powershell
cd C:\Users\dyk\Desktop\code\MoeKoeSiriControl
npm install
Copy-Item .env.example .env   # 填写 SIRI_HTTP_TOKEN / SIRI_WS_TOKEN
```

Token 要求：各 >= 32 字节随机，两者必须不同；`SIRI_WS_TOKEN` 会嵌入构建产物。
`MOEKOE_DIR` / `MOEKOE_DIST_DIR` 默认指向 `C:\Users\dyk\Desktop\code\MoeKoeMusic`。

## 构建与校验

```powershell
npm run build:web     # 以 MoeKoeMusic 为 cwd 运行 vite build，强制 VITE_APP_API_URL=/api
npm run verify:web    # 校验 index.html/脚本 hash/sw.js/index.html revision/API base/git clean
npm test              # 纯函数单元测试（node --test）
```

## 开机自启（已配置）

无需管理员权限，采用**启动文件夹 + VBS 无窗口**方式：

- 位置：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MoeKoeSiriControl.vbs`
- 登录时无窗口运行 `start-all.ps1`（隐藏窗口），API/Web/控制服务在后台启动。
- 服务进程本身通过 **WMI（Win32_Process.Create，`ShowWindow=0`）+ `run\start-*.cmd`**
  启动，完全脱离终端进程树且**不弹出黑框**。
- **取消自启**：删除上述 `MoeKoeSiriControl.vbs` 即可。
- **临时退出/重启**：`npm run stop:all`（停止）、`npm run start:all`（再启动）、
  `npm run status`（查看）。

> 注意：脚本依赖 PowerShell 5.1 的 `Invoke-WmiMethod`，请勿用 pwsh(7) 运行。

## 启动服务（Phase 6：一键启动 / 停止 / 状态）

```powershell
npm run start:all   # 一键启动：6521 API + 8080 Web host + 8200 控制服务
npm run status      # 检查端口监听与 node 进程状态
npm run stop:all    # 停止本项目相关 node 进程
```

- `start:all` **幂等**：端口已在监听则跳过；日志重定向到 `run\web-host.log`、
  `run\web-host.err.log`、`run\api.log`、`run\api.err.log`；轮询等待端口就绪
  （最多约 10s）后报告状态。
- 端口/路径从 `.env` 读取（`MOEKOE_API_PORT` / `WEB_PORT` / `CONTROL_PORT` /
  `MOEKOE_DIR` / `MOEKOE_DIST_DIR`），缺省与上文一致。
- 服务进程通过 **WMI（Win32_Process.Create）+ `run\start-*.cmd` 批次文件**启动，完全脱离
  当前终端进程树 → `start:all` 数秒即返回提示符，不会卡住。
- `stop:all` 只匹配 `server/index.js` 与 `api/app.js` 两个目标，不影响其它 node 进程。

`server/index.js` 启动两个服务：

- **8080 Web host**：
  - `GET /` 与静态资源 → `MoeKoeMusic/dist`
  - `GET /api/*` 与 `POST /api/*` → 反代到 `http://127.0.0.1:6521/*`（剥离 `/api` 前缀，
    透传 Cookie/Authorization/Set-Cookie/query）
  - `index.html` / `sw.js` / `manifest.webmanifest` → `Cache-Control: no-store`
  - 带 hash 的 JS/CSS/图片 → `public, max-age=31536000, immutable`
  - 其它 GET → SPA fallback 到 `index.html`
- **8200 控制服务**（Phase 3）：
  - `GET /health` → `{"ok":true,"protocol":1}`
  - `ws://<host>:8200/ws` → 见下方「Phase 3 WS 协议」

启动时会探测 6521 上游，探测失败仅告警（QR/榜单会 502，但 WebUI 仍可打开）。

```text
MoeKoeSiriControl\run\web-host.log    # 两个服务的 stdout 日志
MoeKoeSiriControl\run\api.log         # 上游 API 日志
```

## Phase 3：WS 协议

```
连接  ws://<host>:8200/ws
client -> {"type":"auth","token":"<SIRI_WS_TOKEN>","version":1}   （连接后立即）
server -> {"type":"auth.ok","version":1}
server -> {"type":"auth.error","reason":"..."}   （随后关闭）
server -> {"type":"ping","t":<ms>}               （每 15s）
client -> {"type":"pong","t":<回声>}             （必须在 10s 内应答）

（认证后，Phase 5 服务端才会下发 play.req；Phase 5 修复后 **只发给一个目标客户端**
（优先非 loopback），避免多客户端抢答；Phase 4 阶段用 broadcast 测试）
server -> {"type":"play.req","reqId":"<uuid>","query":"<关键词>","expiresAt":<ms>}
client -> {"type":"play.ack","reqId":"<同值>","ok":true,"song":{"hash","name","img","author"}}
client -> {"type":"play.ack","reqId":"<同值>","ok":false,"error":"<CLIENT_ERROR>"}
```

- **Origin 校验**：Origin 存在但不在 `WEB_ORIGINS` → 立即关闭（1008）。无 Origin 的非浏览器
  客户端放行（WS token 本身即凭据）。
- **auth 超时**：5s 内未收到合法 `auth` → 关闭（1008）。
- **心跳**：服务端 15s 发 `ping`，10s 未收到 `pong` → 终止连接；错过的 pong 会在下一拍被
  安全网终止。
- **客户端重连**：指数退避（1s 起，2 倍，上限 30s）+ ±20% 抖动；认证成功后重置退避。
  `auth.error` 视为永久失败（不重连，等待页面刷新）；liveness 超时（45s 无任何服务端消息）
  主动断开重连。
- **安全**：日志不记录 token/Authorization/歌曲 URL；token 比较使用常量时间。

## Phase 4：客户端命令管线（搜索→play→ACK）

```
play.req ──► createCommandHandler.handleMessage
  1. 校验 reqId/query；过期（now > expiresAt）→ COMMAND_EXPIRED
  2. 单飞（busy 中再收到 play.req → 立即 ack BUSY）
  3. search(query) ──► GET /api/search/complex?keywords=<encode>（credentials:include
     + 从 localStorage.MoeData 构造 Authorization，与 request.js 完全一致）
  4. extractFirstSong(payload) → {hash,name,img,author}
  5. getPlayer() ──► waitForPlayerControl({timeoutMs:15000})，非 player 路由自动回 Index
  6. player.addSongToQueue(hash, name, img, author)
  7. play.ack：ok:true + song | ok:false + CLIENT_ERROR
```

- `CLIENT_ERRORS`：`COMMAND_EXPIRED / SEARCH_FAILED / NO_RESULTS / INVALID_RESULT /
  NO_HASH / PLAYER_NOT_READY / AUTOPLAY_BLOCKED / PLAY_FAILED / BUSY`。
- `window.__siri.play(query)`：绕过服务端直接触发完整管线（无 HTTP 层时的实机验证入口），
  返回 ack 结果；`lastCommand / lastSong / lastAck / lastError` 暴露最近状态。
- `createWsClient` 新增 `onMessage(msg)` 回调与公开 `send(obj)`；服务端新增
  `broadcast(obj)`（仅发已认证客户端）与 `handlers.onAck(ack)`（Phase 5 接 pending）。
- 搜索必须与 WebUI 同源身份执行（Cookie + MoeData 构造的 Authorization）；
  播放只经 `addSongToQueue` 原生链路，服务端不做搜索/不透传歌曲 URL。

## Phase 5 / 7：HTTP API / pending / 离线单槽命令

```
POST http://<host>:8200/api/siri/play           Header: x-siri-token: <SIRI_HTTP_TOKEN>
      body: {"query":"七里香"}  或  ?query=...&token=...
GET  http://<host>:8200/api/siri/commands/:reqId Header: x-siri-token（查询离线命令状态）
GET  http://<host>:8200/debug/status             Header: x-siri-token（调试/健康检查）
```

- **在线流程**：校验 token（`x-siri-token` 或 `?token=`，常量时间比较）→ 检查至少一个已认证
  WS 客户端 → `pending.submit(query)` 生成 `reqId` + `expiresAt` → 向**一个**目标客户端
  `sendPlayRequest(play.req)` → 等待 `HTTP_ACK_WAIT_MS` 内 `play.ack` → 返回 ack。
- **离线流程（Phase 7）**：`authenticatedClients() === 0` 时不再返回 `503 NO_CLIENT`，
  而是把 query 存入**单槽** `offline-command.js` 并返回
  `202 {"ok":true,"status":"queued",reqId,expiresIn}`（TTL 60s，新命令覆盖旧命令）；
  下一条 iPad WS 认证成功后自动下发该 `play.req`（只发一次，同 reqId 不并行），
  发送连接在 ACK 前断开则自动重新 `queued`（TTL 内可重发）。在线发送出现断线竞态
  （`sendPlayRequest` 返回 0）同样转入离线槽返回 202。
- **命令状态接口**：`GET /api/siri/commands/:reqId`（同样用 `x-siri-token`）返回
  `{"ok":true,reqId,status}`；`status` 为 `queued`/`dispatched`（带 `expiresIn`）、
  `succeeded`（带 `song`）、`failed`（带 `error`）、`expired`/`superseded`；终态保留
  120 秒供快捷指令查询后清理；未知或已清理返回 `404 {"ok":false,"error":"COMMAND_NOT_FOUND"}`。
- 响应：
  - `200 {"ok":true,"reqId","song":{hash,name,img,author}}`（在线已入队播放）
  - `202 {"ok":true,"status":"queued",reqId,expiresIn}`（无在线客户端 / 竞态转离线）
  - `200 {"ok":false,"reqId","error":"<CLIENT_ERROR>"}`（搜索/播放失败等）
  - `401 UNAUTHORIZED` / `400 BAD_REQUEST` / `504 TIMEOUT`
- 服务端不搜索、不解析歌曲 URL，只做 pending/offline 透传；pending 有独立超时自清理。
- Siri 快捷指令（“Get Contents of URL” action）即可调用，无需控制台。

构建流程（禁止 build 后直接改 HTML）：

```text
build-web.mjs
  → .env 校验（token 长度/互异）
  → MoeKoeMusic git status 必须 clean
  → vite build --config vite.siri.config.mjs
      → transformIndexHtml 在 </body> 前注入 <script defer src="./siri-control.<hash>.js">
      → generateBundle 写出 siri-control.<hash>.js
      → VitePWA closeBundle 生成包含该文件的 sw.js + 新 index.html revision
  → verify-build.mjs
```

## Phase 1：`getPlayerControl()` 设计

- Router 优先读 `app.config.globalProperties.$router`，`app._context.provides` 仅作版本兼容 fallback。
- `matched[].instances.default` 是**路由组件的 public proxy**（不是内部 ComponentInternalInstance），
  因此只读 `playerControl` / `$props.playerControl` / `$attrs.playerControl`，
  绝不读 `instance.props.playerControl`。
- PlayerControl 每次命令重新解析、不缓存；卸载后 proxy 不保留。
- `/lyrics`、`/video` 不是 HomeLayout 子路由 → 返回 null；`waitForPlayerControl` 会自动
  `router.replace({name:'Index'})` 后轮询最多 8s。

### 自动化验证结果（已通过）

| 项 | 结果 |
|---|---|
| 34 个单元测试（extractFirstSong / normalizeSearchResponse / getRouter / playerFromRouteProxy / getPlayerControlFromApp / waitForPlayerControlFromApp） | ✅ pass |
| production build 注入 + verify-build 11 项检查 | ✅ pass |
| 主 bundle 默认 API base 为 `/api`（无 `127.0.0.1:6521` 残留） | ✅ |
| MoeKoeMusic `git status --short` 无输出 | ✅ |
| 浏览器脚本冒烟（模拟 window/document） | ✅ |

### 设备端手工验证（✅ Phase 1 已通过，以下为 Phase 3 实机核验项）

前置：`npm run start:all`（6521 API + 8080/8200 服务），防火墙放行 8080/8200。

1. iPad Safari 打开 `http://192.168.10.236:8080`（WebUI 默认 API base 就是 `/api`，
   经 Web host 反代到 6521，**无需**手工改 RPC 地址）。可先验证
   `http://192.168.10.236:8080/api/register/dev` 返回 JSON（而非 index.html）。
2. 打开控制台，检查：

   ```js
   window.__siri.version        // 应为构建时的版本号
   window.__siri.connected      // 应为 true（ws 传输已建立）
   window.__siri.authenticated  // 应为 true（auth.ok 已收到）
   window.__siri.wsState        // 应为 'ready'
   window.__siri.probe()        // 返回当前路由 matched 报告
   window.__siri.probeAll()     // 遍历全部路由后回首页，输出各路由报告
   ```

3. 逐项核对 probe 报告：
   - `vueAppFound: true`、`routerFound: true`。
   - 每个 HomeLayout 子路由（Index/Discover/Library/Login/Settings/PlaylistDetail/Search/
     RecommendedSearch/Ranking/CloudDrive/LocalMusic/Recognize）`playerControl.found: true`，
     且 `addSongToQueueType: 'function'`、`playingType: 'boolean'`。
   - `/lyrics`、`/video` `playerControl: null`。
   - 无 `instance.props` 依赖（`$props`/`$attrs` 均可命中）。
4. 同时核对 WebUI 业务可用性（此前因缺代理全部失效）：登录/二维码、榜单、推荐、
   搜索均能加载数据。
5. Phase 3 核验：确认控制台输出无 `auth rejected`/`auth timeout`；可在笔记本上
   `curl http://192.168.10.236:8200/health` 得到 `{"ok":true,"protocol":1}`。
6. Phase 4 实机核验（无 HTTP 层，直接走客户端管线）：
   `await window.__siri.play('七里香 周杰伦')` 应返回
   `{ok:true, song:{hash,name,img,author}}` 且 WebUI 开始播放；错误时 `ok:false` 带
   `CLIENT_ERROR` 码。核对 `window.__siri.lastSong / lastAck / lastError`。
7. Phase 5 实机核验（需保持 WebUI 前台打开且已登录，PlaylistDetail 之外的页面均可；
   无需控制台）：在笔记本上执行
   `curl -H "x-siri-token: <SIRI_HTTP_TOKEN>" -H "Content-Type: application/json" -d '{"query":"稻香"}' http://192.168.10.236:8200/api/siri/play`
   应返回 `{"ok":true,"reqId":"...","song":{...}}` 且 iPad 开始播放。随后在 Siri 快捷指令
   中按同参数配置 “获取 URL 内容” 动作。
8. 抓取一份**已登录** `/search/complex` 成功响应，脱敏后替换
   `test/fixtures/search-complex.success.json`，并重跑 `npm test`。

**Phase 3 实机核验已通过，进入 Phase 4（搜索→play→ACK）；Phase 5 HTTP 全链路自动化已通过。**

## Phase 2 已实现

- `vite.siri.config.mjs`：外部注入插件（常量替换 → SHA-256 短 hash → `generateBundle`
  输出 → `transformIndexHtml` 注入一次）。
- `scripts/build-web.mjs` / `scripts/verify-build.mjs`。
- 缓存策略：内容 hash 文件名；`index.html`/`sw.js`/manifest 使用 no-store；带 hash 的
  JS/CSS/图片使用 immutable cache（已由 `server/web-host.js` 实现并验证）。

## 运行依赖一览

```text
6521   MoeKoeMusic API   node api/app.js --platform=lite --port=6521
8080   Web host          server/index.js（static dist + /api → 6521）
8200   控制服务(WS+HTTP)  server/index.js（/health + ws://:8200/ws + /api/siri/play + /debug/status）
```

三者在 `npm run start:all` 中一并启动。

### Docker / reverse-proxy configuration

The standalone Windows workflow remains the default. Container deployments may
set only `MOEKOE_DIST_DIR` (the full `MOEKOE_DIR` source tree is not required),
move persistent state with `RUN_DIR`, and provide sensitive values through
`SIRI_HTTP_TOKEN_FILE`, `SIRI_WS_TOKEN_FILE`, and `KUGOU_PASSWORD_FILE`.
Set `TRUST_PROXY=1` only when the gateway is reachable through exactly one
trusted reverse proxy; direct LAN deployments must keep the default `0`.

Container liveness is exposed internally at `/livez`; `/readyz` returns 200
only after the WebUI dist exists and the KuGou API has become reachable.

Windows 防火墙需放行 8080、8200 入站（iPad 才能访问 `192.168.10.236:8080`、
`ws://192.168.10.236:8200/ws` 与 `http://192.168.10.236:8200/api/siri/play`）。

## 安全约束（v1）

- `SIRI_HTTP_TOKEN` 只存在于 `.env` 与 Siri Shortcut；`SIRI_WS_TOKEN` 嵌入 hashed 客户端脚本，
  不能调用 HTTP 点歌 API。
- 两 token 互异、>=32 字节；不放 URL/WS query/log。
- WS 校验浏览器 Origin；6521 仅监听 127.0.0.1。

## 测试矩阵（当前覆盖）

| 场景 | 自动化 | 设备端 |
|---|---|---|
| 解析成功响应（中文/英文/歌手+歌曲） | ✅ fixture | ⏳ 实机搜索 |
| 无 song section / 空 lists | ✅ | — |
| 非对象项 / 全无 hash / 有 hash 无歌名 | ✅ | — |
| 第一项损坏、第二项有效 → 播第二项 | ✅ | — |
| KG_TAG 包装去包装 + 解析 | ✅ | — |
| `error_code:152` → `SESSION_EXPIRED`（非无结果） | ✅ | ⏳ 实机已发生并定位 |
| `$props` / `$attrs` / direct 三种命中 | ✅（模拟 proxy） | ⏳ 实机 probe |
| `/lyrics`、`/video` 返回 null | ✅ | ⏳ 实机 probe |
| 非 player 路由自动回 Index | ✅（模拟 router） | ⏳ 实机 |
| WS：auth.ok / auth.error / auth 超时 / Origin 拒绝 | ✅ | ⏳ 实机连接 |
| WS：ping→pong 存活 / pong 超时终止 / 无效 JSON 忽略 | ✅ | ⏳ 实机连接 |
| 客户端：认证、auth 拒绝不重连、断线退避重连、liveness 重连 | ✅ | ⏳ 实机 |
| 命令管线：成功 ack / 过期 / 搜索失败 / 无结果 / 无 hash / 播放器未就绪 | ✅ | ⏳ 实机 play() |
| 命令管线：addSongToQueue 异常 / shouldPlayNext / 单飞 BUSY / 畸形消息忽略 | ✅ | — |
| 命令管线：MoeData 构造 Authorization / 搜索请求编码与 credentials | ✅ | ⏳ 实机登录态 |
| 服务端：broadcast 仅发已认证 / play.ack 触发 onAck / 缺 reqId 忽略 | ✅ | ⏳ Phase 5 |
| Phase 4 全链路：broadcast play.req → 客户端搜索+播放 → 服务端收到 ack | ✅ | ⏳ 实机 |
| pending：submit/ack 结算 / 超时 TIMEOUT / 未知 reqId / 过期 prune / list | ✅ | — |
| pending：失败 ack 优先等成功 ack / 单独失败按宽限结算 / 超时优先真实失败 | ✅ | — |
| 服务端：sendPlayRequest 仅发给最近认证的一个客户端（防抢答） | ✅ | ⏳ 实机多客户端 |
| HTTP：无 token/错 token 401、缺 query 400、无客户端 202 queued、超时 504 | ✅ | ⏳ 实机 |
| HTTP 全链路：POST /api/siri/play → play.req → play.ack → 200 ok | ✅ | ⏳ Siri 快捷指令 |
| HTTP：query 参数与 token 参数两种传法 | ✅ | ⏳ 快捷指令 |
| 离线单槽：无客户端 202 queued / 认证后自动 dispatch / 在线竞态转 queued | ✅ | ⏳ 实机暂停后点歌 |
| 离线单槽：TTL 过期 expired / 新命令覆盖 superseded / 断线重发 / 终态 120s 清理 / 不持久化 | ✅ | — |
| 状态接口：各状态查询（queued/dispatched/succeeded/failed）/ 鉴权 401 / 未知 404 | ✅ | ⏳ 快捷指令轮询 |
| 客户端唤醒重连：pageshow/visibilitychange/online/focus 幂等强制重连 | ⏳ 单测（浏览器事件） | ⏳ 实机控制中心 Play |
| Media Session：play 只恢复、pause 只暂停 / playbackState 切换 / 暂停保留 position | ⏳ 手工核对 | ⏳ 实机控制中心 Play |
| 登录续期：成功写回 MoeData / 152→SESSION_EXPIRED / 网络错→REFRESH_FAILED / 无 token / KG_TAG 包装 | ✅ | ⏳ 实机长期运行 |
| 登录续期：搜索 152 → 自动刷新+重试成功 / 重试仍失败 → SESSION_EXPIRED / 非 152 不触发刷新 | ✅ | ⏳ 实机过期复现 |
| 恢复（session-auth）：成功仅回传白名单字段 / 未配置→NOT_CONFIGURED / 20028+ssaCode→RISK_REQUIRED / 错误密码→AUTH_REJECTED | ✅ | ⏳ 实机 |
| 恢复：单飞并发仅一次上游登录 / 失败 60s 冷却 / 超时 TIMEOUT / 网络错→UPSTREAM_UNAVAILABLE | ✅ | — |
| 配对：GET /siri/pair 页面 / POST 校验 token 设 HttpOnly SameSite=Strict Cookie / 错 token 401 / 限 5 次/分钟 | ✅ | ⏳ iPad 首次配对 |
| 配对：HMAC 派生值校验 / 伪造 Cookie 拒绝 / 重启后仍有效（无状态派生） | ✅ | — |
| WS reauth：未配对→PAIR_REQUIRED / 未认证忽略 / 成功仅回发原 socket 不广播 / 失败码原样转发 / 未配置→NOT_CONFIGURED | ✅ | ⏳ 实机 |
| 客户端恢复：refresh ok 不重登 / 152→reauth→合并 MoeData→重试 / RISK_REQUIRED 不循环 / 无设备→UPSTREAM_UNAVAILABLE / 共享单飞 | ✅ | ⏳ 实机挤掉复现 |

## Phase 5.6：会话自动恢复（一次性配置）

1. 在 `.env` 填入酷狗账号密码：
   ```
   KUGOU_USERNAME=你的酷狗账号
   KUGOU_PASSWORD=你的酷狗密码
   ```
   留空则功能休眠（reauth 返回 `NOT_CONFIGURED`）。凭据只存在于 Windows 的 `.env`，
   不进客户端、不进日志、不进 `/debug/status`、不进 Siri 返回值。
2. 重启服务（`npm run stop:all` + `npm run start:all`）。
3. iPad 打开 `http://192.168.10.236:8080/siri/pair`，输入 `SIRI_HTTP_TOKEN` 完成配对
   （一次即可，Cookie 由 HMAC 派生、重启后仍有效）。
4. 返回 WebUI 刷新（加载新 `siri-control.<hash>.js`）。
5. 首次手动播放一次解锁 Safari 音频；此后直接用 Siri 点歌。

恢复链路：`login_by_token` 成功 → 正常；返回 152 / 无 token → WS `session.reauth.req`
（仅已配对连接）→ Windows 用账号密码 POST `/login`（JSON body，携带 iPad 的
dfid/mid/guid/serverDev/mac）→ 成功回传白名单字段 → 客户端合并进
`localStorage['MoeData']` + 实时 Pinia store → 重试搜索一次。风控（20028/ssaCode）
返回 `RISK_REQUIRED` → Siri 报 `SESSION_REAUTH_REQUIRED`，iPad 自动进 `/#/login`
人工验证一次（账号密码/短信/现有风控组件），不强制扫码。

调试：`window.__siri.sessionState`（paired/lastRefreshAt/lastRecovery）、
`window.__siri.recoverSession()`（仅返回成功或错误码，不含 token）、
`window.__siri.ensureConnectedNow()`（立即触发一次 WS 重连尝试）。

## Phase 7：后台按需唤醒（暂停后点歌）

背景：iPad 暂停歌曲并把 Safari 最小化约 40 秒后，iPadOS 会挂起页面 → 心跳中断 → 服务端
断开 → 原实现 Siri 点歌返回 `NO_CLIENT`。方案是**低耗电按需恢复**，不做静音保活：

1. 歌曲暂停 → 页面允许被系统挂起（平时零额外耗电）。
2. Siri 点歌 → 服务端暂存为离线单槽命令并返回 `202 queued`（而非失败）。
3. 快捷指令发送系统级“播放” → Safari Media Session 恢复主 Audio（不创建第二个 Audio，
   播放/暂停键已拆分明确，playbackState 正确）→ 页面获得后台执行时间 → WS 重连
   （`ensureConnectedNow` 加速）→ 服务端自动下发 queued 命令 → 切到目标歌曲。

### 快捷指令建议流程（Step 5 fallback 为主）

```text
听写文本 → POST /api/siri/play → 解析 JSON
  ├─ ok=true 且有 song      → 结束（在线直播，无需唤醒）
  ├─ status=queued          → 打开 http://192.168.10.236:8080/（把 WebUI 置前台唤醒页面，
  │                           WS 重连后 queued 命令自动投递，不重复 POST）→ 等待 5 秒
  │                           → GET /api/siri/commands/<reqId>
  │                             ├─ succeeded   → 结束
  │                             ├─ queued/dispatched → 再等 3 秒再查一次
  │                             └─ 仍未成功    → 显示通知，提醒手动查看 WebUI
  └─ failed                 → 显示 error，不打开 WebUI 重播
```

> 已实机确认：控制中心“播放/暂停”无法唤醒挂起的 Safari 页面，不要作为唤醒信号。

### 实机验收（已确认 ✅ 2026-08-17）

1. 打开 iPad Safari WebUI → 播放一首 → 暂停 → 最小化 Safari → 等待 40 秒。
2. 服务端日志出现 `[control] disconnected`；此时笔记本 curl 点歌返回
   `202 {"ok":true,"status":"queued",...}`（不再是 `503 NO_CLIENT`）。
3. **Safari 保持最小化时，控制中心“播放”完全无效**：无声音、页面不唤醒（iPadOS 限制，
   不在前台就不会为网页媒体会话恢复 JS）。**唤醒只发生在把 WebUI 放回前台那一刻**：页面
   **原地唤醒**（无 GET /、无资源重载，JS 状态保留）→ `[control] authenticated` 重新出现 →
   queued 命令自动下发 → 搜索/取 URL/播放 → `ack ok=true`；随后 Siri 连点 3 首都成功。
4. 结论：**核心链路（离线单槽 + 前台唤醒自动投递）已验证成立**。控制中心播放不能作为唤醒
   信号，快捷指令直接以「打开 WebUI URL」作为唤醒手段（Step 5 fallback 为主方案）。
5. 不得继续尝试静音音频 / WebAudio / 隐藏视频 / WebRTC / 定位 / Wake Lock / Web Push 等伪保活。

## 后续阶段（未实现）

v1 明确不做 pause/next/服务端搜索/PWA 后台运行承诺/HTTPS/多设备命令路由。
Phase 7 的剩余项 = iPad 实机验收与快捷指令按上述流程配置。

## WebUI 侧附带修复

`src/components/PlayerControl.vue` 的 `applyAudioOutputDevice` 按
[W3C Audio Output Devices API](https://www.w3.org/TR/audio-output/) 修正：空字符串表示
浏览器默认输出，默认状态无需调用 `setSinkId`。iPadOS 上 `setSinkId('default')` 存在但调用
即抛 `NotSupportedError`，旧实现每次挂载都弹「切换音频输出设备失败,请刷新页面后重试」；
现改为：默认输出且无 `sinkId` 时直接成功（不调用、不弹窗）；从非默认设备切回默认调用
`setSinkId('')`；桌面端明确选择非默认设备且切换失败时**保留**原错误提示；不使用 iPad UA
判断。已作为独立 MoeKoeMusic 提交 `fix(audio): 精确处理音频输出设备切换...`。

`MediaSession.js` 与 `PlayerControl.vue` 的媒体会话修正（Phase 7 后台唤醒，提交 `55e9a70`）：
`initMediaSession` 只注册显式 `play`/`pause` 处理器（原实现两个都调 `togglePlayPause`，导致
系统 Play 与 Pause 行为不可区分）；新增 `setPlaybackState` 维护
`playbackState`（`none/paused/playing`），以 `audio` 原生 play/pause 事件为最终状态源；
普通暂停不再清空 position 元数据（原 `setPositionState(null)` 会让系统播放器丢失
进度/封面），仅真正停止/销毁时清除。

> 注意：上述两个 MoeKoeMusic 提交（音频输出修复 + 媒体会话修复）都已提交，工作树保持
> clean，`npm run build:web` 的 git-clean 守卫可正常通过。若再次手工修改
> `PlayerControl.vue` 后未提交，git-clean 检查会 FAIL。
