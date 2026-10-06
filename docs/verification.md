# 验证记录

## CI 失败判据与浏览器等待修正（2026-10-05）

- `3f8a8ce` 的第一次 CI 在 Flutter 3.47.6 的日志验收中出现 CDP 单次求值超时；第二次在“编译失败保留旧页面”断言中失败。第二次产物只证明版本 2 曾成功显示，没有清理前的页面和编译结果，不能据此断定 Flutter 丢失了旧页面。
- 核心按正式 `COMPILED`、`BROWSER_REFRESHED` 事件记录最近编译的操作编号/结果和刷新次数。扩展 API 返回这些事实的副本，测试不再把日志连接或浏览器错误当作本次编译失败。
- E2E 在成功编译及刷新反馈后，等待新的 CDP 文档标识、完整加载状态和版本 2 页面；错误编译后确认新的非零编译结果、刷新次数不增加、文档身份不变化且旧页面仍在。没有放宽保留旧页面的验收条件。
- CDP 求值异常会原样失败；只有连接关闭、导航上下文失效和请求超时可在总预算内重连。多目标匹配直接失败。新增回归覆盖求值异常、连接中断、超时、重连、文档更替和预算耗尽。
- E2E 与日志验收在清理前写入失败堆栈、状态及页面诊断；E2E 另保存失败页面文本和截图。
- 真实鼠标输入在聚焦目标后等待布局帧，悬停后重新读取按钮坐标，并记录前后位置；日志验收中的新预览会话及刷新也必须经过文档身份更替的就绪检查。
- 类型检查、lint 和 85 个单元测试通过。Flutter 3.35.1 的基础 E2E 及最终完整日志验收通过，记录在 `artifacts/fix-e2e-3.35.1-isolated/e2e-checks.json` 和 `artifacts/fix-final-logs-3.35.1/log-console-checks.json`。
- 本机 Flutter 3.47.6 的基础 E2E 和最终完整日志验收通过，记录在 `artifacts/fix-e2e-3.47.6/e2e-checks.json` 和 `artifacts/fix-final-logs-3.47.6/log-console-checks.json`。本次 E2E 未执行压力循环；CI 原有 20 轮配置保留。改动尚未在 GitHub Actions 上验证。
- 本地默认端口可能被其他会话占用。`e2e`、`logs`、`logs-stop` 模式支持通过 `PREVIEW_TEST_PORT` 指定应用端口，测试入口和 CDP 客户端通过 `PREVIEW_CDP_PORT` 指定调试端口；默认仍为 7357/9333。E2E 的端口切换使用应用测试端口加一。

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
- 最终安装包复验确认刷新完成反馈发生在代码焦点恢复之后；截图与编辑器恢复分别验证，避免将截图期间的焦点变化误当作插件故障。最新包的完整端到端检查再次通过。

## 目录可移植性（2026-10-05）

- 运行时测试移除了固定的 `D:\flutter\flutter` SDK 路径，复用扩展的 SDK 查找逻辑；环境变量仍可显式覆盖。
- Windows 启动器从 `ComSpec` 或 `SystemRoot` / `windir` 定位命令解释器，不再假定 Windows 安装在 C 盘。
- 两类 VS Code 测试入口都支持自动下载 1.140.0 到仓库 `.cache/vscode-test/`；安装生命周期测试仍要求先把 VSIX 安装到独立测试扩展目录。
- README 的测试步骤从仓库 `.cache/` 推导 SDK 和 pub 缓存路径；单元测试会先创建所需缓存目录。本地样例设置中遗留的绝对 SDK 路径已移除，该设置文件不纳入版本控制。
- 类型检查、lint、49 个单元测试和 VSIX 打包通过；新增测试覆盖非 C 盘的 Windows 根目录及环境变量缺失。
- 自动下载 VS Code 成功。未设置 `FLUTTER_SDK_PATH` 时，真实 Extension Host 已从 `PATH` 完成 SDK 解析，但完整 E2E 被本机已占用的 7357 服务端口与 9333 CDP 端口阻挡，未通过；没有结束占用这些端口的其他进程。

