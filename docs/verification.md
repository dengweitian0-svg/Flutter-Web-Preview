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

## 独立复核与修正

- 复核证明初期“250 ms 内出现唯一 unknown 标签即视为移动”的启发式不能证明归属，会在用户打开无关标签后关闭预览时误绑定。已移除自动所有权转移，身份不明时暂停自动刷新，保留显式重新绑定入口。此前的移动测试只证明典型动作通过，不证明任意事件序列安全。
- 原方案的“移动后无需操作继续更新”门禁尚未通过，已向用户提出产品行为选择；在确认前不能宣称整个原方案完成。
- 已修复关闭事件取消待解析 Run、Restart 重读启动配置、非法实时超时配置卡住 updating、非法协议 URL 异常逃逸等问题。
- 当前 38 个单元测试通过，新增无关标签误绑定与非法配置回归测试。

## Stable SDK、安装与退出验证

- 官方 Windows SDK 档案未提供 3.35.0 stable 安装包；3.35 系列的最早可下载 stable 包为 3.35.1。测试使用 3.35.1 和当日最新 stable 3.47.6；两份 SDK 均按官方 SHA-256 校验并完整解压到仓库缓存。
- 3.35.1 的注册命令、CodeLens、保存更新、编译失败恢复、关闭与端口释放通过，记录在 `artifacts/e2e-3.35.1.log`。
- 3.47.6 的页面更新与 20 轮 Run / Stop / Restart / 关闭循环通过，每轮确认端口可再次绑定；结束后未发现对应 Dart 进程。记录在 `artifacts/e2e-3.47.6-stress.log`。
- VSIX 安装到隔离扩展目录后，加载包内代码的页面更新测试通过，记录在 `artifacts/vsix-test.log`。移位后暂停更新、显式 Open Preview Browser 重新绑定的安全行为也通过；这不是原要求“移位后无需操作继续更新”的证明。
- 普通安装环境（没有开发扩展覆盖）使用真实命令面板验证运行、Reload Window 释放端口，以及禁用后按 VS Code 要求重新加载：扩展状态栏与服务均消失。记录在 `artifacts/installed-lifecycle.json`、`artifacts/installed-lifecycle.log`。
- 关闭 VS Code 窗口的独立测试确认服务退出、端口释放，记录在 `artifacts/close-window-test.log`。
- 当前 43 个测试通过，包括真实 Windows 批处理的中文/空格/符号路径、启动取消、非法 URL，以及不响应正常退出时的进程树终止。强制终止测试须在具备正常 taskkill 权限的环境运行；受限沙箱的拒绝不当作通过，测试创建的遗留进程已核对精确脚本后清理。
- 生产依赖审计：0 vulnerabilities。VSIX 只包含入口 bundle、manifest、README、CHANGELOG、图标和许可证；不包含测试、SDK 缓存、日志或源码映射。

## 浏览器身份接口的剩余门禁

独立复核进一步检查了稳定 `vscode.lm.tools / invokeTool` 入口与内置 `list_browser_pages`：该工具仅公开已共享页面的身份，还依赖聊天/浏览器工具设置，输出没有稳定的结构化身份 schema，不能作为普通未共享预览的必需契约。本次未读取用户其他页面，也未修改共享状态。

原方案关于跨编辑组移动后自动继续更新的要求仍未满足。已提出用户选择：安全暂停并显式重新绑定、首版移动后停止，或保留要求并等待稳定身份接口。用户尚未选择，原实现方案不擅自改写，完整方案不能据此标记完成。

## 最终回归补充

- 类型检查、lint 与 45 个测试通过。新增保护：Stop 清理失败返回拒绝，卸载清理期间不接受新的启动请求。
- 安装包的最终端到端验证通过 Auto Save、reloadOnSave 即时切换、非法实时超时配置恢复、Restart 重读端口，以及成功编译后 500 ms 内发起刷新，记录在 `artifacts/vsix-final-test.log`。
- CI 文件已做 YAML 结构校验并包含两个 stable SDK 的测试矩阵；尚未推送或在 GitHub Actions 上执行，不将本地结果描述为云端 CI 已通过。
