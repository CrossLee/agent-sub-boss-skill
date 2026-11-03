# Agent Sub-boss Skill

给多个本地项目配一个项目副手：先核实进展、风险和下一步，再用一个本地总控台统一管理预览服务。

这是一个可安装的 **Codex Skill**，内含完整可运行模板、扫描器和验证流程。无需云端账户，无前端依赖安装，不包含作者的真实项目数据。

## 复制给你的 Agent，自动安装

将下面这段话复制给能够联网、操作本地文件的 Codex 或其他支持 Skill 的 Agent：

```text
请帮我安装 Sub-boss Skill：
https://github.com/CrossLee/agent-sub-boss-skill
请先阅读仓库根目录的 INSTALL.md，按当前 Agent 的环境完成安装并检查结果。如果已经安装，请保留现有内容并告诉我。安装完成后，告诉我如何使用它。
```

Agent 会读取[安装说明](INSTALL.md)，把 `skills/sub-boss` 安装到对应的 Skill 目录。安装完成后，在 Codex 中发送：

```text
使用 $sub-boss，为我的本地项目建立总控台。先确认项目目录，再盘点进展并配置预览服务。
```

## 能做什么

- 项目工作看板：风险、待拍板、待验证、延期、完结；搜索、分类、详情和四种主题。
- 老板视角汇总：明确负责人、下一步、日期，最多三项优先级。
- 六类独立证据：代码、构建、安装、提交、部署、验收，避免把“写完了”当成“交付了”。
- 项目启动台：启动、停止、重启、端口、访问地址、技术栈、数据库类型和日志。
- 可选 Codex 对话目录和回到原对话按钮；默认不读取对话数据。

数据库类型是源码/依赖识别，不代表数据库已连接。项目盘点也不等于业务验收。

## 手动安装

```bash
git clone https://github.com/CrossLee/agent-sub-boss-skill.git
cd agent-sub-boss-skill
python3 scripts/install_skill.py
```

默认安装到 `${CODEX_HOME:-~/.codex}/skills/sub-boss`。如果已有同名目录，安装器会拒绝覆盖。安装完成后发送新的消息调用；若当前客户端还未识别，再重新开启对话：

> 使用 $sub-boss，为 ~/Projects 下的本地项目建立总控台，放在 ~/Projects/subboss。帮我核实项目进展，并统一管理预览服务。

也可直接把 `skills/sub-boss` 文件夹装入支持 `SKILL.md` 的 Agent 环境；Codex 对话关联仅在对应客户端可用。

## 不经过 Agent，直接启动

准备 **Node.js 22.13+、Python 3.9+、Git、ps、lsof**。启用对话目录另需 `sqlite3`。macOS 已实测；Linux 设有 CI；Windows 暂不支持进程管理。

```bash
python3 skills/sub-boss/scripts/bootstrap.py   --projects "$HOME/Projects"   --dest "$HOME/Projects/subboss"   --port 4317

python3 "$HOME/Projects/subboss/scripts/scan_projects.py" --dashboard
bash "$HOME/Projects/subboss/scripts/start_dashboard.sh"
```

项目根目录需要已存在，目标总控目录需要为空或不存在。打开 [本地看板](http://127.0.0.1:4317) 或 [项目启动台](http://127.0.0.1:4317/runtime.html)。扫描后的条目会明确显示尚待核实；可让 Agent 继续梳理。

停止看板：

```bash
bash "$HOME/Projects/subboss/scripts/stop_dashboard.sh"
```

关闭看板不会停止已启动的项目，重新打开后仍可管理。业务项目不会随电脑启动自动恢复。

## 从这套过程学到的设计

1. **先定管理范围**：独立总控目录，只读取指定项目。
2. **先事实后判断**：状态文件、Git、测试和验收分别取证。
3. **保留人的选择**：日报、追踪动作和人工分类分开存储。
4. **把判断做成可操作界面**：管理事项与启动服务分成两个视图。
5. **启动服务要能收得回来**：持久化归属、独立监督器、进程组清理，外部进程不碰。
6. **用真实操作验收**：浏览器检查与隔离启停测试，不能只看截图或构建结果。

完整流程在 [SKILL.md](skills/sub-boss/SKILL.md) 与 [工作流程](skills/sub-boss/references/workflow.md)。

## 数据与运行边界

配置保存在生成工作区的 `.subboss/config.json`。日报、追踪动作和分类是本地 JSON；项目服务及运行事件存 SQLite。真实状态、日志、本机路径和数据库不应提交到公开仓库。

默认只监听本机。控制器不接受任意 shell 命令、不自动安装依赖/迁移数据库/发布，也不会停止外部进程。启动仍会执行所选项目自己的代码，因此仅启动你信任的项目。复杂脚本、缺依赖、原生 App 与小程序会标明不可自动预览的原因。

可选对话目录读取本机 SQLite 元数据，包括标题、预览摘要、目录和归档状态，不读取正文或修改 Codex 数据库。该功能依赖客户端内部结构，未来可能需要适配。延期日期目前按 Asia/Shanghai 计算。

[状态契约](skills/sub-boss/references/state-contract.md) · [运行控制与隐私边界](skills/sub-boss/references/runtime.md)

## 开发与验证

```bash
python3 -m unittest discover -s tests -v
node --test skills/sub-boss/assets/workspace/dashboard-web/*.test.mjs
```

测试使用临时项目与随机端口，不扫描或修改你的业务项目。贡献时请保持过程归属保护、默认只读扫描、独立状态与无私有数据。不要提交数据库、日志、`.env` 或真实对话记录。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 CrossLee。
