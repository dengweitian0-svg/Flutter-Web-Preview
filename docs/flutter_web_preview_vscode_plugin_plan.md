# Flutter Web Preview：VS Code 插件实现方案

本方案依据原始需求文档及本次讨论整理，作为后续开发与验收的依据。仓库目前仅有许可证，以下功能尚未实现。

## 1. 目标、边界与默认值

首版提供以下体验：

```text
点击 Run Web Preview
→ 启动 Flutter Web Server
→ 在 VS Code 右侧打开 Integrated Browser
→ 修改并保存 Dart 文件
→ 自动重新编译
→ 编译成功后自动刷新页面并恢复代码编辑焦点
→ 关闭预览浏览器标签
→ 自动停止 Flutter 进程并清理会话
```

用户首次启动后，正常保存或 Auto Save 即可看到最新内容，不需要输入 r、点击 Reload 或手动刷新。自动更新以会话正在运行、预览标签打开、编译成功且 reloadOnSave 开启为前提。

- 名称：Flutter Web Preview；标识：flutter-web-preview；首版版本：0.1.0。
- 首版仅支持本地 Windows 桌面版 VS Code，每个窗口一个 Flutter 预览会话。
- 严格使用 Integrated Browser；能力不满足要求时提示升级。
- 接受重新编译和页面刷新导致运行状态重置，不承诺状态保持热重载。
- 关闭插件管理的预览标签即结束会话；扩展本身保持可用，下次 Run 可以重新启动。
- 交付源码、测试、文档、可安装 VSIX 和 Marketplace 发布准备材料，正式上架单独处理。
- 暂不支持远程工作区、多会话、断点调试、WebAssembly 和任意 Flutter 启动参数。

技术选型：TypeScript 严格模式、npm 锁文件、esbuild、YAML 解析库、Vitest、@vscode/test-electron 和 @vscode/vsce；不使用 proposed API。

VS Code 最低版本为 1.140.0；Flutter 兼容目标为 3.35.0 及以上 stable，发布验收覆盖最低版本和发布时最新 stable。当前机器的 master SDK 仅作为额外验证，不作为唯一发布依据。

配置统一使用 flutterWebPreview 前缀，按项目资源读取：

| 配置 | 默认值 | 生效时间 |
| --- | --- | --- |
| flutterSdkPath | 自动查找 | 下一次启动 |
| entrypoint | lib/main.dart | 下一次启动 |
| port | 7357 | 下一次启动 |
| reloadOnSave | true | 立即 |
| reloadDelay | 300 ms | 立即 |
| startupTimeout | 180000 ms | 下一次启动 |
| reloadTimeout | 30000 ms | 下一次更新 |
| showCodeLens | true | 立即 |

首版关闭预览即停止会话为固定行为，不增加独立开关。

## 2. 稳定核心、依赖与恒定规则

核心职责为会话所有权、合法生命周期转换，以及更新请求与结果的关联。Flutter 子进程、VS Code 浏览器、项目发现和 UI 均为外围实现。

```text
命令 / CodeLens / 保存事件 / 浏览器关闭事件
                      ↓
            PreviewSessionController
             状态所有权与合法转换
                      ↓
              ReloadCoordinator
              防抖、串行与 pending
                 ↓          ↓
           FlutterRuntime  PreviewBrowser
               窄契约         窄契约
                 ↑          ↑
           进程协议适配器   浏览器标签适配器
```

依赖始终指向核心契约。核心不导入 vscode，不直接调用 child_process。extension.ts 只负责组装依赖、注册入口和生命周期。

恒定规则：

1. 一个窗口最多一个受管理会话，一个会话最多一个编译请求执行中。
2. 状态只能通过控制器 dispatch(event) 转换，UI 与适配器不能直接写状态。
3. 外部启动、编译、停止、浏览器操作及标签关闭的结果必须以事件回流。
4. 只有当前 sessionId、当前 operationId 的成功结果可以发起自动刷新。
5. Stop 和预览关闭优先于 pending 更新及尚未执行的 Restart。
6. 普通编译失败不刷新、不自动重试，不销毁仍可工作的会话。
7. 关闭预览后不得继续编译、发出新的刷新请求或自动重新打开浏览器。
8. 插件只停止自己启动的进程树，不干预其他浏览器标签或 Flutter 进程。
9. 未确认资源清理完成，不能报告 stopped 或启动替代进程。

源码按 core、flutter、browser、project、ui 分组，避免按功能入口重复持有会话状态。

