export const categoryLabels = Object.freeze({
  product: "产品开发",
  research: "调研分析",
  troubleshooting: "问答排查",
  content: "内容创作",
  education: "课程教学",
  operations: "运营事务",
  uncategorized: "待分类",
});

// Classify the purpose of a conversation, not incidental words in its latest
// progress, blockers, evidence, or next steps. Explicit product tags are the
// owner's grouping signal and therefore take precedence over every heuristic.
const productTag = /\[\s*product\s*\]/i;
// Action + deliverable is stronger than a topic noun: developing a course
// website is product work, while making a website tutorial video is content.
const intentRules = [
  { category: "troubleshooting", pattern: /^(?:请|帮我)?(?:解释|识别|解答|这是(?:什么|哪个)|如何打开|怎么打开|能否|确认能否)|^(?:fix|debug|troubleshoot|install)\b|^(?:安装|卸载|移除|启用|禁用|设置|配置).*(?:工具|插件|skill|软件|合盖|盒盖|休眠|自动执行|codex|chatgpt|claude|listenhub|google play|vpn)|(?:codex|chatgpt|claude|软件|应用).*(?:音色设置|订阅|权限设置)|^(?:检查|确认|取消).*订阅|(?:清理|删除).*(?:文件|缓存|磁盘)|(?:查找并关闭|了解并移除)|^add\s+[^\s]+\/[^\s]+/i },
  { category: "research", pattern: /^(?:请|帮我)?(?:调研|研究|对比|比较|评估|选型|推荐|挑选|选购|分析|了解|核查)|^(?:research|compare|locate)\b|(?:查找|搜索).*(?:开源|收益|购买|最低价|耳机|资料|方案)|收集.{0,8}信息|搜集.{0,8}信息/i },
  { category: "troubleshooting", pattern: /^(?:排查|诊断|修复|解决).*|检查.*(?:异常|泄露|失灵)/i },
  { category: "content", pattern: /(?:制作|生成|创作|设计|撰写|改写|编辑|提取|策划).*(?:视频|口播|海报|文案|图片|配图|奖状|logo|分享内容|演讲稿|自我介绍|界面|\bpptx?\b)|^(?:create|make|edit)\s+(?:video|image|poster)\b/i },
  { category: "product", pattern: /^(?:开发|构建|集成|接入|实现)|(?:建立|规划|制作|完善).*(?:网站|小程序|平台框架|软件系统)|(?:新增|扩展|更新).*(?:功能|需求|接口|画像|支付|交易|开票)|(?:产品|技术).{0,6}架构|产品概述|生成.*需求文档|(?:html|flutter).*(?:还原|实现)|还原.*(?:网页|页面)/i },
  { category: "education", pattern: /编程课|第[一二三四五六七八九十\d]+课|几何题|平方数|思维训练|孩子.*(?:自主表达|表达引导)|AI做题.*学习|(?:规划|设计|讲解|辅导|改善).*(?:课程|教学|学习架构|学习方案|启蒙)/i },
  { category: "operations", pattern: /(?:黑客松|极客营|青年营).*(?:策划|方案|全周期|合作)|(?:制定|策划|规划).*(?:黑客松|赛事|活动)|场地合作|咨询方案|统计.*积分|接龙通知|解除申请/i },
];
const topicRules = [
  { category: "research", pattern: /调研|研究|选型|评估|对比|比较|测算|发展历程|资料搜集|资料收集|市场分析|可行性分析/i },
  { category: "troubleshooting", pattern: /排查|诊断|报错|故障|崩溃|异常|修复|修好|打不开|无法(?:启动|打开|运行|连接|安装)|清理.*(?:app|应用|缓存|磁盘)|解决.*(?:问题|错误)|^(?:请|帮我)?(?:解释|识别|解答|这是(?:什么|哪个)|这是什么|如何打开|怎么打开|能否)/i },
  { category: "content", pattern: /视频|口播|剪辑|分镜|配音|海报|文案|宣传片|宣传图|配图|脚本创作|演示稿|分享稿|演讲稿|英语演讲|公众号|短片|拍摄|品牌.*logo|\bpptx?\b|\bb.?roll\b/i },
  { category: "education", pattern: /课程|教学|教案|课包|上课|试教|备课|课件|首课|次课|课时|社团|学习架构|学习方案|教育方案|教育产品|启蒙|习题|数学题|三视图|辅导|班级/i },
  { category: "product", pattern: /开发|构建|代码|框架|软件|真机|小程序|网站|网页|客户端|服务端|后端|前端|接口|上架|发版|版本发布|部署|数据库|\b(?:app|api|sdk|erp|poc|agent)\b/i },
  { category: "operations", pattern: /运营|考勤|请假|加班|报销|账单|对账|审批|排期|招生|报名|收费|活动方案|赛事方案|比赛方案|赛事组织|赛制|资源落实|家长群|预算|采购|合同|会议纪要|整理.*(?:文件|目录|对话)|归档|^sub\s*boss$|项目总控|工作管理/i },
];

function primaryText(value, name) {
  // Some old records use an entire pasted prompt as their title. Do not let
  // incidental words hundreds of lines into that prompt determine the purpose.
  if (name === "标题") return value.trim().split(/\r?\n/, 1)[0].slice(0, 220);
  if (name === "摘要") return value.trim().slice(0, 400);
  return value;
}

function classify(item) {
  const source = item && typeof item === "object" ? item : {};
  const titles = [source.sourceTitle, source.title].filter(value => typeof value === "string" && value.trim());
  if (titles.some(title => productTag.test(title))) {
    return { category: "product", reason: "对话标题含 [PRODUCT] 标记，归入产品开发。" };
  }
  if (typeof source.category === "string" && Object.hasOwn(categoryLabels, source.category)) {
    return { category: source.category, reason: `沿用已保存分类：${categoryLabels[source.category]}。` };
  }
  const fields = [
    ...titles.map(value => ({ name: "标题", value })),
    { name: "摘要", value: source.summary },
    { name: "项目", value: source.project },
  ];
  for (const { name, value } of fields) {
    if (typeof value !== "string" || !value.trim()) continue;
    const text = primaryText(value, name);
    const rule = intentRules.find(candidate => candidate.pattern.test(text)) || topicRules.find(candidate => candidate.pattern.test(text));
    if (rule) return { category: rule.category, reason: `根据${name}中的主要工作内容，归入${categoryLabels[rule.category]}。` };
  }
  return { category: "uncategorized", reason: "尚无明确的工作类型线索，保留待分类。" };
}

export function categoryFor(item) {
  return classify(item).category;
}

export function categoryReason(item) {
  return classify(item).reason;
}
