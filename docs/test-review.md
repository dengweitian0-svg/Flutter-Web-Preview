# CI 测试适用性审查

日期：2026-10-07。远程基线：`b63b777`。范围：CI、VS Code 测试宿主、E2E、日志验收及对应 CDP/保存适配层单元测试。

## 结论

核心状态转换、保存来源、编译失败恢复、会话所有权和端口清理的测试方向合理。当前完整 UI E2E 作为每次 push 的统一门禁存在不可靠的同步假设，部分失败不能直接证明产品回归。应先修正测试协议与分层，再依据可重复的失败调整产品代码。

## 近期失败证据

下列五次运行的 `checks` job 均成功。两次失败属于 SDK 准备；另外三次发生在 UI 验收。

| Run | 失败位置 | 证据 |
| --- | --- | --- |
| [37474092801](https://github.com/dengweitian0-svg/Flutter-Web-Preview/actions/runs/37474092801) | Flutter checkout | `Filename too long`，测试尚未执行 |
| [37575146694](https://github.com/dengweitian0-svg/Flutter-Web-Preview/actions/runs/37575146694) | SDK 检查 | 浅克隆缺少版本计算所需 tags/history，Flutter 报告未知版本 |
| [37575791196](https://github.com/dengweitian0-svg/Flutter-Web-Preview/actions/runs/37575791196) | Auto Save 页面保留断言 | 单次文本读取失败；失败产物随后采样仍包含预期 `Preview version 3`，核心编译/刷新计数断言已通过 |
| [37576576627](https://github.com/dengweitian0-svg/Flutter-Web-Preview/actions/runs/37576576627) | toolbar stop 后重启日志预览 | 前六项日志检查与完整 E2E 已通过；`preview-6` 的服务、浏览器和日志连接均在运行，CDP 目标发现超时 |
| [37581008907](https://github.com/dengweitian0-svg/Flutter-Web-Preview/actions/runs/37581008907) | `reloadOnSave=false` 页面保留断言 | 单次读取未命中；失败产物随后包含预期 `Preview version auto enabled`，编译/刷新计数未变 |

失败产物是断言失败后的另一次采样，不能当作失败瞬间的原子快照；上述两次文本证据要求先检查采样/同步，不能据此认定 SDK 自动刷新页面。

## 主要问题与优先级

### P1：页面采样与业务完成条件未统一

已提交版本的部分负向断言只读取一次 Flutter 语义树。语义树可能在布局和焦点变化时暂时不包含文本。单次为空会导致误报；单纯拉长固定 sleep 也不能保证采样稳定。

部分正向更新只等待文本出现，没有像首个 Save and Reload 场景一样等待对应编译编号、新的刷新计数和新文档标识。这可能把 Flutter 内部重启期间的页面或前一操作的反馈当作本次操作已经完成，随后开始下一场景，形成串扰。

修正方式：正向更新按“触发操作 → 对应编译结果 → 对应刷新反馈 → 新文档与期望文本”验收；负向检查等待期望文本，同时持续禁止文档身份变化，并检查编译/刷新计数没有增加。预算内只重试瞬时连接/导航失败；实际表达式错误和文档不变量破坏应立即失败。

### P2：手动保存测试入口与产品契约不一致

`endToEnd.ts`、`logConsole.ts` 的 `replace()` 使用 `TextDocument.save()`，部分场景随后直接期待手动保存触发刷新。仓库的 `docs/save-notifications.md` 已说明：原生保存通知缺少原因时默认不刷新，可靠入口是 `flutterWebPreview.saveAndReload`。[VS Code API](https://code.visualstudio.com/api/references/vscode-api#workspace.onWillSaveTextDocument) 也不保证每次保存都派发 `onWillSaveTextDocument`。

修正方式：用户手动更新场景通过产品显式命令或实际快捷键触发；原生保存原因缺失与自动保存作为独立契约场景，配合适配层故障注入测试验证。不能把一次通知缺失等同于产品未履行显式保存契约。

### P2：本地性能目标被用作托管 CI 功能门禁

E2E 将刷新请求延迟 `<=500 ms` 作为单次硬断言，而需求文档限定该指标为“本地样例正常运行时”。托管 Windows runner 的 UI 调度、CPU 竞争和窗口遮挡会影响这个值。

修正方式：默认功能门禁检查刷新发生及结果正确；500 ms 目标保留在受控性能验证中，记录环境和多次采样。测试宿主新增的后台调度参数也应从性能模式排除或明确记录，避免与旧的实际用户环境测量直接比较。

### P2：完整 GUI 流程承担了太多串行职责

E2E 连续操作同一文档与会话，混合保存策略、错误恢复、编辑器焦点、标签移动、配置更新与压力循环。日志验收又连续启动/停止多个 Flutter 服务，并切换无关调试会话及控制台。一次早期失败会跳过所有后续检查，重跑又重复全部昂贵步骤。

修正方式：默认 CI 保留少量真实集成场景；完整 UI 隔离、多会话和重复生命周期场景作为独立的深度验收，可按需或定时执行。每个场景拥有明确起始状态、预算和独立失败记录。减少压力轮数仅降低运行成本，不能修复同步错误。

### P2：失败证据应记录实际采样，而不只是事后页面

当前 failure JSON 的页面内容在 catch 中重新读取，可能已经不同于导致失败的那次读取。通用 phase 字符串也覆盖多个场景。

修正方式：在页面轮询中保存最近一次文本、文档标识和时间；记录具体场景及开始时的编译/刷新编号。清理错误应附加记录，避免覆盖原始失败。

## 本次审查的验证与工作区状态

- 类型检查、lint 和 12 项 CDP 回归测试通过，新增覆盖空语义树恢复、保留文档身份与采样期间导航的立即失败。
- 本地完整日志验收通过，包含先前云端失败的 toolbar stop 后 `preview-6` 重启。记录：`.cache/logs-cdp-scheduled.log`、`.cache/logs-cdp-scheduled/`。
- 本地完整 E2E 与三轮生命周期循环通过。页面保留检查加入严格文档身份条件，编译/刷新计数断言保留。记录：`.cache/e2e-retained.log`、`.cache/e2e-retained/`。
- 使用同一 Flutter `4e5a09292c1c64a38d604c7ec096537f50d69f93`，临时去掉 `--no-hot` 后，功能 E2E（不重复压力循环）也通过。记录：`.cache/e2e-test-audit-without-nohot.log`、`.cache/e2e-test-audit-without-nohot/`。这个对照不证明所有 SDK 都无需该参数，但此前失败不足以支持“由 hot reload 导致”的归因。
- 对照实验的产品源码与测试生成的锁文件已恢复。本报告记录审查时的结果；页面采样修复已通过上述本地验证，后续云端结果以对应 CI run 为准。

## 建议的默认 CI

1. 类型检查、lint、核心与适配层单元测试、打包。
2. 当前电脑同版本 SDK 的少量真实 smoke：启动 → 显式保存 → 正确页面更新 → 停止 → 端口释放；另验证默认自动保存不刷新。
3. 一次真实日志点击、异步消息、对象展开和所属控制台的唯一退出提示。
4. 完整 UI 隔离、窗口关闭、重复生命周期和性能指标作为独立深度验证，仍保留并可运行。

按稳定性组织测试：核心规则优先使用可控、确定的事件与状态测试；外部 GUI 只验证窄契约及关键反馈，明确其异步、成本和失败模式。