## 3. SessionState 与事件转换

### 3.1 状态模型

```ts
type SessionState =
  | { kind: 'stopped' }
  | { kind: 'starting'; sessionId: string; spec: LaunchSpec }
  | {
      kind: 'running';
      session: ReadySession;
      lastError?: RecoverableError;
    }
  | {
      kind: 'updating';
      session: ReadySession;
      operationId: number;
    }
  | {
      kind: 'stopping';
      sessionId: string;
      next: 'stopped' | 'failed';
      failure?: SessionFailure;
    }
  | { kind: 'failed'; failure: SessionFailure };
```

ReadySession 包含项目根目录、入口、配置快照、Flutter appId 和预览 URL。每次启动创建新的 sessionId。

进程句柄、请求表和标签对象由适配器持有。控制器上下文保存 pending 更新、待启动目标、浏览器绑定标识及浏览器操作状态，不再创建另一套生命周期状态。

| 状态 | 含义 |
| --- | --- |
| stopped | 没有受管理进程、编译请求或更新定时器 |
| starting | 启动流程执行中，尚未取得完整运行条件 |
| running | 已取得 appId、URL 和应用就绪事件，可以接受编译请求 |
| updating | 恰好一个编译请求执行中 |
| stopping | 禁止新更新，正在停止并清理资源 |
| failed | 会话不可用，进程与会话资源已经清理，保留错误原因 |

running.lastError 表示最近一次更新失败但会话仍可用。浏览器状态 closed / opening / open / unavailable 与 SessionState 分开维护；浏览器操作失败不直接销毁 Flutter 会话。

### 3.2 唯一转换方式

```ts
dispatch(event: SessionEvent): void;

transition(
  state: SessionState,
  context: SessionContext,
  event: SessionEvent,
): TransitionResult;
```

transition 为纯函数，返回新状态、新上下文和副作用描述。

```text
事件入队
→ 检查状态与事件归属
→ 计算并提交状态
→ 执行副作用
→ 副作用结果转为事件
→ 再次进入 dispatch
```

事件处理串行化，但不在事件队列内等待长时间副作用，保证 Stop 和浏览器关闭及时生效。

### 3.3 合法转换表

| 当前状态 | 事件 | 新状态 | 动作 |
| --- | --- | --- | --- |
| stopped / failed | RUN_REQUESTED | starting | 创建新会话并检查、启动 |
| starting | WEB_URL_AVAILABLE | starting 或 running | 保存 URL 并请求打开；运行信息齐备后进入 running |
| starting | APP_STARTED | starting 或 running | 保存 appId 和就绪信息；运行信息齐备后进入 running |
| starting | DART_SAVED | starting | 记录 pending，不发送编译请求 |
| starting | 启动失败 / 超时 | stopping | next=failed，取消启动并清理 |
| running | UPDATE_REQUESTED | updating | 创建 operationId，消费 pending，发送编译请求 |
| updating | DART_SAVED / 手动更新 | updating | 合并为一次 pending 更新 |
| updating | COMPILE_SUCCEEDED | running | 允许刷新并按需调度 pending |
| updating | COMPILE_FAILED | running | 记录 lastError，不刷新；较新 pending 可执行一次 |
| updating | 编译超时 / 协议失效 | stopping | next=failed，禁止后续更新并清理 |
| running / updating | 浏览器操作失败 | 原状态 | 记录浏览器错误，保留 Flutter 服务 |
| starting / running / updating | STOP_REQUESTED | stopping | next=stopped，取消 pending 和待启动目标并清理 |
| starting / running / updating | BROWSER_CLOSED（当前绑定） | stopping | 等价于 Stop，next=stopped，取消 pending 和待启动目标并清理 |
| starting / running / updating | RESTART_REQUESTED | stopping | 记录待启动目标并清理旧会话 |
| starting / running / updating | 进程意外退出 | stopping | next=failed，记录原因并清理剩余资源 |
| stopping | STOP_REQUESTED / BROWSER_CLOSED（当前绑定） | stopping | 清除待启动目标，next=stopped，不重复停止 |
| stopping | CLEANUP_COMPLETED | stopped 或 failed | 落入 next；有待启动目标时随后提交新的 Run |
| stopping | 清理失败 | stopping | 提示错误并保留资源记录，不启动新进程 |
| failed | STOP_REQUESTED | stopped | 清除错误 |

未列出的事件不得自行修改生命周期；根据命令规则合并、忽略或返回提示。

### 3.4 命令优先级与幂等