## 应用调试控制台日志（2026-10-05）

- 在独立 worktree 的 `feat/debug-console-logs` 分支开发，已合入远程 `878a1fd`；各实现及验证部分分别提交。
- 复用内置 `editor-browser` 的无断点 attach 会话，以会话和浏览器绑定标识隔离生命周期。应用日志来自浏览器控制台；Flutter 编译、进程及插件诊断保留在 Output。
- 62 个单元测试通过，覆盖连接复用、超时/失败恢复、迟到连接清理、停止重试与并发合并、父子/其他调试会话隔离以及日志事件状态转换。类型检查、lint 和 VSIX 打包通过。
- Flutter 3.35.1 的真实点击、异步 `print` / `debugPrint` / `developer.log`、中文、多行、连续相同消息、可展开日志元数据、保存刷新、浏览器刷新、Restart、其他调试会话隔离与端口释放通过。记录：`artifacts/log-console-3.35.1.log`、`artifacts/log-console-3.35.1-checks.json`。
- 新 VSIX 安装到隔离扩展目录后，Flutter 3.47.6 完整日志验收通过；打包安装的入口 bundle 与开发构建 SHA-256 一致。记录：`artifacts/log-console-vsix-3.47.6.log`、`artifacts/log-console-vsix-3.47.6-checks.json`、`artifacts/debug-console-vsix.png`。
- 已安装 VSIX 的原生调试工具栏停止动作通过：活动浏览器子会话停止后，预览停止并释放 7357 端口。记录：`artifacts/log-console-toolbar-stop.log`、`artifacts/log-console-toolbar-stop.json`。
- 已安装 VSIX 在日志会话确认连接后关闭 VS Code 窗口，服务及端口释放通过。关闭窗口会主动中断测试宿主，因此脚本核对本轮关闭标识及端口释放后报告通过。记录：`artifacts/debug-console-window-shutdown.log`、`artifacts/shutdown-marker.json`。
- 已安装 VSIX 的原有 E2E 回归通过：CodeLens、渲染、500 ms 内请求保存刷新、编译失败恢复、Auto Save、实时配置、移动后显式重绑定、关闭及三个 Run/Stop/Restart/关闭循环、Restart 重读端口。记录：`artifacts/e2e-debug-console-vsix.log`、`artifacts/e2e-checks.json`。本轮本地循环数为 3，CI 保留 20 轮矩阵并新增日志验收步骤；尚未运行云端 CI。
- 测试每次使用独立 VS Code 配置目录，避免复用旧布局；Flutter 3.35 的语义指针初始化需要正常按下/松开间隔，真实鼠标测试保留该间隔并等待导航完成。
- 原生调试器在复用/停止过程中可能输出 `Invalid debug adapter`、截图失败等内部诊断；这些记录未被隐藏，验收以实际日志、会话结束、渲染和端口释放为准。插件对父会话请求隐藏工具栏，但内置调试器的子会话仍可能显示原生工具栏；不修改用户全局调试设置。本功能不提供完整 Dart 调试。

## 确认清理后的退出标记：0.1.1（2026-10-05）

