# 更新记录

## 0.1.1

- 新增 `demo` 子命令（`npm run demo` / `node src/cli.js demo [--port 0] [--open] [--seed-only]`）：自动在临时目录初始化演示工作区、预置 2 条中文示例任务并执行 1 次真实本地验证命令，退出时清理临时目录。
- 新增 AI 零接触部署指南（`AI_INSTALL.md`、`CLAUDE.md`、`docs/AGENTS.md`）及 README 顶部一句话 AI 自动安装提示框，并纳入发布包与一致性检查。
- 桌面端工作台任务列表支持滚动吸顶（sticky），浏览验收记录、交接面板与补充记录时可随时切换任务。
- 补充高分屏明暗双主题界面截图、README 徽章与一键体验说明，并新增 tag 触发的 GitHub Release 自动化发布工作流（`.github/workflows/release.yml`）。
- 新增 `scripts/check.mjs` 对界面版本号的一致性检查，以及 `demo` 预置、真实本地检查与优雅清理的自动化测试。

## 0.1.0

首个公开预览版。加入本地中文工作台、可编辑任务卡片、显式命令验证、文件状态过期检查、Markdown/JSON 交接与官方 hook 事件采集。记录竞品现有能力与接入边界。

宿主 hook 默认关闭，需要在指定工作区初始化并由用户启用。尚未承诺所有 Antigravity 客户端版本均已完成端到端验证。
