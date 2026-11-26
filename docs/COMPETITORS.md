# 能力对照与开发取舍

核实日期：2026-11-26。功能受客户端、版本、套餐和组织设置影响；终端命令不能直接当作桌面功能。

Gravity Companion 借鉴已有工作方式，优先解决交接时丢约束、验收时缺证据的问题。上下文圆环、压缩、额度、通知、皮肤和陪伴角色已有大量实现，本项目不把这些能力称为原创。

## Codex

| 能力 | 官方已有功能 | 本项目的取舍 |
| --- | --- | --- |
| 上下文与续接 | `/status`、`/compact`、恢复与分支会话；可选本地记忆 | 保留可编辑的目标、约束和下一步，导出可携带的交接记录 |
| 需要介入的提醒 | 完成、权限和问题通知；宠物可反映多种任务状态 | 根据实际事件给出可解释提示，保留未知状态 |
| 改动与验证 | diff、代码审查、命令与测试执行 | 把验证结果关联到执行记录及文件状态 |
| 用量 | CLI 的 `/usage` 可查看日、周和累计活动 | 首版不读取账户凭据或查询私有额度接口 |

来源：[命令参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[本地记忆](https://learn.chatgpt.com/docs/customization/memories)、[通知](https://learn.chatgpt.com/docs/notifications)、[宠物](https://learn.chatgpt.com/docs/pets)、[代码审查](https://learn.chatgpt.com/docs/code-review)。

## Claude Code

| 能力 | 官方已有功能 | 本项目的取舍 |
| --- | --- | --- |
| 上下文与续接 | `/context`、`/compact`、`/resume`、会话分支与项目记忆 | 跨工具分享结构化交接；普通压缩与历史恢复继续用宿主功能 |
| 状态与通知 | 桌面完成通知、后台任务，hooks 可响应权限、空闲和工具失败事件 | 汇总有来源的记录，不把无输出直接判断为卡死 |
| 改动与验证 | diff、代码审查、命令执行；桌面端支持按行反馈 | 区分已执行验证、失败和未知结果 |
| 用量 | `/usage`；状态栏可取得部分 5 小时与 7 日额度字段 | 不把周期额度当作历史趋势，不伪造任务消耗归因 |
| 外观 | 主题与布局；官方更新记录出现过 `/buddy` 陪伴角色 | 不把终端角色等同于当前所有用户可用的悬浮桌宠 |

来源：[命令参考](https://code.claude.com/docs/en/commands)、[桌面功能](https://code.claude.com/docs/en/desktop)、[hooks](https://code.claude.com/docs/en/hooks)、[状态栏](https://code.claude.com/docs/en/statusline#available-data)、[官方更新记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)。

## Antigravity

Antigravity App、CLI、独立 IDE 及安装在其他编辑器内的官方扩展，属于不同使用界面。某个界面支持的入口，不代表其他界面也支持。

| 能力 | 官方文档已说明 | 对开发的影响 |
| --- | --- | --- |
| 上下文 | App 与 CLI 支持 `/compact`；CLI 有 `/context` 分类视图 | 首版复用宿主压缩，不固定宣称所有模型都在 512K 压缩 |
| 额度 | CLI `/usage` 或 `/quota` 显示模型组余量与周期 | 用户继续使用官方面板；本项目不额外轮询私有接口 |
| 审查 | 有变更审查与产物审查 | 验收记录补充命令证据及未验证项 |
| 扩展 | 原生插件可打包 skills、hooks、规则和 MCP | 使用公开插件目录与生命周期事件 |
| 事件 | hooks 跨 App、CLI、IDE 提供生命周期元数据 | 自动观察与独立验证分开处理，细节见 [接入说明](INTEGRATION.md) |

来源：[压缩](https://antigravity.google/docs/commands/compact/)、[CLI 上下文](https://antigravity.google/docs/cli/commands/context/)、[CLI 额度](https://antigravity.google/docs/cli/commands/usage/)、[变更审查](https://antigravity.google/docs/review-changes/)、[插件开发](https://antigravity.google/docs/build-plugins/)、[hooks](https://antigravity.google/docs/hooks)。

## 如何持续更新

每次核对先读三家的官方更新记录，再查对应客户端文档。新增记录应写清日期、客户端与最低版本、来源、已实现的行为和仍待验证的条件。

官方补齐某项能力后，应重新考虑插件是否还需要维护同类功能。需要账号凭据、私有接口或改动安装包的方案，不能因竞品具备相似功能就直接引入。新设计先用可复现样例验证，再进入发布版本；自动抓取到文档变化只能提示复核，不能直接证明功能已经上线。

## 参考项目与归属

[antigravity-community-kit](https://github.com/yuhaojie217/antigravity-community-kit) 使用 MIT 许可证，公开说明中包含 `app.asar` 补丁、DOM 状态观察和额度查询。本项目参考其问题选择，独立实现本地仪表盘与公开 hooks 接入，不复制其注入器、汉化词典、主题代码、角色图片或预编译产物。原仓库的 MIT 授权不能替代对第三方角色形象和素材来源的单独核实。
