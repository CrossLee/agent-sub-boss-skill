import test from "node:test";
import assert from "node:assert/strict";
// The cross-project management chat is operational work, not an unknown topic.
test("sub boss coordination belongs to operations unless explicitly tagged PRODUCT", () => {
  assert.equal(categoryFor({ title: "subboss" }), "operations");
  assert.equal(categoryFor({ title: "sub boss" }), "operations");
  assert.equal(categoryFor({ title: "[PRODUCT] subboss" }), "product");
});
import { categoryFor, categoryLabels, categoryReason } from "./categories.mjs";

test("taxonomy has stable ids and Chinese labels", () => {
  assert.deepEqual(categoryLabels, {
    product: "产品开发", research: "调研分析", troubleshooting: "问答排查",
    content: "内容创作", education: "课程教学", operations: "运营事务", uncategorized: "待分类",
  });
  assert.equal(Object.isFrozen(categoryLabels), true);
});

test("explicit PRODUCT tags win over stored classification and issue or research keywords", () => {
  for (const title of ["[PRODUCT] 示例产品 修复错误", "[product] 调研支付问题", "[ Product ] 教学视频工具"]) {
    assert.equal(categoryFor({ sourceTitle: title, category: "research" }), "product");
    assert.match(categoryReason({ sourceTitle: title }), /\[PRODUCT\]/);
  }
  assert.equal(categoryFor({ title: "[PRODUCT] 后端报错", sourceTitle: "排查问题", category: "troubleshooting" }), "product");
  assert.notEqual(categoryFor({ title: "制作 product 宣传视频" }), "product");
});

test("valid saved category is honored unless a title has an explicit product tag", () => {
  assert.equal(categoryFor({ title: "调研设备", category: "content" }), "content");
  assert.equal(categoryFor({ title: "开发网站", category: "uncategorized" }), "uncategorized");
  assert.equal(categoryFor({ title: "调研设备", category: "not-a-category" }), "research");
  assert.equal(categoryFor({ category: "toString" }), "uncategorized");
  assert.match(categoryReason({ category: "education" }), /沿用已保存分类/);
});

test("primary purpose distinguishes research, troubleshooting, content, education, product and operations", () => {
  for (const [title, expected] of [
    ["调研口播视频拍摄设备", "research"],
    ["梳理特斯拉 Roadster 发展历程", "research"],
    ["对比课程平台方案", "research"],
    ["排查视频播放崩溃", "troubleshooting"],
    ["识别并清理无图标 App", "troubleshooting"],
    ["解决网页打不开的问题", "troubleshooting"],
    ["解释 .motion 的含义", "troubleshooting"],
    ["识别图片中的图标", "troubleshooting"],
    ["这是哪个 app", "troubleshooting"],
    ["如何打开这个文件", "troubleshooting"],
    ["能否恢复我的窗口", "troubleshooting"],
    ["制作网页三要素教学视频", "content"],
    ["策划 示例设备 黑客松主题 PPT", "content"],
    ["收费海报审核选版", "content"],
    ["规划示例学校 AI 社团课程", "education"],
    ["规划家长与孩子的 AI 学习架构", "education"],
    ["建立黑客松赛事平台框架", "product"],
    ["开发学生学习追踪网站", "product"],
    ["小程序上传与真机验收", "product"],
    ["统计每月请假与加班余额", "operations"],
    ["完善示例青年营赛制", "operations"],
  ]) assert.equal(categoryFor({ title }), expected, title);
});

test("source title and task title precede incidental summary or project words", () => {
  assert.equal(categoryFor({ sourceTitle: "规划社团课程", title: "修改视频", summary: "调研设备", project: "app" }), "education");
  assert.equal(categoryFor({ title: "制作视频", summary: "修复脚本错误", project: "AI教育" }), "content");
  assert.equal(categoryFor({ title: "后续安排", summary: "进行设备选型", project: "课程" }), "research");
  assert.equal(categoryFor({ title: "后续安排", project: "ip / Codex管理视频" }), "content");
});

