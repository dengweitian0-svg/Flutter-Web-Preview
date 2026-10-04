# Marketplace 发布准备

首版交付 VSIX，不自动上架。

- 扩展标识：flutter-web-preview；显示名称：Flutter Web Preview；版本：0.1.0。
- publisher 暂用仓库作者标识 wende。正式发布前确认对应 Marketplace 发布者账号的所有权；如需变更 publisher，发布前同步调整测试扩展 ID。
- 简介：Preview Flutter Web inside VS Code, update on Dart save, and stop when the preview closes.
- 图标：assets/icon.png；截图：docs/images/preview-before.png、docs/images/preview-after.png。
- README 包含中文安装步骤、英文摘要、配置与故障排查；CHANGELOG 和 MIT LICENSE 齐备。
- 正式发布前核对 docs/verification.md 中尚未完成的验收，不将尚未通过的能力宣称为已支持。
- 打包命令：npm run package；输出 artifacts/flutter-web-preview-0.1.0.vsix。
- 发布凭据只能通过登录或 CI secret 提供，不写入仓库。是否发布预发布渠道或正式版本由发布者决定。

