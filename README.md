# Markdown WOPI Editor

一个面向 Cloudreve（WOPI 协议）的 Markdown 编辑器：React + Radix UI 外壳、Monaco 编辑内核、Yjs 实时协作、KaTeX 数学渲染，支持大纲、预览、草稿保护与文件锁生命周期管理。

> 本项目只实现 WOPI 编辑器侧的应用；文件存储、权限与锁的权威实现由宿主（Cloudreve）提供。

## 特性

- **编辑体验**：Monaco（VS Code 同款内核），Markdown 高亮、原生查找替换、撤销/重做、自动换行、双向预览定位。
- **实时协作**：Yjs + y-websocket + y-monaco，同一文件多人同房间协作；服务端统一持锁、串行保存，服务端校验身份与读写权限。
- **预览**：Markdown + 代码高亮 + KaTeX 公式。渲染期会规范化两类常见失败：段落中间的 `$$…$$`、以及 `$ … $` 收尾符前带空格的写法（代码块与行内代码不受影响，`$5 和 $10` 这类金额不会被误判）。
- **数学友好的语法高亮**：Monaco 内置 markdown 语法会把行内不等号（例如 `$a_1<a_2$`、`-1<y_{k+1}<y_k<1`）当成 HTML 标签开头，而这类行往往整行没有 `>`，标签态就一路带到文件尾，导致其后所有标题失去着色。我们对那条规则加了“同一行必须存在 `>` 才进入标签态”的前瞻守卫（见 `client/src/markdown-grammar-guard.js`），真正的内联 HTML 仍然正常高亮。
- **草稿保护**：断网、休眠、会话过期或误关页签时，正文保存在浏览器本机草稿（`localStorage`，按文件隔离），可下载或重开后恢复。
- **恢复与冲突**：服务端持久化 CRDT journal；当云端被外部修改时进入只读并暂停写入，界面上可“下载当前内容”或“以云端为准重载”。
- **锁生命周期**：显式退出即等真实 UNLOCK 确认后才返回成功；保存失败不会跳过解锁；UNLOCK 失败会保留自有锁值并退避重试；异常断网保留宽限期；仍有协作者时不误解锁。
- **界面**：0 圆角主壳、细分隔线、低强调图标入口；支持仅编辑 / 分栏 / 仅预览、窄屏抽屉大纲、明暗主题跟随宿主或系统。
  响应式用两个独立阈值：容器 <760px 时大纲转为抽屉，但**预览栏一直保留到 <520px** 才默认收成仅编辑（此前两者共用 760，中等宽度窗口会在没有任何提示的情况下丢掉预览栏）。

## 架构

```
Cloudreve ──form POST(access_token)──▶ /wopi/edit (shim)
                                        │ 建立 128-bit sid，token 只留在服务端内存
                                        ▼
                              /static/monaco-editor.html#s=<sid>
                                        │
        Monaco + Yjs ◀──WebSocket /collab/<roomKey>──▶ 服务端房间（单写锁 + CRDT）
                                        │
                              GetFile / PutFile / LOCK / REFRESH_LOCK / UNLOCK
                                        ▼
                                    Cloudreve WOPI
```

- `server.js`：HTTP 入口、shim、会话（sid）与 WOPI 上游调用、`/api/doc|save|status|keepalive|unlock|resolve`。
- `collaboration.cjs`：房间、Yjs 协议、journal 持久化、锁获取/续期/释放、退休与重试。
- `server-state.cjs`：宿主文件元数据到内部状态的映射。
- `client/src/workbench/`：React 外壳（Toolbar/Outline/RecoveryBar/StatusBar/Dialog）与 `session.js`（单一 Monaco/Y.Doc/Provider 生命周期）。
- `client/src/`：预览管线（Worker）、草稿存储、Markdown 分析、图片粘贴、主题跟随等。

## 快速开始

要求：Node.js ≥ 20（开发用 24），npm。

```bash
npm ci
npm run build     # 先跑测试，再构建前端，最后校验入口资源
PORT=3001 BASE_URL=http://127.0.0.1:3001 npm start
```

可用环境变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `3001` |
| `BIND` | 绑定地址 | `127.0.0.1` |
| `BASE_URL` | 对外基址，用于 Origin 校验与 discovery | 由请求 Host 推断 |
| `ALLOWED_ORIGINS` | 允许的额外来源，逗号分隔 | 空 |
| `COLLAB_DATA_DIR` | 协作 journal 持久目录 | `./.runtime/rooms` |
| `COLLAB_SAVE_MS` | 自动保存延迟 | `1000` |
| `COLLAB_GRACE_MS` | 断线宽限期 | `15000` |
| `LOCK_REFRESH_MS` | 锁续期间隔 | `240000` |
| `MOCK=1` | 脱离宿主用内置 mock 文稿自测（含 LOCK/REFRESH_LOCK/UNLOCK/PUT 全套锁语义） | 关闭 |
| `MOCK_FILE` | `MOCK=1` 时读写的样本文件路径 | 镜像内 `/app/mock-data.md`；源码运行为 `./mock-data.md` |

