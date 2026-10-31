# OpenMAIC-M — OpenMAIC 的 Android 版

把 [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) 做成一个能装在手机上的 App：**服务端、数据库、渲染全在手机本地跑，不需要电脑，不需要外网数据库**。

APK 由 GitHub Actions 编译，不从本机出包。

## 下载

最新构建在 [Releases](https://github.com/0Sakura721/OpenMAIC-M/releases)。当前为 `v1.0.0-m7`，**只有 `arm64-v8a`**（近年所有 Android 手机），约 232 MB。tag 构建会拒绝发布非 arm64 的包。

签名证书 SHA-256：`39:C5:69:D0:9E:7B:38:3A:51:E8:DF:67:26:CD:BB:31:D9:33:7F:41:CA:BC:B4:BC:6E:18:2C:06:8C:3A:65:E6` —— 与 `sign-key` 仓库记录一致，后续版本可覆盖安装。

**`m7` 相比 `m6` 新增两项：**

- **启动实时进度**：启动页显示服务端当前在做什么（解压 → 打开数据库 → 加载 → 监听），旁边有已等待秒数，不再是一屏静态文字。
- **局域网模型服务开关**（数据菜单 → 应用设置）：勾选后可以添加局域网里的模型服务商（LM Studio、Ollama 等 `http://192.168.x.x:端口`），默认关闭。见下面的「局域网模型服务」。

**`m6` 是第一个在 Android 上真正跑通的版本。** 在设备上实测：

```
database ready in 27 s
listening on http://127.0.0.1:7010
GET  /api/health   -> 200
GET  /             -> 200, 166 KB
POST /api/stages   -> 201  建课成功
GET  /api/stages   -> 读回同一门课
```

### 之前几个版本为什么不能用

- `m1`：payload 残留真实 `sharp` 源码（在 Next 自己的 pnpm 嵌套目录下），真机上 `require('sharp')` 会先命中它。`m3` 起由构建期断言把关。
- `m3` 及更早：**切到后台就停服**，且 **WebView 根本连不上本地服务**（targetSdk 36 默认禁明文 HTTP）。`m4` 修好。
- `m4`/`m5`：服务能启动、数据库能开，但一 `require` 任何包就崩。根因见下。

### 根因：nodejs-mobile 的 package.json 解析器有大小上限

Node 用 simdjson 读 `package.json`（`src/node_modules.cc`），而 nodejs-mobile 这个构建在文档超过约 **190 字节**时解析失败 —— 设备上实测 190 字节通过、197 字节失败，错误一律报成 `ERR_INVALID_PACKAGE_CONFIG`，不说明原因。

payload 里每个真实的 `package.json` 都远超这个大小，所以**所有裸包名 require 都失败**（`next`、`react`、`nanoid`……），而相对路径 require 和 `fs.readFileSync` 都正常 —— 这正是「服务起来了、数据库开了、然后 import 时死掉」的原因。

`m6` 的做法：把 payload 里每个 manifest 收缩到 190 字节以内，只保留解析器真正读的字段（`name`/`version`/`type`/`main`/`exports`，放不下就丢 `exports`）。466 个 manifest 被收缩，删掉 1.2 MB 元数据。任何一个收缩不进去就让构建失败。

这个排查过程里排除过三个错误假设（ESM loader 钩子、单纯的文件大小、字段内容），都写在了提交记录里。

## 它是什么

OpenMAIC 原本是一个 Web 应用：Next.js 服务端 + PostgreSQL。手机上没有这两样东西，所以这个仓库补了三块：

| 原本需要 | 这里换成 | 位置 |
|---|---|---|
| Node.js 服务端进程 | nodejs-mobile 的 `libnode.so`，在 App 进程的后台线程里跑 Node 24 | `mobile/android/app/src/main/cpp/node_jni.cpp` |
| PostgreSQL 服务器 | PGlite（编译成 WebAssembly 的 PostgreSQL），进程内运行 | `mobile/runtime/pg-pglite.cjs` |
| 浏览器 | WebView 加载 `http://127.0.0.1:7010` | `mobile/android/app/src/main/java/ai/openmaic/mobile/MainActivity.java` |
| `sharp`（libvips 绑定，没有 Android 版） | 只读文件头拿尺寸的替代实现 | `mobile/runtime/sharp-shim.cjs` |

上层是**原样的 OpenMAIC**：`lib/`、`app/`、`packages/` 只改了一处（`next.config.ts` 把 `pg` 和 `sharp` 标为 server-external，好让手机上的实现顶替它们），课程生成、课堂播放、编辑器的行为跟网页版一致。

## 编译

推一个 tag 或手动触发 workflow：

```bash
git tag v1.0.0-m2
git push origin v1.0.0-m2
```

`APK` workflow 会依次做：

1. `pnpm build` —— 出 Next.js standalone 服务端（几分钟，占几个 GB 内存）
2. `verify-runtime.mjs` —— **用打出来的包真的起一次服务**，建一门课再读回来。这一步失败说明手机上也会失败，所以它挡在打包之前
3. `assemble-payload.mjs` —— 裁剪 + 压成单个 `payload.zip`
4. Gradle + NDK —— 编 JNI 外壳，链 `libnode.so`，签名出 APK

产物：workflow 的 `openmaic-m-apk` artifact；打 tag 时同时挂到 Release。

只想要一个能装的包做验证，触发 `workflow_dispatch` 即可，默认只打 `arm64-v8a`（每个 `libnode.so` 约 85 MB，三 ABI 会让包大到不好装）。

### 为什么只有一个 job

web 打包和 Android 编译本来是两件事，但它们之间要传一个 160 MB 的 payload。用 artifact 中转既慢又会撞上仓库的 artifact 存储配额（`Artifact storage quota has been hit` 已经让这个 workflow 失败过一次），所以现在合成一个 job —— 在同一个 job 里它就是磁盘上的一个文件。

### payload 是怎么保证干净的

`pg` 和 `sharp` 都必须被替身顶掉，而「谁先被找到」由 Node 的解析顺序决定：从发起 require 的文件往上，每一层 `node_modules` 都是候选。所以只要有**任何一份**真包残留，它就可能赢过替身。

这件事已经出过两次错，都是 pnpm 的目录形状造成的：

- 第一次：`pg` 藏在 `node_modules/.pnpm/node_modules/pg`（pnpm 给未提升依赖留的虚拟目录），服务器起来后每个请求 500，报 `Cannot find module 'pg-types'`。
- 第二次：`sharp` 藏在 `.pnpm/next@…/node_modules/sharp`（pnpm 把使用方的依赖也嵌进去），从 Next 自己的目录 `require('sharp')` 就会命中它。

现在两条防线：

1. 裁剪按**路径形状**匹配（`…/node_modules/(sharp|pg)`），覆盖 pnpm 的每一种布局；
2. 打包后 `assertNoRealNativePackages` 扫描整个 payload，只要还有一份真包就**让构建失败**。替身的版本号是 `0.0.0-mobile-shim`，一眼可辨。

## 装上去之后

1. 首次启动会解压运行时（几十秒，屏幕上会显示进度）
2. 进入 OpenMAIC 首页，和网页版一样
3. 在设置里配置模型服务商 —— **App 本身不带任何 API key**，跟网页版一样由使用者自己填

数据都在 App 私有目录里（`/data/data/ai.openmaic.mobile/files/openmaic`），卸载即清除。

### 后台运行与数据备份

服务跑在 App 自己的进程里，所以切到后台时由前台服务接管：状态栏会有一条常驻通知，课程生成可以继续（含 CPU 唤醒锁，避免息屏后被冻结）。Android 13+ 首次启动会询问通知权限——**拒绝也能用**，只是看不到那条通知。

备份入口在那条常驻通知的「数据备份」按钮上（首次启动时也可以长按启动页的 OpenMAIC 标题）：

- **导出**：把课程和设置打成一个 zip 存到你选的位置
- **恢复**：用备份替换当前数据；替换前会先保留旧数据，写成功才删除，所以选到坏文件不会把两边都弄丢

`allowBackup` 是关的——payload 和数据库远超 Android 自动备份的配额，部分恢复比不恢复更糟——所以换机或重装前请自己导出一次。

### 局域网模型服务

手机版的主要用法之一是连同一 Wi-Fi 里的本地模型服务（LM Studio、Ollama、llama.cpp 等）。上游的 SSRF 守卫默认拒绝私网/回环地址（对云端部署是正确的），所以要先开开关：

**数据菜单 → 应用设置 → 勾选「允许访问局域网模型服务」→ 保存 → 重启应用**（数据菜单在常驻通知的「数据备份」按钮，或长按启动页标题）。

开关存在数据目录里，跟着备份走；修改在下次启动生效；默认关闭。开关只是设置上游守卫本来就会读的 `ALLOW_LOCAL_NETWORKS` 环境变量，守卫本身没有改动——云元数据地址等永远禁止的目标仍然禁止。

排查启动问题时看 logcat：

```bash
adb logcat -s OpenMAICNode OpenMAIC
```

Node 侧的 stdout/stderr 都被重定向到了 `OpenMAICNode` 这个 tag，包括 `OPENMAIC_READY http://127.0.0.1:7010` 这一行。

## 已知限制

- **没有 `child_process`。** nodejs-mobile 不提供进程派生。因此：
  - `next/dist/server/lib/start-server` 用不了（它在端口占用时会调 `lsof`/`netstat`），改用 Next 的编程式 API 启动，见 `mobile/runtime/start.mjs`
  - 本地 ffmpeg 音视频抽取、声音克隆这两条路径在手机上不可用
- **`sharp` 是替代实现。** 所有 `.resize()/.webp()` 等链式调用照常接受但不生效，`toBuffer()` 返回原始字节，`metadata()` 读的是真实文件头。后果是：发给视觉模型的图片不会被压缩到预算内，超出上限的图会被调用方按自身限额跳过，而不是被缩小。
- **PPTX 导入的 worker 可能失败。** 它用 `worker_threads` 从磁盘路径加载脚本，nodejs-mobile 有这个模块但路径解析要实测；失败时导入报错，不影响其他功能。
- **数据库是单写入者。** PGlite 只有一个会话，事务是全局临界区 —— 这在单用户手机上正是想要的语义，但并发请求会排队而不是并行。
- **`LISTEN/NOTIFY` 不工作。** 事件总线因此退回到轮询，只影响流式更新的延迟。
- **首次启动慢。** 解压 + 首次路由编译在低端机上要几十秒。
- **进程被杀后不能原地复活。** `node::Start` 一个进程只能跑一次，所以被系统回收后再打开 App 只能提示重启，而不是自动拉起服务。

以上都是「没在真机上验证过」的范围：CI 能证明的是服务器起得来、数据库能写能读、清单里该有的服务和权限真的打进了 APK、签名有效。装到手机上之后的实际体验（尤其是息屏长任务和低端机上的页面加载）需要真机确认。


## 仓库结构

```
mobile/
  android/            Android 工程（Gradle + NDK + WebView 外壳）
  runtime/            手机上的运行层：启动脚本、PGlite 版 pg、sharp 替代
  scripts/            CI 用的：拉 libnode、装配 payload、起服务自检、打 zip
.github/workflows/apk.yml
```

## 上游

MIT 协议，见 [LICENSE](LICENSE)。上游项目是 [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)；有意合并回上游的改动请照 [CONTRIBUTING.md](CONTRIBUTING.md) 走。
