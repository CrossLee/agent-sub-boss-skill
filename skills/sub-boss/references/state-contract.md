# 看板状态契约

## 持久化分工

| 文件 | 内容 | 刷新时规则 |
| --- | --- | --- |
| `.subboss/config.json` | 本机项目根目录、端口、对话目录开关 | 不上传到公开仓库 |
| `dashboard.md` | 文件与 Git 盘点 | 扫描器可更新 |
| `dashboard-web/state/dashboard.json` | 当前事项、日报、优先顺序 | Agent 核实后更新 |
| `dashboard-web/state/actions.json` | 用户结束/延期/无需追踪的选择 | 汇总时只读，不覆盖 |
| `dashboard-web/state/category-assignments.json` | 人工分类 | 汇总时只读，不覆盖 |
| `dashboard-web/state/runtime.sqlite` | 项目、服务、目录、运行与事件 | 由控制器维护 |
| `dashboard-web/state/runtime-logs/` | 运行日志 | 不上传 |

小规模日报沿用独立 JSON 快照；运行记录使用规范化 SQLite 表。不要把扫描报告改成巨大的单文件业务数据库。

## 最小日报示例

下列数据是虚构示例。`evidence` 使用布尔值；`false` 表示暂无确认，不表示失败。

```json
{
  "version": 1,
  "generatedAt": "2026-01-01T09:00:00+08:00",
  "overallStatus": "需要拍板",
  "summary300": "演示项目等待确定首批验收范围，测试结果尚未核实。",
  "priorities": ["demo-scope"],
  "tasks": [{
    "id": "demo-scope",
    "source": "reviewed",
    "project": "演示项目",
    "title": "确认首批验收范围",
    "status": "decision",
    "category": "product",
    "stage": "需求确认",
    "owner": "项目负责人",
    "suggestedDate": "2026-01-02",
    "decisionNeeded": true,
    "progress": "已整理需求清单，见项目状态文件。",
    "remaining": "首批范围尚未确认。",
    "next": "由项目负责人确认验收清单后再安排开发。",
    "evidence": {"code": false, "build": false, "installed": false, "committed": false, "deployed": false, "accepted": false}
  }]
}
```

`status`：`risk`、`decision`、`progress`、`waiting`、`unknown`、`completed`。
`category`：`product`、`research`、`troubleshooting`、`content`、`education`、`operations`、`uncategorized`。

可选 `sourceThreadId` 必须来自真实关联对话；不要把示例 UUID 写入实际数据。`sourcePaths`、`scannedAt` 记录来源及盘点日期。证据的说明、测试范围和日期放在 `progress` 或 `remaining`，只在当前证据足够时将对应布尔值设为 `true`。

扫描器生成的任务 `source=project-scan`，重复扫描只刷新这类任务；它保留其他来源的任务与失去对应目录的历史任务。人工整理后改为 `reviewed`。扫描器不会维护优先级，Agent 需复核原优先列表。

## 用户动作

`actions.json` 结构为 `{"version":1,"items":{}}`。每个任务 ID 对应 `{action,updatedAt,deferredUntil?}`；`action` 可以是 `completed`、`no_tracking` 或 `deferred`。恢复追踪时移除该动作。延期使用 Asia/Shanghai 的日历日期，3 天后恢复；源任务本身已完结时不被旧延期记录恢复。

`category-assignments.json` 同样使用 `version/items`，值为类别字符串。API 只读合并分类覆盖，不回写日报。
