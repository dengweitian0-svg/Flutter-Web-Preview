# 验证记录

## 工程与浏览器 API 探针（2026-10-04）

- 本机 VS Code：1.140.0；Node.js：24.14.1。
- `npm run check`、`npm run build` 通过。
- 使用真实 Extension Host 验证浏览器 open、reload 命令存在，打开、移动和关闭标签均有公开 tabGroups 事件。
- Integrated Browser 的 Tab.input 为 undefined；跨编辑组移动会创建新的 Tab 对象，随后关闭旧对象。编辑组结构变化还可能触发整体标签模型更新。因此关闭检测不能仅比较旧对象是否仍存在，需要先协调移动产生的标签变化。
- 探针记录输出在 `artifacts/browser-probe.json`（不提交）。本轮未启动 Flutter 服务，不证明页面加载、编译或自动更新已完成。
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。

后续仍需验证真实 Flutter 链路、浏览器归属追踪、关闭后端口释放、版本兼容和 VSIX 安装。
