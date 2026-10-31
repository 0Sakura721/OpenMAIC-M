# OpenMAIC-M 更新日志

OpenMAIC 安卓版自己的变更记录。上游（[THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)）的变更见仓库根目录的 [CHANGELOG.md](../CHANGELOG.md)，这份只记录把 OpenMAIC 装进 Android 手机所做的工作。

格式照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。每个版本对应一个 git tag，Release 与 APK 在 [Releases](https://github.com/0Sakura721/OpenMAIC-M/releases) 页。

所有版本的 APK 均为 **arm64-v8a**（约 232 MB），签名 SHA-256 一致，可覆盖安装：

```
39:C5:69:D0:9E:7B:38:3A:51:E8:DF:67:26:CD:BB:31:D9:33:7F:41:CA:BC:B4:BC:6E:18:2C:06:8C:3A:65:E6
```

---

## [v1.0.0-m7] — 2026-10-31

第二个可正常使用的版本。m6 之上新增两项，均在模拟器上验证。

### 新增

- **启动实时进度**。启动页逐阶段显示服务端在做什么——解压、准备环境、打开数据库（含耗时）、加载服务端、监听端口——旁边有每秒刷新的「已等待 N 秒」计数。实现方式：Node 侧按阶段输出 `OPENMAIC_STATUS` 行，JNI 日志管道识别前缀后回调到 Activity（JVM 与方法 ID 在 `JNI_OnLoad` 缓存，回调前先切 UI 线程；服务就绪后新状态被忽略，失败文本会冻结全部更新）。此前首启是 30–60 秒的静态转圈，看起来像卡死。
- **局域网模型服务开关**（数据菜单 → 应用设置）。上游 SSRF 守卫默认拒绝私网/回环目标，`http://192.168.x.x` 的本地模型服务（LM Studio、Ollama、llama.cpp）加不进去。开关默认关闭，持久化在数据目录（随备份走），启动时读入并设置守卫本来就读的 `ALLOW_LOCAL_NETWORKS` 环境变量，改后重启生效。守卫代码本身零改动——云元数据等永远禁止的目标仍然禁止。

### 下载

[OpenMAIC-M-v1.0.0-m7-384ee97.apk](https://github.com/0Sakura721/OpenMAIC-M/releases/download/v1.0.0-m7/OpenMAIC-M-v1.0.0-m7-384ee97.apk)（221 MB）

---

## [v1.0.0-m6] — 2026-10-31

**第一个在 Android 上真正跑通的版本。** 设备实测：数据库打开、服务监听、`GET /api/health` 200、建课 201、读回一致。

### 修复

- **`require` 任何包都失败的根因**（m4/m5 一直崩在这里）：nodejs-mobile 的 Node 用 simdjson 解析 `package.json`，而该构建在文档超过约 190 字节时解析失败，错误一律报成 `ERR_INVALID_PACKAGE_CONFIG` 且不说明原因。payload 里每个真实 manifest 都远超此限，于是所有裸包名 require 全挂，相对路径 require 和 `fs.readFileSync` 正常——症状是服务起来了、数据库开了、然后 import 时死掉。修复：装配时把每个 manifest 收缩到 190 字节以内，只留解析器读的字段（`name`/`version`/`type`/`main`/`exports`，放不下则丢 `exports`）；466 个被收缩，1.2 MB 元数据移除；任何一个收缩不进去构建即失败。排查中排除的三个错误假设（ESM loader 钩子、单纯文件大小、字段内容）记录在提交 `74985e82`。

### 下载

[OpenMAIC-M-v1.0.0-m6-74985e8.apk](https://github.com/0Sakura721/OpenMAIC-M/releases/download/v1.0.0-m6/OpenMAIC-M-v1.0.0-m6-74985e8.apk)（221 MB）

---

## [v1.0.0-m5] — 2026-10-31

**在 arm64 真机上不可用**——崩溃根因直到 m6 才定位。此版本包含的修复与策略保留：

### 变更

- **arm64 成为唯一目标**：workflow 默认 `arm64-v8a`；`all` 选项标注为模拟器专用；tag 构建在打包了非 arm64 的 APK 时直接失败，防止 360 MB 三 ABI 包被挂到 Release。
- Next 改经 `require` 加载（与 standalone server 相同路径），减少导入路径上的环节。当时误以为这能修设备崩溃——真正的根因（simdjson 大小上限）在 m6 定位。

### 下载

[OpenMAIC-M-v1.0.0-m5-f3666b2.apk](https://github.com/0Sakura721/OpenMAIC-M/releases/download/v1.0.0-m5/OpenMAIC-M-v1.0.0-m5-f3666b2.apk)（221 MB）

---

## [v1.0.0-m4] — 2026-10-31

两个只在真机上才会暴露的缺陷的修复（对照 [DSHA](https://github.com/DSH-APP/DSHA) 的做法发现），CI 全绿但此版本在设备上仍不可用（崩在 m6 修复的 simdjson 问题上）。

### 修复

- **切后台即停服**。运行时是本进程内的 Node 线程，Android 在用户切走后几秒内就冻结后台进程——生成中断、SSE 停摆。新增前台服务 `ServerKeepAliveService`（`dataSync` 类型）持有进程，partial WakeLock 持有 CPU。回到前台时检查端口，进程被杀则明确告知，而不是留给用户一页死按钮——`node::Start` 每进程只能运行一次，原地复活不可行。
- **WebView 连不上本地服务**。targetSdk 36 默认禁明文 HTTP，而整个 UI 就是 WebView 加载 `http://127.0.0.1`。新增 network security config，只对 `127.0.0.1`/`localhost` 放行明文，其余保持安全默认。

### 新增

- **数据导出/恢复**。`allowBackup` 是关的（payload 与数据库远超自动备份配额，部分恢复比不恢复更糟），重装或换机本会丢掉全部课程。导出为 zip；恢复先暂存、写完才原子替换，选到截断文件不会两边都丢。入口在常驻通知的「数据备份」动作与启动页标题长按。
- CI 新增打包后断言：用 aapt2 解码 APK 内的二进制清单，前台服务或明文放行缺失即构建失败——两者在设备上都是静默失败，读源码证明不了。

### 下载

[OpenMAIC-M-v1.0.0-m4-653b010.apk](https://github.com/0Sakura721/OpenMAIC-M/releases/download/v1.0.0-m4/OpenMAIC-M-v1.0.0-m4-653b010.apk)（221 MB）

---

## [v1.0.0-m3] — 2026-10-31

### 修复

- **payload 残留真实 sharp**。检查已发布的 m1 APK 发现 `node_modules/.pnpm/next@…/node_modules/sharp` 下有 sharp 源码——pnpm 还会把使用方的依赖嵌进 `.pnpm/<consumer>@<ver>/node_modules/<name>`，旧的裁剪规则只匹配了顶层和 `.pnpm/sharp@`。该路径可达：Next 自己的代码就在旁边，`require('sharp')` 会先命中它，真机上死于缺 libvips 绑定。改为按路径形状匹配 `…/node_modules/(sharp|pg)`，并新增打包后断言 `assertNoRealNativePackages`：payload 内任何位置出现真包（替身的版本号是 `0.0.0-mobile-shim`，一眼可辨）即构建失败。

### 下载

[OpenMAIC-M-v1.0.0-m3-4262951.apk](https://github.com/0Sakura721/OpenMAIC-M/releases/download/v1.0.0-m3/OpenMAIC-M-v1.0.0-m3-4262951.apk)（221 MB）

---

## [v1.0.0-m2]（未发布）

仅在 m1 与 m3 之间用于验证 sharp 裁剪修复的内部构建，未打 tag、未建 Release。

---

## [v1.0.0-m1] — 2026-10-31

**首个发布版本，不可用。** 留存作为教训：

### 已知缺陷（后续版本修复）

- payload 内 `node_modules/.pnpm/next@…/node_modules/sharp` 残留真实 sharp 源码 → 真机 `require('sharp')` 崩溃（m3 修复）。
- 切后台即停服、WebView 无法加载明文回环地址（m4 修复）。
- 所有裸包名 require 失败——当时未定位，实为 simdjson 大小上限（m6 修复）。
- 启动页无进度反馈（m7 修复）。

此版本的价值在于把「CI 全绿」和「设备可用」的差距全部暴露了出来：它发布后建立的 payload 断言、清单断言和设备冒烟脚本，正是后续每个版本能一次构建通过的原因。

### 下载

[OpenMAIC-M-v1.0.0-m1-e7a17ac.apk](https://github.com/0Sakura721/OpenMAIC-M/releases/download/v1.0.0-m1/OpenMAIC-M-v1.0.0-m1-e7a17ac.apk)（221 MB）

---

## 底层结构（v1.0.0 起始基线，随 m1 引入，此后基本未变）

安卓壳层的整体结构在 m1 一次性引入，之后的版本都是修补而非重构：

- **运行时**：nodejs-mobile 的 `libnode.so`（Node 24，来自 digidem 维护的构建），JNI 线程跑 `node::Start`；Next standalone 服务器由编程式 API 启动（`start-server` 需要 `child_process`，nodejs-mobile 没有）。
- **数据库**：PGlite（编译为 WASM 的 PostgreSQL）进程内运行，`pg` 由自写的 node-postgres 兼容层替代——PGlite 自带的 TCP 监听器会把并发事务死锁死。
- **sharp**：libvips 没有 Android 构建，payload 带一个读真实文件头、接受但跳过变换的替代实现。
- **UI**：WebView 加载 `http://127.0.0.1:7010`，无自有页面逻辑。
- **payload**：Next standalone 产物裁剪（去 source map、测试、营销资源、pnpm 虚拟目录）后压成单个 zip，App 首启解压到私有目录；466 个 `package.json` 收缩到 simdjson 能解析的大小。
- **CI**：单 job 构建 payload → 打包前在 x86 Linux 上真实启动一次 payload 并建课读回 → Gradle/NDK 编译签名 → aapt2 断言清单内含前台服务与明文放行 → artifact（尽力而为）+ tag 自动挂 Release。
