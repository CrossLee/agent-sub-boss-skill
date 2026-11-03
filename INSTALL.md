# Agent 安装说明

用户要求安装本仓库的 Sub-boss Skill 时，按以下流程执行。安装内容位于 `skills/sub-boss/`；仓库根目录不是 Skill 本体。仅具备文字回复能力、无法下载和写文件的 Agent 不能代为安装，应说明限制并提供 README 中的手动方法。

## 1. 确定安装目标

- **Codex**：优先使用当前环境提供的 `skill-installer`。仓库是 `CrossLee/agent-sub-boss-skill`，分支 `main`，Skill 路径是 `skills/sub-boss`，名称为 `sub-boss`。
- **Codex 默认目录**：使用 `CODEX_HOME` 下的 `skills/sub-boss`；未设置时使用 `~/.codex/skills/sub-boss`。
- **其他支持 SKILL.md 的 Agent**：遵循当前 Agent 自己的安装机制或已确认的 Skill 目录。不能确定目录时只询问安装位置，不猜测产品路径。
- 如果目标已存在，保留原样并报告“已安装”。更新、迁移和覆盖是单独的操作，不通过删除旧目录来完成安装。

## 2. 下载并安装

### Codex 有 skill-installer 时

先读当前环境实际提供的 `skill-installer/SKILL.md`，使用其 GitHub 安装器。例如，将 `<skill-installer目录>` 替换为本机已确认的目录：

```bash
python3 "<skill-installer目录>/scripts/install-skill-from-github.py" \
  --repo CrossLee/agent-sub-boss-skill \
  --path skills/sub-boss \
  --ref main
```

也可将这个完整 Skill 地址交给安装器：

https://github.com/CrossLee/agent-sub-boss-skill/tree/main/skills/sub-boss

### 没有专用安装器时

1. 将 `https://github.com/CrossLee/agent-sub-boss-skill.git` 的 `main` 分支克隆到新建临时目录，不覆盖用户现有仓库。
2. 阅读克隆后的 `scripts/install_skill.py` 和 `skills/sub-boss/SKILL.md`，确认安装只复制 Skill 文件。
3. 在克隆目录运行：

   ```bash
   python3 scripts/install_skill.py
   ```

   上述默认目标是 Codex。其他 Agent 在确认其安装目录后，可传 `--skills-dir "<该Agent的Skill目录>"`；安装器会在其中创建 `sub-boss` 子目录。

4. 安装缺少 Python 3 或网络访问失败时，如实报告。不要声称完成，也不要通过远程脚本管道执行来替代检查。

安装只需要复制文件。Node.js、Git、`ps`、`lsof` 等运行要求见 README；本次不需要创建总控目录、扫描项目、启动服务或读取 Codex 对话数据库。遵循当前环境的权限要求。

## 3. 检查安装结果

确认目标中的以下文件均存在，并与下载来源一致：

- `SKILL.md`（frontmatter 中 `name: sub-boss`）
- `agents/openai.yaml`
- `scripts/bootstrap.py`
- `references/workflow.md`
- `assets/workspace/dashboard-web/server.mjs`
- `assets/workspace/dashboard-web/state/dashboard.json`

保持目录层级完整，不要只下载单个 `SKILL.md`。确认文件落盘后再报告成功；这只代表已安装，不代表看板已经启动。不要为了验证安装而启动业务项目。

## 4. 告诉用户如何使用

简短报告实际安装位置和结果。Codex 安装后可在下一条消息使用 `$sub-boss`；若客户端尚未识别，再重新开启对话。给出以下示例：

> 使用 $sub-boss，为我的本地项目建立总控台。先确认项目目录，再盘点进展并配置预览服务。

其他 Agent 使用其支持的 Skill 调用方式，不承诺 `$sub-boss` 在所有产品中通用。
