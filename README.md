# Flutter Web Preview

在 VS Code 右侧预览 Flutter Web。首次点击运行后，保存 Dart 文件即可自动重新编译并刷新页面；关闭预览标签会自动停止 Flutter 服务。

## 安装与使用

要求本地 Windows、VS Code 1.140.0 或以上，以及 Flutter 3.35 系列或以上的 stable SDK。Flutter 应用需要 `pubspec.yaml`、`lib/` 和 `web/`。首次使用请先在项目中完成 `flutter pub get`。

1. 在 VS Code 命令面板执行 **Extensions: Install from VSIX...**，选择 `flutter-web-preview-0.1.0.vsix`。
2. 打开并信任 Flutter 项目。
3. 点击 Dart 顶层 `main()` 上方的 **Run Web Preview**，或执行 **Flutter Web Preview: Run Web Preview**。
4. 正常修改并保存 Dart 文件，右侧浏览器自动显示最新内容。Auto Save 同样支持。
5. 关闭预览标签结束会话；再次点击 Run 恢复。

插件使用 `web-server` 设备，不启动外部 Chrome。更新采用重新编译加页面刷新，计数器、内存状态可能重置。需要断点或完整调试时继续使用 Dart/Flutter 官方扩展。

## 命令

所有命令位于命令面板的 **Flutter Web Preview** 分类：

| 命令 | 作用 |
| --- | --- |
| Run Web Preview | 启动，或显示现有预览 |
| Stop Web Preview | 停止服务并清理会话 |
| Restart Web Preview | 重读启动配置并重新启动 |
| Reload Web Preview | 手动重新编译并刷新 |
| Open Preview Browser | 打开或重新绑定预览标签 |
| Reload Preview Browser | 仅刷新浏览器 |
| Show Output | 查看运行和编译日志 |

状态栏显示当前生命周期。编译失败时保留旧页面；修复并保存后继续更新。

## 配置

```json
{
  "flutterWebPreview.flutterSdkPath": "D:\\flutter\\flutter",
  "flutterWebPreview.entrypoint": "lib/main.dart",
  "flutterWebPreview.port": 7357,
  "flutterWebPreview.reloadOnSave": true,
  "flutterWebPreview.reloadDelay": 300,
  "flutterWebPreview.startupTimeout": 180000,
  "flutterWebPreview.reloadTimeout": 30000,
  "flutterWebPreview.showCodeLens": true
}
```

SDK 路径可以省略，插件依次查找自己的配置、`dart.flutterSdkPath` 和 PATH。端口、SDK、默认入口及启动超时在下次启动或 Restart 时生效；其他配置按其行为即时或下一次更新生效。CodeLens 和活动入口文件优先于默认入口配置。

支持多根工作区的项目选择，每个窗口一次运行一个项目。保存其他项目的文件不会触发当前预览更新。

## 浏览器标签与常见问题

- **关闭预览**：自动停止服务，释放端口。关闭后保存不会自动启动。
- **切换或隐藏预览**：保持运行。
- **标签身份变化**：Integrated Browser 的公开 API 缺少稳定标签身份。跨组移动或复杂标签变化后，无法确认归属时暂停自动更新；使用 Open Preview Browser 显式重新绑定，或 Stop 结束会话。插件不会猜测并刷新其他浏览器标签。
- **端口被占用**：修改 `flutterWebPreview.port` 后重新运行；插件不会结束占用端口的其他进程。
- **找不到 Flutter**：将 `flutterSdkPath` 设置为包含 `bin/flutter.bat` 的 SDK 根目录。
- **缺少 Web 支持**：在项目中添加 Flutter Web 支持，再启动预览。
- **编译超时或协议失效**：插件停止并清理当前会话。查看 Output 后再次 Run。
- **资源或 pubspec 更新**：Dart 保存自动更新不处理所有配置变化，必要时重新处理依赖并 Restart。
- **运行环境**：首版不支持远程工作区、浏览器版 VS Code、macOS、Linux、WebAssembly 或完整调试。

## 开发

```powershell
npm ci
npm run check
npm run lint
npm test
npm run build
```

按 F5 启动 Extension Development Host。测试样例位于 `test/fixtures/flutter_app`，先为它运行 `flutter pub get`。

真实 VS Code 验证：

```powershell
$env:VSCODE_EXECUTABLE = 'E:\Microsoft VS Code\Code.exe'
$env:PREVIEW_TEST_MODE = 'e2e'
$env:PREVIEW_STRESS_CYCLES = '20'
npm run test:extension
```

可选 `FLUTTER_SDK_PATH` 指定测试 SDK，`PREVIEW_TEST_MODE=browser` 运行浏览器适配器测试。测试创建独立的 VS Code 配置目录，并在 finally 中恢复样例 Dart 内容；截图和结果在 `artifacts/`。CDP 调试端口仅用于测试，不用于扩展运行。

打包：`npm run package`。正式 Marketplace 上架需要拥有发布者账号，仓库中的 publisher 元数据不表示账号已经注册。

## English quick start

On local Windows, install the VSIX into VS Code 1.140 or later. Open a trusted Flutter Web project, click **Run Web Preview** above `main()`, then save Dart files to recompile and refresh automatically. Close the preview tab to stop its Flutter server. Runtime state can reset. If a tab move makes ownership unavailable, explicitly use **Open Preview Browser** to bind it again. Flutter is resolved from settings or PATH.

## License

MIT.