## Docker 部署

镜像为多阶段构建：构建阶段跑 `npm ci` → `npm run build`（含全部测试与入口资源校验）→ `npm prune --omit=dev`；运行阶段只带生产依赖、`server.js`/`server-state.cjs`/`collaboration.cjs`、构建产物 `static/` 与 mock 样本，以非 root 用户 `node` 运行，暴露 3001，journal 默认写在 `/data/rooms`。

### 预构建镜像（GHCR）

推 `main`、发 release、或手动 dispatch 时，CI 会把镜像发到 GHCR（公开包，无需登录）：

```bash
docker pull ghcr.io/gsmainagent/markdown-wopi:latest        # 默认分支
docker pull ghcr.io/gsmainagent/markdown-wopi:sha-<短 sha>   # 锁定具体构建
```

tag 规则：`main`、`latest`（仅默认分支）、`sha-<短 sha>`；发 GitHub Release 时额外打 semver tag（当前尚未建 release，所以现在只有这三个）。PR 只构建不推送。

拉不动先分清是 ACL 还是出网：包属性是 public，所以 `502` / TLS `unexpected eof` 属于**你这台机器没有可用的 `ghcr.io` 出口**（本机实测：`api.github.com` 走代理可通，而 `ghcr.io` 经代理与直连均不可达）⇒ 这种环境下用下面的 `docker build --build-arg NPM_REGISTRY=…` 自行构建。

```bash
# 构建（CI 用默认 registry；国内网络可换镜像源）
docker build -t markdown-wopi:local .
docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t markdown-wopi:local .

# 运行：journal 必须挂卷，否则重启即丢协作恢复数据
docker run -d --name wopi-md-editor \
  -p 127.0.0.1:3001:3001 \
  -e BASE_URL=https://<你的编辑器域名> \
  -e ALLOWED_ORIGINS=https://<你的 Cloudreve 域名> \
  -v wopi-md-editor-data:/data \
  markdown-wopi:local
```

只绑定 `127.0.0.1`，对外经反向代理或隧道（frp/nginx）暴露；`BASE_URL` 必须与浏览器实际访问的 scheme/host/port 一致，否则 Origin 校验与 discovery 里的 `urlsrc` 会对不上。

不带宿主的自检（镜像内已含 `mock-data.md`）：

```bash
docker run -d --name wopi-mock -p 127.0.0.1:18081:3001 -e MOCK=1 -v wopi-mock-data:/data markdown-wopi:local
curl -s localhost:18081/healthz                                   # ok
curl -s localhost:18081/mock/wopi/files/1                         # CheckFileInfo
curl -si -X POST 'localhost:18081/wopi/edit?WOPISrc=http%3A%2F%2F127.0.0.1%3A3001%2Fmock%2Fwopi%2Ffiles%2F1' \
     --data-urlencode 'access_token=mock' | grep -i location       # 303，且不含 access_token
# 用上一步 #s= 后的 sid：
curl -s localhost:18081/api/doc/<sid> | head -c 200                # canWrite:true
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:18081/api/save/<sid>    # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:18081/api/unlock/<sid>  # 204
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:18081/mock/wopi/files/1 \
     -H 'X-WOPI-Override: LOCK' -H 'X-WOPI-Lock: outside'         # 200 ⇒ 锁确实已释放
```

注意 `WOPISrc` 要写**容器内**地址（`127.0.0.1:3001`），不是宿主映射端口——服务端是自己去回连宿主的。

两个实测坑：

- **podman 默认 OCI 格式会丢掉 `HEALTHCHECK`**（构建时警告 `HEALTHCHECK is not supported for OCI image format`，`podman image inspect` 里 `Healthcheck` 为 `<nil>`）。要保留就 `podman build --format docker`，或改用编排层的健康检查；`docker build` 不受影响。
- 镜像约 629 MB（含 Monaco/KaTeX 等生产依赖与构建产物）。

## CI

两个互相独立的 workflow（刻意不揉在一个文件里）：

| 文件 | 触发 | 做什么 |
|---|---|---|
| `.github/workflows/test.yml` | push 到 `main`、所有 PR | checkout → Node 24（npm 缓存）→ `npm ci` → `npm test` → `npm run build`（含入口资源校验） |
| `.github/workflows/docker.yml` | 同上路径过滤；另加 `release: published` 与 `workflow_dispatch` | buildx 构建；PR 只构建不推，`main`/release/dispatch 用内置 `GITHUB_TOKEN` 推 GHCR（`permissions: packages: write`，**不需要仓库 secret**）；最后一步把镜像拉回来断言 `HEALTHCHECK` 与非 root `User` 仍在 |

CI 里 `npm ci` 用 `--registry=https://registry.npmjs.org --replace-registry-host=always`，这样 lockfile 里的镜像源地址不影响公共 runner。测试工作流不上传构建产物；镜像只发 GHCR（发布方式与坑见上节）。

## 接入 Cloudreve

