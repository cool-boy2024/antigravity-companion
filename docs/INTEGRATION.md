# Antigravity 接入说明

核实日期：2026-11-26。Gravity Companion 是使用官方生命周期 hooks 的原生插件，仪表盘在本机浏览器运行。它不向 Antigravity 窗口注入界面，也不修改应用安装包。

## 安装和启用

需要 Node.js 22 或更新版本。先按仓库 README 启动本地示例，确认仪表盘能够使用，再接入真实工作区。

在仓库根目录执行：

```sh
agy plugin validate .
agy plugin install .
agy plugin list --json
```

`agy` 必须来自官方 Antigravity CLI，并在当前终端的 PATH 内。检查列表中的安装路径，确认其中存在 `src/cli.js`、其依赖文件和 `web/`。官方 manifest 没有 `files` 或 `include` 字段；本项目发布包应保留运行所需的完整目录。若当前版本没有 `plugin` 子命令，先查看该版本的官方安装说明；不要使用安装包补丁代替插件安装。

本仓库的 `hooks.json` 将 `gravity-companion.enabled` 设为 `false`。安装后，先检查其中的命令，再到宿主的 Customizations / Hooks 中启用该命名 hook；具体菜单名称随客户端版本变化。还需要对目标项目执行 `node src/cli.js init --workspace <项目目录>`，创建该项目的采集授权标记。没有标记的工作区不会保存事件。新建测试会话，执行一个无敏感信息的小任务，确认仪表盘出现新事件。停用时关闭同一个 hook，后续生命周期事件就不会再交给本项目。

原生插件更新通常会替换插件安装目录。任务数据应保存在工作区的数据目录，发布前要检查数据是否已排除在 Git 之外。安装插件不等于授权公开任务记录；导出交接包前应检查其中的路径、命令和用户填写内容。

## 文件与路径

根目录 `plugin.json` 使用官方 schema：

```text
https://antigravity.google/schemas/v1/plugin.json
```

插件名是 `gravity-companion`，显示名是 `Gravity Companion`。官方分发规则要求插件名采用小写 kebab-case，品牌名称不要以前缀 Antigravity、Gemini、Claude 或 Cursor 开头。仓库名用于说明目标产品，不表示官方出品。

官方插件加载器运行插件内的 hook 时，会把当前工作目录设为插件根目录。因此根 `hooks.json` 中的命令可以写成：

```sh
node ./src/cli.js hook PostToolUse
```

这是插件 hook 的路径规则。直接把该文件复制到工作区 `.agents/hooks.json` 或全局配置后，不能继续假定相同的工作目录。手工接入应使用已经审查过的绝对脚本路径，并按目标系统的 shell 规则加引号。

`${PLUGIN_ROOT}` 和 `${PLUGIN_DATA}` 是官方为插件 MCP 配置提供的变量；hook 命令按相对路径执行。本项目优先使用原生插件加载方式。工作区由 hook 输入中的 `workspacePaths[0]` 决定，不能用插件自己的 `cwd` 冒充用户工作区。

## hooks 格式与输入

根 `hooks.json` 用命名对象包住事件配置。工具事件需要 matcher 和嵌套的 `hooks` 数组，其他生命周期事件是平铺处理器数组：

```json
{
  "gravity-companion": {
    "enabled": false,
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node ./src/cli.js hook PostToolUse",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "node ./src/cli.js hook Stop",
        "timeout": 5
      }
    ]
  }
}
```

输入通过 stdin 传入 JSON，字段使用 camelCase。常用字段是 `conversationId`、`workspacePaths`、`modelName`、`toolCall`、`stepIdx`、`error`。采集器仅保存所需的元数据，工具参数和原始错误正文不进入事件记录。它不读取 `transcriptPath` 指向的会话文件，也不保存 `lastUserInput`。

hook 的 stdout 是宿主协议通道，只输出 `{}`；运行日志写 stderr。本项目采集 `SessionStart`、`PreInvocation`、`PostToolUse`、`PostInvocation`、`Stop`，不注册参与权限决策的 `PreToolUse`，不通过 `Stop` 延长任务，也不修改请求参数。

## 验收证据的边界

官方 `PostToolUse` 输入列出了工具名称、参数、步骤索引和可选错误，没有承诺提供命令的 `exitCode`、stdout 或完整测试结果。`run_command` 还可能异步返回。因此，收到无错误的 `PostToolUse` 最多表明这次工具调用没有报告运行时错误，不能据此标记“测试通过”。

本项目自己的验证执行器可以记录显式执行命令的退出状态与工作区文件状态。用户手工记录的结果也应标出来源。无法取得证据时，验收记录保留“未验证”或“未知”。

`Stop.fullyIdle` 为 `false` 时，可能仍有后台命令或异步任务；`terminationReason` 也可能是错误或步数上限。收到 `Stop` 不能直接标记任务成功。`PostInvocation` 只是一次模型调用结束，同样不能代表整个任务完成。

## 账户和兼容性

官方插件机制可以减少安装包补丁和私有接口带来的维护风险，不能保证账号永不受限。模型权限、额度、地区及组织政策继续由服务提供方决定。本项目不保存 Google 登录凭据，不进行账号轮换，不修改官方权限判断，不承诺解除套餐或配额限制。

Antigravity 安装到 VS Code 等编辑器的官方扩展，与独立 Antigravity App 是不同界面。“官方提供 VSIX”指的是前者，不能据此声称独立 App 能加载任意第三方 VSIX。本项目以公开 plugin 与 hooks 规范为接入依据。

来源：[插件开发和路径变量](https://antigravity.google/docs/build-plugins/)、[插件安装与目录](https://antigravity.google/docs/plugins)、[生命周期 hooks](https://antigravity.google/docs/hooks)、[各编辑器扩展](https://antigravity.google/docs/extensions)、[MCP](https://antigravity.google/docs/cli/mcp/)。