- 同一目标启动中重复 Run 合并；运行中重复 Run 只显示现有预览。
- Run 不同目标先停止旧会话，清理完成后再启动；stopping 中最后一次明确 Run 决定待启动目标。
- stopped 中 Stop 无操作；failed 中 Stop 清除错误；stopping 中 Stop 取消后续启动。
- Restart 在 stopped / failed 中按 Run 处理，在其他状态记录待启动目标；重复 Restart 不重复停止。
- 浏览器关闭等价于用户 Stop，会取消尚未执行的 Restart 或项目切换。之后新的用户 Run 可以重新启动。
- starting / updating 中保存只记录 pending；stopped / failed / stopping 中保存忽略。
- 手动更新与自动更新使用同一队列；普通编译失败不创建重试循环。

### 3.5 迟到事件与停止清理

运行事件携带 sessionId，编译结果另携带 operationId，浏览器事件另携带 bindingId。

编译结果仅在 sessionId 属于当前会话、状态为 updating、operationId 匹配时有效。BROWSER_CLOSED 仅在 sessionId 和 bindingId 均属于当前绑定时有效。

进入 stopping 立即取消定时器与 pending，使编译结果失去刷新资格；通过 app.stop 停止进程，5 秒未退出则终止记录的有效 PID 对应进程树。尚未取得 appId 时，同样走受管理进程的取消和终止流程。

只有进程结束、请求表和监听器释放后，才提交 CLEANUP_COMPLETED。停止期间迟到的进程创建结果必须被接管并停止，不能直接忽略造成泄漏。

浏览器副作用在排队时和实际执行前都检查绑定资格。已经发送给 VS Code 的操作可能无法撤销，但关闭或 Stop 后不得发送新的刷新或打开请求。若尚未完成的打开操作晚于用户关闭返回，适配器应清理能够确认属于该已停止会话的标签，不重新激活会话。

## 4. 外围实现与浏览器关闭能力

### 4.1 项目识别与 Flutter 启动

项目定位按 CodeLens 文件、活动 Dart 文件、工作区扫描候选的顺序执行；多个候选使用 Quick Pick。

从文件查找最近 pubspec.yaml，通过 YAML 确认 dependencies.flutter.sdk 为 flutter，并检查 lib/、web/ 和入口。最近包不符合条件时不越过包边界错误归属到外层应用。使用规范化路径及所属项目判断，避免 startsWith 导致相似目录或嵌套项目误触发。

CodeLens 使用点击文件作为入口；命令启动优先使用存在顶层 main 的活动 Dart 文件，否则使用配置入口。

SDK 查找顺序：插件配置、dart.flutterSdkPath、PATH。启动前检查 Windows、本地工作区、Workspace Trust、SDK、入口、浏览器能力及端口。

```text
flutter run --machine -d web-server
  --web-hostname 127.0.0.1
  --web-port <port>
  --target <entrypoint>
```

cwd 使用项目根目录。Windows 启动器封装 flutter.bat 的调用与路径引用，支持空格、中文，隐藏窗口。端口占用提示修改配置，不终止其他进程、不静默换端口。

### 4.2 Flutter 协议与更新

按行缓冲 machine 输出，支持分块、多行及普通日志混杂；stderr 与日志写入 Output Channel。解析 app.start、app.webLaunchUrl、app.started、app.progress、app.stop 和请求响应。

收到 URL 后立即打开浏览器，不先等待 app.started，避免需要浏览器连接的 SDK 启动阻塞。只有应用就绪且运行信息齐备后才允许编译。

更新通过 app.restart 请求，fullRestart=true、pause=false、reason=save 或 manual。该操作与插件 Restart 的停止并重新启动进程不同。

以对应请求 result.code===0 为成功依据，不把 progress.finished 或超时当作成功。非零结果返回 running.lastError，页面不刷新；超时或协议失效清理会话后进入 failed。

保存监听限定当前项目内的本地 Dart 文件，排除缓存和构建目录，采用 300 ms 尾沿防抖。更新中多次保存最多追加一次编译。pubspec、资源声明和 Web 宿主文件变化不纳入 Dart 自动更新，文档提示必要时 Restart 或重新处理依赖。

### 4.3 浏览器接口与绑定