1. 在 Cloudreve 后台的 WOPI 应用里导入本服务的 discovery：`<BASE_URL>/hosting/discovery`。
2. 让 Cloudreve 能访问 `BASE_URL`，并让浏览器也能访问同一地址（Origin 校验基于 `BASE_URL`）。
3. 从 Cloudreve 打开 Markdown 文件；编辑器通过 shim 换取一次性 sid，后续请求只带 sid。

注意：`urlsrc` 中不能出现子串 `lng`，Cloudreve 前端会盲目替换该字面量。

## 测试

```bash
npm test        # 101 项：单元 + 真实 HTTP 替身 + 锁生命周期 + MOCK 宿主 + 预览/草稿/主题/语法守卫
npm run build   # 测试 + 构建 + 入口资源校验
```

测试覆盖了：双写者单锁与串行保存、只读与越权拒绝、断线合并、journal 恢复、外部修改阻塞与冲突端点、显式退出/异常断网/注销失败/并发 attach、MOCK 宿主的锁生命周期、公式渲染、未闭合围栏诊断、Monaco 语法守卫、草稿清理与恢复策略。

## 安全与边界

- WOPI `access_token` 只在服务端内存中使用，不写入日志、不返回前端；前端只拿随机 sid。
- 会话仅存内存：服务重启后所有 sid 失效，必须从宿主重新打开。
- 单个房间只持一把宿主锁；保存走服务端串行化，浏览器不直接整文覆盖。
- 单进程部署；多实例、跨账号/团队/分享权限组合、真实长 TTL 与撤权、IME 全设备矩阵尚未完整验收。
- 对外部署建议置于反向代理后并启用 HTTPS，仅暴露必要路由。

## 目录结构

```
server.js               HTTP/shim/WOPI 上游（含 MOCK 宿主的锁语义）
collaboration.cjs       房间、Yjs、journal、锁生命周期、冲突合并
server-state.cjs        宿主元数据映射
client/src/             前端源码（预览、草稿、分析、语法守卫、主题、图片）
client/workbench/       React 外壳与构建入口
test/                   集成、锁生命周期与 MOCK 宿主测试
mock-data.md            MOCK=1 自测样本
Dockerfile              多阶段镜像（构建阶段跑测试，运行阶段非 root）
.github/workflows/      test.yml 与 docker.yml
infra/frpc.example.toml 隧道配置示例（真实 frpc.toml 不入库）
```


## 为什么不用现成方案

这个项目的目标很窄：**在 Cloudreve 的原生文件上实时协作编辑同一个 `.md`，同时不破坏宿主权限与文件锁，也不丢内容**。按这个目标逐项比对过现有方案：

| 方案 | 符合的部分 | 不满足的部分 |
|---|---|---|
| [Cloudreve 内置 Markdown 编辑器](https://docs.cloudreve.org/usage/file-apps) | 原生读写宿主文件、遵循宿主权限与锁、零部署 | 无实时协作；无草稿恢复、外部改动冲突处理、公式/大纲增强 |
| [HedgeDoc](https://hedgedoc.org/)（原 CodiMD） | 开源、自托管、实时协作成熟，含演示模式与图表 | 文档存放在自己的库里，不是宿主文件；没有 WOPI，权限与文件锁需另做桥接 |
| OnlyOffice / Collabora Online（WOPI 套件） | WOPI 原生、协作成熟 | 面向 OOXML/ODF，Markdown 不是其格式；无 Markdown 预览、大纲与数学渲染 |
| HackMD / Vrite / StackEdit 等 | 编辑体验成熟 | 独立编辑器或 SaaS，无 WOPI、无宿主文件语义 |

结论：协作强的（HedgeDoc）不接 WOPI，WOPI 强的（Office 套件）不做 Markdown。给 HedgeDoc 写 WOPI 适配在理论上可行，但工作量与本实现同量级，且要改它的存储与权限假设。

因此本项目只做补缺口的那一层：**WOPI 会话与锁、服务端串行保存、CRDT 协作、草稿与冲突恢复**，编辑体验则复用成熟组件（Monaco、Yjs、KaTeX）。

## Roadmap

- [ ] **VSCode 式冲突编辑器**（`external-file-changed` 的完整解决流程）
      三方内容已具备：base＝上次保存的 journal 快照、ours＝本机恢复稿、theirs＝当前云端。
      目标：三栏对比 + 逐块接受（左取右），合并结果仍通过服务端锁与串行保存写回；在此之前先提供两栏 diff 与“全部用云端 / 全部用恢复稿 / 分别下载”。
- [ ] 冲突解决后自动解除只读并恢复协作写入。
- [ ] 草稿的可见管理（按文件列出、清理、导出）。
- [ ] 更长的会话与真实 TTL 验收，以及休眠/唤醒场景。
- [ ] 多实例部署与房间归属（当前单进程）。

## License

尚未指定许可证。仓库当前为 public，在未加 LICENSE 前默认**保留所有权利**（可看不可用）。要开放使用请先补一份许可证。
