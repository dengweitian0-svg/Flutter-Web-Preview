# 启动与保存刷新性能修复（0.1.2）

本机真实 VS Code 1.140.0、Flutter stable 3.47.6 和仓库样例的单轮对比：

| 操作 | 修复前 | 修复后 |
| --- | ---: | ---: |
| Run 到页面实际显示 | 29.052 s | 17.599 s |
| 保存到页面显示新内容，第一次 | 6.048 s | 2.861 s |
| 第二次 | 4.686 s | 2.393 s |
| 第三次 | 4.297 s | 2.561 s |
| 三次保存平均 | 5.010 s | 2.605 s |

本轮样例启动耗时下降约 39%，保存刷新平均耗时下降约 48%。这是同一机器、SDK 和样例的结果，日志连接在保存测量前已确认建立；缓存、SDK 版本、系统负载和实际项目大小都会影响耗时。不是对用户项目或所有机器的速度承诺，也未通过逐项关闭优化来分离各项贡献。

问题与修复：

- 原来沿用 Flutter 默认的 DDC library bundle 热重载编译模式，但 `web-server` 没有可用于应用热重载的调试连接，插件只能增量编译后整页刷新。现在使用 `--no-web-experimental-hot-reload` 选择 AMD 模式，降低这个使用场景的模块加载开销。仍复用运行中的编译器，不重启 Flutter 进程。
- 原来 CanvasKit JavaScript 和 WASM 来自 `www.gstatic.com`，在网络不通或缓慢时会阻挡显示。现在传入 `--no-web-resources-cdn`，实测资源来自本地 `/canvaskit/`。Flutter 的字体回退和应用自己的网络请求仍可能访问外网。
- 预览只需要浏览器应用日志，原来仍使用调试器默认的 source maps 与异步栈设置。现在关闭 source maps、等待 source maps 的脚本暂停、异步栈追踪，以及 Flutter Dart 表达式求值元数据；日志及对象展开另做真实验收。
- 防抖等待中手动 Reload，原计时器仍会触发一次额外编译。开始编译时现在消费该计时器；编译期间的新保存仍合并为一次后续更新。

恒定规则保持：只有当前会话成功编译才刷新；编译错误保留旧页面；浏览器归属不明时暂停自动更新；关闭和停止优先于迟到结果；确认进程与浏览器清理完成后才显示退出标记。

`Flutter server ready` 与 `Compilation succeeded` 只记录服务和编译阶段。性能测试通过 CDP 读取 Flutter 实际语义树中的新文本，测量用户看到更新的时间，包含保存防抖、编译、浏览器导航和页面渲染。

复测方式（先准备样例依赖，SDK 可用 PATH 或 `FLUTTER_SDK_PATH` 指定）：

```powershell
$env:PREVIEW_TEST_MODE = 'performance'
$env:PREVIEW_TEST_PORT = '17357'
npm run test:extension
```

结果写入 `artifacts/performance.json`，包括每次操作耗时、页面资源 URL 与耗时。测试结束会恢复样例和配置。日志验收的 `logs` / `logs-stop` 模式也支持 `PREVIEW_TEST_PORT`。

本轮原始记录：`artifacts/performance-before/performance.json`、`artifacts/performance-after/performance.json`。Flutter 3.35.1 同样通过真实启动与三次保存渲染，记录在 `artifacts/performance-3.35.1/performance.json`；3.47.6 全部 E2E 验收和三个生命周期循环通过，记录在 `artifacts/regression-3.47.6/e2e-checks.json`。原有 VS Code 内置调试器 `Invalid debug adapter` 等诊断保留在日志中。

78 个单元测试、类型检查、lint 和 0.1.2 VSIX 打包通过。安装包入口 bundle 与开发构建 SHA-256 一致；安装版 3.47.6 的完整日志验收通过，包含点击、异步消息、中文、多行、重复消息、可展开元数据、保存刷新、Restart、会话隔离和确认清理后的唯一退出提示。记录在 `artifacts/logs-vsix-3.47.6/log-console-checks.json`。日志测试使用 17357 端口，保留用户正在运行的 7357 服务。本节记录本地验收，发布与云端 CI 结果另行记录。

参考：[Flutter Web 开发](https://docs.flutter.dev/platform-integration/web/building)、[JavaScript Debugger 配置](https://github.com/microsoft/vscode-js-debug/blob/main/OPTIONS.md)。本地同时核对了两个 stable SDK 的 `resident_web_runner.dart`、Web 参数解析与实际生成资源。