```ts
interface FlutterRuntime {
  start(spec: LaunchSpec): Promise<void>;
  recompile(reason: 'save' | 'manual'): Promise<CompileResult>;
  stop(): Promise<void>;
  readonly events: RuntimeEventSource;
}

interface PreviewBrowser {
  open(url: string): Promise<void>;
  refresh(): Promise<void>;
  readonly events: BrowserEventSource;
  dispose(): void;
}

type BrowserClosedEvent = {
  type: 'BROWSER_CLOSED';
  sessionId: string;
  bindingId: string;
};
```

FlutterRuntime 和 PreviewBrowser 仅执行副作用并报告事件，不直接修改核心状态。BrowserEventSource 对打开成功、操作失败和当前绑定关闭提供统一事件出口。

首次打开使用 workbench.action.browser.open 的 URL、openToSide=true 和当前预览地址的 reuseUrlFilter。刷新时先通过不带 URL 的复用请求定位标签，再调用 workbench.action.browser.reload。浏览器操作串行化，完成后恢复代码编辑器、编辑组和选择位置。

只接受当前会话端口对应的本地 HTTP URL；不修改全局浏览器设置。仅在明确 Run 或 Open Browser 时创建、绑定标签；自动刷新不能用可能创建新标签的 open 命令兜底。

浏览器适配器在打开或定位期间，通过 tabGroups 事件及实际活动 Tab 绑定目标，在恢复编辑焦点前完成确认。不要假设打开命令返回浏览器句柄，也不要依赖标签标题或未公开的 browserId。

Integrated Browser 的 Tab.input 可能为 unknown；标签归属和移动后的重新关联必须在 P0 通过真实 VS Code 验证，不能只靠输入类型猜测。绑定不能确认时报告能力错误，不把任意浏览器标签当作预览标签。

### 4.4 关闭标签后自动停止

监听 vscode.window.tabGroups.onDidChangeTabs 与必要的编辑组变化事件，将当前绑定的真实关闭归一化为 BROWSER_CLOSED。

```text
当前预览标签被用户关闭
→ 适配器确认当前绑定不再存在且不是移动
→ 发布 BROWSER_CLOSED(sessionId, bindingId)
→ 控制器执行与 Stop 相同的转换
→ 清空 pending 与待启动目标
→ 停止 Flutter 进程树
→ 清理资源
→ stopped
```

规则：

- 关闭当前预览标签、关闭包含它的编辑组或关闭全部编辑器，均停止该会话。
- 关闭其他浏览器标签、切换标签、隐藏预览、改变焦点、导航或普通刷新，不停止会话。
- 移动预览到其他编辑组不停止；不能只凭一次 closed 通知判断，需协调同批打开、移动和组变化后再判断绑定是否真正消失。
- 对暂时无法区分的结构变化不终止进程，先重新核对绑定；若支持环境无法可靠区分移动与关闭，P0 门禁不通过，不能宣布能力已支持。
- 更新中关闭立即取消后续编译及刷新资格，迟到编译响应无效。
- Restart 清理期间关闭取消尚未执行的重新启动。新会话绑定后，旧绑定关闭事件不影响新会话。
- 关闭后保存 Dart 不重新启动服务或浏览器；再次 Run 创建新会话。
- Stop / Restart 自身的资源解绑或 dispose 不伪造用户关闭事件。重复关闭、Stop 和 dispose 保持幂等。
- 关闭的是预览会话与 Flutter 进程，扩展保留命令和 CodeLens，便于再次启动。

手动 Stop 保留现有预览标签但解除会话绑定；下次 Run 可以复用并重新绑定。自动关闭触发停止时不创建替代标签。

### 4.5 命令、CodeLens 与日志

| 命令标识 | 行为 |
| --- | --- |
| flutterWebPreview.run | 启动或显示当前会话 |
| flutterWebPreview.stop | 停止并清理 |
| flutterWebPreview.restart | 停止后重新启动 |
| flutterWebPreview.reload | 重新编译成功后刷新 |
| flutterWebPreview.openBrowser | 打开或定位预览 |
| flutterWebPreview.reloadBrowser | 仅刷新，不编译 |
| flutterWebPreview.showOutput | 查看日志 |

CodeLens 扫描常见顶层同步、异步和带参数 main 声明，排除注释、字符串和类方法；不修改 Dart 官方扩展的 Run、Debug、Profile。

状态栏读取控制器快照。日志记录启动参数、版本、转换事件、编译耗时、停止原因及退出码；自动关闭的停止原因使用 browserClosed，便于验收和排障。错误提供可操作提示，正常关闭不弹确认或成功通知，首版无遥测。

deactivate 返回清理 Promise，覆盖正常禁用扩展、Reload Window 和窗口关闭。扩展宿主被强制终止不能承诺执行 deactivate，需要额外验证 stdin 断开时 Flutter 的退出行为。

