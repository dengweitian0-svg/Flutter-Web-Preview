# 验证记录

## 工程与浏览器 API 探针（2026-10-04）

- 本机 VS Code：1.140.0；Node.js：24.14.1。
- `npm run check`、`npm run build` 通过。
- 使用真实 Extension Host 验证浏览器 open、reload 命令存在，打开、移动和关闭标签均有公开 tabGroups 事件。
- Integrated Browser 的 Tab.input 为 undefined；跨编辑组移动会创建新的 Tab 对象，随后关闭旧对象。编辑组结构变化还可能触发整体标签模型更新。因此关闭检测不能仅比较旧对象是否仍存在，需要先协调移动产生的标签变化。
- 探针记录输出在 `artifacts/browser-probe.json`（不提交）。本轮未启动 Flutter 服务，不证明页面加载、编译或自动更新已完成。
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。

后续仍需验证真实 Flutter 链路、浏览器归属追踪、关闭后端口释放、版本兼容和 VSIX 安装。

## 核心状态机与更新调度

- 纯转换函数及副作用执行器已实现，核心没有 vscode 或 child_process 依赖。
- `npm run check`、`npm run lint`、`npm test` 通过，15 个状态与调度测试覆盖启动条件、重复 Run、编译失败、pending 合并、关闭优先级、旧绑定隔离、清理失败及超时。
- 外围适配器尚未接入；这些测试证明核心行为，不代替真实 Flutter 和浏览器验收。

## Flutter 协议与进程适配器

- machine 协议、请求 ID 关联、失败结果、超时及进程退出取消已实现；Windows 启动器和受管理进程树停止已接入。
- 在真实 VS Code 与本机 Flutter master SDK 上，启动、修改样例、收到成功编译响应、请求浏览器刷新、关闭标签后停止及端口释放测试通过。
- 运行记录在 `artifacts/runtime-test.log` 和 `artifacts/runtime-test.json`。页面最终显示内容仍需视觉/DOM 验证，stable SDK 兼容验证仍待完成。

## 浏览器生命周期

- `PREVIEW_TEST_MODE=browser` 的真实 Extension Host 测试通过：绑定实际标签、刷新、跨组移动后保持绑定、关闭后发出一次关闭事件、关闭后刷新不创建标签。
- 浏览器刷新采用记录标签的编辑组和索引定位，不使用可能创建新标签的 open 命令兜底。
- 标签移动和未知输入的协调逻辑另有单元测试；多个替代标签的结构变化视为归属不明确，不能据此终止进程。

## 命令、CodeLens 与保存后的真实页面更新

- 35 个单元测试、类型检查、lint 和构建通过。
- 真实 Extension Host 中通过注册命令运行扩展，CodeLens 能在 main 上提供 Run，正常编辑器保存会自动触发编译。
- 使用浏览器 CDP 读取 Flutter 的语义树，验证页面依次显示 Preview version 1、2、3；版本 2 的截图已目视核对。截图为 `artifacts/preview-before.png`、`artifacts/preview-after.png`。
- 编译错误时保留版本 2 页面；修复并保存后显示版本 3。移动预览保持会话，关闭后停止并释放端口，随后保存不重启。
- 记录：`artifacts/e2e-checks.json`、`artifacts/e2e-test.log`。本轮使用 master SDK，stable 兼容与压力验证仍待完成。