- 增加 `flutter-web-preview` inline DAP 父会话，生命周期属于预览而非浏览器。原生 `editor-browser` 子会话把应用输出合并到父会话，保留对象展开；自定义日志类型不声明 Dart 语言支持，不接管 Dart F5 调试。
- 控制器在进程和浏览器清理成功、收到 `CLEANED` 后输出一次 `[Flutter Web Preview] exit: preview-… ended; Flutter stopped.`，随后结束父会话。异常原因沿用已有失败信息，不伪造退出码。清理失败保留父会话并显示停止失败；启动期间的结果及失败提示可延后显示。输出异常不阻断清理。
- 76 个单元测试通过，新增覆盖父控制台隔离、迟到/重复完成、退出提示先于会话终止、清理失败与重试、并发/启动时序、输出失败、浏览器清理失败、显式控制台 Stop 取消排队的 Restart，以及复制父标识的子会话结束不影响父会话。
- Flutter 3.35.1、3.47.6 真实验收通过：三类交互/异步日志与元数据展开；唯一预览关闭后的退出标记默认可见；Restart/Stop/工具栏停止各只有一个所属退出标记；保存、刷新、重绑定无退出标记；活动其他控制台不接收提示、其调试连接保持有效。
- SDK 记录：`artifacts/exit-marker-3.35.1.log`、`artifacts/exit-marker-3.35.1-checks.json`、`artifacts/exit-marker-3.47.6.log`、`artifacts/exit-marker-3.47.6-checks.json`。
- 0.1.1 VSIX 安装到隔离扩展目录后，同样通过上述完整验收；安装的入口 bundle 与开发构建 SHA-256 一致。记录：`artifacts/exit-marker-vsix-0.1.1.log`、`artifacts/exit-marker-vsix-0.1.1-checks.json`、`artifacts/exit-marker-vsix-0.1.1.png`。
- 0.1.1 安装版的原有 E2E 回归及三个 Run/Stop/Restart/关闭循环通过，包含保存更新、Auto Save、错误恢复、显式重绑定、实时配置与端口切换；日志已连接后的 VS Code 窗口关闭清理通过。记录：`artifacts/exit-marker-vsix-e2e.log`、`artifacts/e2e-checks.json`、`artifacts/exit-marker-vsix-shutdown.log`、`artifacts/shutdown-marker.json`。
- 调试器启动可能重新显示浏览器，插件在连接完成后有条件恢复原编辑器焦点；真实测试已验证恢复。测试主动选择另一个控制台来验证隔离，随后主动选择对应旧预览控制台来检查已结束会话的提示。
- 安装包升级为 `flutter-web-preview-0.1.1.vsix`；安装版测试目录从 manifest 版本推导。云端 CI 未在本轮执行；原生调试器已有内部诊断仍保留在运行记录中。

## 启动与保存刷新性能：0.1.2（2026-10-05）

- 调整整页刷新模式的 Flutter 编译参数、改用本地 CanvasKit、关闭日志连接的源码映射与异步栈开销，并修复手动更新后残留保存计时器导致的重复编译。
- 真实 VS Code 1.140.0 / Flutter 3.47.6 样例：启动 29.052 → 17.599 秒，三次保存到实际新页面显示的平均耗时 5.010 → 2.605 秒。这是本机样例单轮结果，未分别隔离各项优化贡献；详见[性能验证](performance.md)。
- Flutter 3.35.1 的实际启动和三次保存渲染通过；3.47.6 完整 E2E、三个生命周期循环及已安装 VSIX 的完整日志/退出标记验收通过。日志验收改用 17357，避免干扰用户运行中的其他预览。
- 78 个单元测试、类型检查、lint、VSIX 打包通过；安装入口与开发构建 SHA-256 一致。原生调试器诊断保留；本节记录本地验收，发布与云端 CI 结果另行记录。
## 保存来源识别修复：0.1.4（2026-10-06）

- 新增 Save and Reload Web Preview 和活动预览本地 Dart 编辑器的 Ctrl+S / Cmd+S 入口。保存意图、结果和去重留在编辑器适配层，核心调度与编译协议保持原状。
- 111 项单元测试、TypeScript 检查、ESLint 与 VSIX 打包通过。新增故障注入覆盖没有 will-save 通知、失败/取消/异常、慢项目验证、会话切换、同版本合并及新版本串行保存。
- 独立多模型 review 发现第二次编辑保存被旧操作合并的问题，修复后复审无剩余阻塞项。复现验证从保存一次且仍脏，变为保存两次、文档干净且只请求一次更新。
- 原生保存来源未知的边界与现有配置含义见 [保存通知修复说明](save-notifications.md)。这些故障注入不测量真实环境中的发生频率。