## 5. 开发阶段、测试与验收

按单人开发估计 9～13 个工作日，浏览器绑定与关闭识别计入 P0、浏览器阶段及验收，不跳过可行性门禁。

| 阶段 | 内容与门槛 |
| --- | --- |
| P0：关键链路验证 | machine 事件顺序、编译结果、标签绑定、复用、移动与关闭识别、焦点恢复和进程清理 |
| P1：工程与状态机 | 工程配置、纯转换函数、事件队列、项目识别、SDK 检查、Run / Stop |
| P2：浏览器与关闭生命周期 | 右侧打开、绑定事件、关闭自动停止、移动防误判和旧绑定隔离 |
| P3：自动更新 | 协议关联、防抖、串行、pending、错误恢复、超时和 Restart |
| P4：交付 | CodeLens、配置、状态栏、CI、文档、截图和 VSIX |

自动化测试：

- 协议分块、多行、请求关联、失败、超时、退出时取消。
- 重复 Run、启动中保存、启动中 Stop、编译期间保存和旧会话迟到结果。
- 正常编译失败不刷新，较新 pending 可执行一次，不形成重试循环。
- 编译超时清理后进入 failed；清理失败保持 stopping，不启动替代进程。
- 浏览器打开失败不误报进程已停止，刷新失败不误报编译失败。
- 当前 BROWSER_CLOSED 与 Stop 等价，旧 sessionId / bindingId 关闭事件无效。
- 关闭发生于 starting、running、updating 或 Restart 清理期间时，均按规则停止并取消后续工作。
- 关闭后没有编译、刷新或打开副作用；重复关闭和 Stop 不重复清理。
- 项目识别覆盖父目录工作区、多根、嵌套、相似路径、空格和中文。

真实 Windows / VS Code / Flutter 端到端验收：

1. 安装 VSIX 后点击 CodeLens，一次启动右侧预览，不弹外部 Chrome。
2. 修改页面文字并保存或 Auto Save，自动显示最新 UI，无需额外操作。
3. 快速保存多个文件，最终显示最新内容，无并行编译。
4. 编译错误不自动刷新；修复并保存后恢复。
5. 关闭当前预览后自动停止，进程结束且端口释放，不需要点击 Stop。
6. 编译中关闭不重新打开预览，不执行迟到刷新；启动期间关闭无进程泄漏。
7. 关闭无关浏览器标签不停止；切换、隐藏或移动预览到其他编辑组不停止。
8. 关闭包含预览的编辑组或关闭全部编辑器后正确停止。
9. Restart 清理期间关闭取消自动重启；重新 Run 后旧绑定事件不停止新会话。
10. 关闭后保存不启动；再次 Run 正常恢复。
11. 自动刷新后恢复代码焦点和选择位置。
12. 连续 20 次 Run / Stop / Restart / 关闭预览循环，无受管理进程泄漏且端口可重新使用。
13. 正常关闭窗口、Reload Window、禁用扩展均完成清理。

性能验收：默认 300 ms 防抖；本地样例正常运行时，成功编译响应到发起刷新不超过 500 ms。Flutter 编译和渲染耗时单独记录，不承诺固定总更新时间。关闭识别完成后立即进入 stopping，正常退出等待不超过 5 秒后进入进程树终止流程，仍须确认清理成功才能报告 stopped。

交付物包括源码与锁文件、F5 调试配置、Flutter 样例、协议夹具、架构与兼容记录、README、配置与故障排查、CHANGELOG、图标与截图、Windows CI 和 flutter-web-preview-0.1.0.vsix。文档明确说明关闭预览将停止服务，恢复方式为再次 Run。

CI 执行类型检查、lint、单元测试、Extension Host 测试及打包；VSIX 排除测试样例、日志和无关开发文件。发布账号不自动注册或登录，不自动上架。

## 6. 官方参考

- [Flutter IDE machine 协议](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/doc/daemon.md)
- [VS Code Integrated Browser](https://code.visualstudio.com/docs/debugtest/integrated-browser)
- [VS Code 浏览器打开与复用实现](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/browserView/electron-browser/features/browserTabManagementFeatures.ts)
- [VS Code 浏览器刷新实现](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/browserView/electron-browser/features/browserNavigationFeatures.ts)
- [VS Code 标签事件实现](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadEditorTabs.ts)
- [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [扩展测试](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [扩展打包与发布](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