test("explicit purpose distinguishes mixed topic and intent examples", () => {
  for (const [title, expected] of [
    ["开发AI社团随机分组网站", "product"],
    ["开发少儿AI课程网站", "product"],
    ["分析 示例工具 网站", "research"],
    ["生成图片", "content"],
    ["生成AI小发明家奖状", "content"],
    ["设计AI编程课方案", "education"],
    ["Brainstorm NotebookLM第四课", "education"],
    ["推荐85寸投屏教学屏", "research"],
    ["启用 code 自动执行", "troubleshooting"],
    ["Codex语音音色设置", "troubleshooting"],
    ["新增会员画像与交易开票", "product"],
    ["集成 Loading State 组件", "product"],
  ]) assert.equal(categoryFor({ title, summary: "需要研究方案，生成视频并修复异常。" }), expected, title);
});

test("clear tool usage, learning, operations, research and creative purposes do not stay unknown", () => {
  for (const [title, expected] of [
    ["安装并使用 listenhub-hypit", "troubleshooting"],
    ["安装 kill-ai-slop skill", "troubleshooting"],
    ["Install ChatCut plugin", "troubleshooting"],
    ["Add example/video-tool", "troubleshooting"],
    ["设置合盖继续工作", "troubleshooting"],
    ["检查 Codex 与 ChatGPT 订阅", "troubleshooting"],
    ["确认软件订阅是否通用", "troubleshooting"],
    ["查找并关闭 Mac 自动弹窗", "troubleshooting"],
    ["了解并移除 Adobe IPC Broker", "troubleshooting"],
    ["讲解几何题的思维训练", "education"],
    ["统计末三位为4的六位平方数", "education"],
    ["改善孩子自主表达引导", "education"],
    ["AI做题与真实学习", "education"],
    ["制定两档黑客松策划案", "operations"],
    ["示例学校校园黑客松合作方案", "operations"],
    ["撰写场地合作契合度介绍", "operations"],
    ["梳理AI咨询方案", "operations"],
    ["统计剩余积分", "operations"],
    ["分析论文内容", "research"],
    ["分析文章里的需求", "research"],
    ["查找需求相关开源项目", "research"],
    ["了解 typesafe.ai", "research"],
    ["挑选小天才电话手表", "research"],
    ["帮我收集一下信息并整理", "research"],
    ["设计品牌Logo风格", "content"],
    ["基于对话背景生成亲子分享内容", "content"],
    ["设计游戏界面", "content"],
    ["Create video spec", "content"],
    ["撰写产品与技术架构", "product"],
    ["Fix OpenClaw pairing failure", "troubleshooting"],
  ]) assert.equal(categoryFor({ title }), expected, title);
});

test("an old pasted prompt title is classified by its headline, not incidental body details", () => {
  assert.equal(categoryFor({ title: "## 1. 产品概述\n示例课程报名系统\n实现阶段选型为准" }), "product");
  assert.equal(categoryFor({ title: "制作教学视频\n课程方案调研与软件错误排查" }), "content");
});

test("unknown values stay unclassified and progress or blockers do not classify the work", () => {
  for (const item of [null, undefined, "开发网站", {}, { title: "如何继续" }, { title: "hello" }, { title: "实时语音聊天" }, { title: "优化现有内容" }, { title: "继续", progress: "构建通过", remaining: "需要调研", next: "排查错误" }, { title: 42 }]) {
    assert.equal(categoryFor(item), "uncategorized");
  }
  assert.match(categoryReason({ title: "继续" }), /待分类/);
});

test("classification is pure and preserves all original data", () => {
  const item = Object.freeze({ title: "规划课程", project: "app", evidence: Object.freeze({ code: false, build: false }) });
  const before = JSON.stringify(item);
  assert.equal(categoryFor(item), "education");
  categoryReason(item);
  assert.equal(JSON.stringify(item), before);
});
