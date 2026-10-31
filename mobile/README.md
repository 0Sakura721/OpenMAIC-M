# OpenMAIC-M — OpenMAIC 的 Android 版

把 [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) 做成一个能装在手机上的 App：**服务端、数据库、渲染全在手机本地跑，不需要电脑，不需要外网数据库**。

APK 由 GitHub Actions 编译，不从本机出包。

## 下载

最新构建在 [Releases](https://github.com/0Sakura721/OpenMAIC-M/releases)。当前为 `v1.0.0-m1`，只含 `arm64-v8a`（近年所有 Android 手机），约 232 MB。

签名证书 SHA-256：`39:C5:69:D0:9E:7B:38:3A:51:E8:DF:67:26:CD:BB:31:D9:33:7F:41:CA:BC:B4:BC:6E:18:2C:06:8C:3A:65:E6` —— 与 `sign-key` 仓库记录一致，后续版本可覆盖安装。

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

## 装上去之后

1. 首次启动会解压运行时（几十秒，屏幕上会显示进度）
2. 进入 OpenMAIC 首页，和网页版一样
3. 在设置里配置模型服务商 —— **App 本身不带任何 API key**，跟网页版一样由使用者自己填

数据都在 App 私有目录里（`/data/data/ai.openmaic.mobile/files/openmaic`），卸载即清除。

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

以上都是「没在真机上验证过」的范围：CI 能证明的是服务器起得来、数据库能写能读、APK 能装（签名有效），装到手机上之后的实际体验需要真机确认。


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
