// Seeds a curated “快速上手” notebook whose sources are practical tips for this app.
// Chatting with the notebook teaches the product through its own workflows.
import {
  createSource,
  createStudioOutput,
  deleteNotebook,
  getNotebook,
  setNotebookFeatured,
  setNotebookOverview,
  setNotebookPublic,
  setSourceGuide,
} from "@/lib/db";
import { getPool } from "@/lib/pg";
import { ingestSource } from "@/lib/rag";

const SYSTEM_USER_ID = "system-0000-0000-0000-000000000000";
const GS_ID = "nb-featured-getting-started";

type SeedSource = { title: string; summary: string; topics: string[]; body: string };

const GS_SOURCES: SeedSource[] = [
  {
    title: "① 先别想太多 — 5 分钟跑通一遍",
    summary: "新手第一步:随手丢几份最近的资料(哪怕零散)进来直接提问,先感受'基于来源+带引用'。",
    topics: ["新手第一步", "快速开始", "先随便试"],
    body: `# 先别想太多,5 分钟跑通一遍

新手最容易卡在"我得先准备好完美的资料"。**别**。最快的上手方式是:

1. **建一个笔记本**(首页点「新建」)。
2. **随手丢进几份最近的资料** —— 哪怕零散、不相关都行:一份 PDF、一段粘贴的文字、一个网页链接、一个 B 站视频。
3. **直接提问**,看它怎么基于这些资料回答、并标注引用。

这一步的目的不是产出,而是**先感受**它的核心:只基于你给的来源作答,而且**每句话都能点引用核对原文**。这就是它和普通聊天机器人最大的不同——有据可循。

> 一句话理解它:这是一个"帮你理解事物"的工具。先把手边的东西丢进去问问看,比读十页说明书都管用。`,
  },
  {
    title: "② 建一个「万能笔记本」,再按主题分家",
    summary: "先建一个装日常常用知识的'万能笔记本',重要主题/项目再各自单独建本。一个笔记本=一个主题。",
    topics: ["万能笔记本", "按主题分", "组织方式"],
    body: `# 建一个「万能笔记本」,再按主题分家

一个很好用的习惯:先建一个 **「万能笔记本」**,把你日常最常打交道的知识都装进去——读过的书摘、喜欢的金句、公司的核心文档、这些年攒下的灵感碎片。

这样它就成了一个**懂你的私人 AI**:随时能问"我之前记过关于 X 的什么?""把我那几条灵感串成一个提纲"。

等某个主题/项目变重了,再**单独为它建一个笔记本**,只放相关资料。比如:为"装修"建一本(放报价单、攻略、聊天记录),为某门课建一本(放讲义、论文、笔记)。

> 原则:**一个笔记本 = 一个主题**。"万能笔记本"负责日常,"主题笔记本"负责深入。主题越聚焦,回答越准。`,
  },
  {
    title: "③ 真正的杀手锏 — 跨资料连点成线",
    summary: "它最强的不是总结单篇,而是把散落在多个文件/网页/笔记里的信息连接、综合、对比起来。",
    topics: ["连点成线", "综合多源", "对比观点"],
    body: `# 真正的杀手锏:跨资料连点成线

如果你只用它总结一篇 PDF,那太浪费了。这类工具**最强的地方,是把散落在十几个文件、网页、笔记里的信息「连接、综合」起来**。

试试:把一个主题下**所有相关的资料**都丢进同一个笔记本——几篇文章、几张图、一堆零碎笔记——然后问它:

- "把这些资料里关于 X 的不同观点对比一下。"
- "综合所有来源,给我一个能直接用的提纲。"
- "这几份资料有没有互相矛盾的地方?"

它会跨来源帮你**串起来**,而且每个结论都带引用。你再拿这个综合结果去写 PPT、写报告,效率翻倍。

> 工作流:先发散想法 → 把相关文章/资料收集起来 → 全部丢进一个笔记本让它综合 → 用综合结果去产出。`,
  },
  {
    title: "④ 从「建议问题」开始,学会看引用",
    summary: "不知道问什么就用建议问题起步,问着会推荐追问;回答里的引用角标 [n] 点开核对原文。",
    topics: ["建议问题", "引用角标", "追问", "可信赖"],
    body: `# 从「建议问题」开始,学会看引用

**不知道问什么?** 上传资料后,系统会自动给几个**建议问题**,点一下就能开问。问着问着,它还会根据你已经问的内容**推荐追问**,顺着往下挖就行。

**看懂引用。** 回答里会出现 [1]、[2] 这样的**上标角标**,这是引用,表示"这句话的依据来自第 N 个来源"。点它就能跳到原文核对。

为什么这点这么重要?因为 AI 仍可能出错。**有引用 = 可核对 = 可信赖**。养成"看到关键结论就点一下引用"的习惯——这是用好它、也是和普通 AI 聊天拉开差距的关键。`,
  },
  {
    title: "⑤ 把资料变成各种形式 — 尤其是音频概览",
    summary: "同一份资料可一键变成问答/简报/时间线/学习指南/思维导图/闪卡/测验/信息图/幻灯片;招牌是音频概览(双人播客,可自定义)。",
    topics: ["工作室", "音频概览", "播客", "自定义", "多种形式"],
    body: `# 把资料变成各种形式,尤其是音频概览

同一份资料,在右边的「工作室」可以**一键变成很多种形式**,挑适合你当下场景的:

- **常见问答 / 简报 / 时间线 / 目录 / 学习指南** —— 不同角度的文字整理。
- **思维导图** —— 把要点整理成可展开的脑图。
- **闪卡 / 测验** —— 自动出题,适合复习自测。
- **信息图 / 幻灯片** —— 一键出图、出 PPT。

**招牌玩法:音频概览。** 它能把你的资料变成**两位主持人对谈的播客**,通勤、走路时听特别香(生成要等几分钟)。还能点「自定义」**指挥主持人**:聚焦某个话题、调整深浅、甚至让他们点评你自己写的东西。

> 小贴士:生成前先把来源**勾选准**——产物质量取决于你喂进去的来源。`,
  },
  {
    title: "⑥ 别只拿来学习工作 — 创意玩法 + 存下来 + 分享",
    summary: "写小说/游戏世界观、对自己作品要批评;好回答'存为笔记',聊完让它总结成一条笔记;还能公开分享/协作/复制精选。",
    topics: ["创意玩法", "存为笔记", "总结对话", "分享", "复制精选"],
    body: `# 别只拿来学习工作:创意玩法 + 存下来 + 分享

**创意玩法。** 它不只是学习/工作工具。写小说、剧本、做游戏世界观的人会把**人物、设定、世界观笔记**全丢进去,然后问:

- "哪个角色最有意思?"(相当于对"有趣度"做 Ctrl+F)
- "某个角色住在哪、和谁有过节?"
- "对我这段文字,给点犀利的批评建议。"

**把好东西存下来。** 觉得某段回答有用,点回答下方的**「存为笔记」**。聊到一段落,直接让它**"把这次对话的要点总结成一条笔记"**,下次回来接着干,不用从头捋。

**分享出去。** 做好的笔记本可以开**公开只读链接**分享,或邀请**协作者**一起编辑。首页的「精选笔记本」(比如你正在看的这本)就是公开只读的;想在它基础上改,点**「复制到我的笔记本」**拷一份即可自由编辑。`,
  },
];

const GS_OUTPUTS: { kind: "study_guide" | "faq"; title: string; content: string }[] = [
  {
    kind: "study_guide",
    title: "上手路线图 · 从 0 到会用",
    content: `# 上手路线图 · 从 0 到会用

## 第 0 步:先跑通一遍(5 分钟)
随手丢几份资料 → 提问 → 看引用。先感受"基于来源、有据可循",别追求完美。

## 第 1 步:组织你的笔记本
- 建一个「万能笔记本」装日常常用知识。
- 重要主题/项目各自单独建一本。**一个笔记本 = 一个主题**。

## 第 2 步:让它连点成线
把一个主题的所有资料丢进一个笔记本,让它跨来源**综合、对比、找矛盾**,再拿结果去产出。

## 第 3 步:问得好
从「建议问题」起步,顺着推荐追问往下挖;关键结论点引用核对。

## 第 4 步:变形 + 留存
工作室一键出问答/导图/测验/**音频概览**(招牌!可自定义);好回答「存为笔记」,聊完让它总结成一条笔记。

## 记住三句话
1. **有据可循** —— 点引用核对。
2. **一个笔记本一个主题** —— 越聚焦越准。
3. **先丢进去试** —— 比读说明书快。`,
  },
  {
    kind: "faq",
    title: "常见问答",
    content: `# 常见问答

**Q:我是纯新手,第一步做什么?**
A:别准备太多。建个笔记本,随手丢几份最近的资料,直接提问,先感受一下。

**Q:什么是"万能笔记本"?**
A:一个装你日常常用知识(书摘、金句、公司文档、灵感)的总笔记本,相当于一个懂你的私人 AI。重要主题再单独建本。

**Q:它和普通 AI 聊天有什么不同?**
A:它只基于你给的来源作答,并标注引用,可点开核对原文——有据可循。

**Q:音频概览是什么?能自定义吗?**
A:把资料变成两位主持人对谈的播客。可以点「自定义」指挥主持人聚焦话题、调整深浅。

**Q:支持哪些来源格式?**
A:PDF、纯文本、网页链接、Bilibili 视频(字幕/简介)。

**Q:精选笔记本能改吗?**
A:只读。点「复制到我的笔记本」拷一份到自己账号即可自由编辑。`,
  },
];

const GS_QUESTIONS = [
  "我是新手,第一步该做什么?",
  "什么是「万能笔记本」?为什么推荐这样建?",
  "音频概览(播客)怎么玩?能自定义吗?",
  "除了学习和工作,还有哪些创意玩法?",
];

const GS_OVERVIEW =
  "这本笔记本会自己教你怎么用 —— 它的来源就是一份《上手技巧》。在右边直接问它:第一步做什么、怎么建「万能笔记本」、音频概览怎么玩、有哪些创意玩法……它会基于这些技巧回答你。一个「帮你理解事物」的工具,5 分钟就能上手。";

async function ensureSystemUser(): Promise<void> {
  const pool = getPool();
  const has = (await pool.query("SELECT 1 FROM users WHERE id = $1", [SYSTEM_USER_ID])).rows[0];
  if (!has) {
    await pool.query(
      "INSERT INTO users (id, name, phone, avatar, created_at, last_seen) VALUES ($1, $2, $3, $4, $5, 0)",
      [SYSTEM_USER_ID, "社区示例", null, "✨", Date.now()]
    );
  }
}

/** Idempotently seed the curated "快速上手" featured notebook. Pass force to rebuild it. */
export async function seedFeatured(opts: { force?: boolean } = {}): Promise<{ created: boolean; id: string }> {
  await ensureSystemUser();
  if (await getNotebook(GS_ID)) {
    if (!opts.force) return { created: false, id: GS_ID };
    await deleteNotebook(GS_ID); // cascades sources/chunks/studio outputs
  }

  await getPool().query(
    "INSERT INTO notebooks (id, title, emoji, created_at, user_id) VALUES ($1, $2, $3, $4, $5)",
    [GS_ID, "快速上手 · 5 分钟玩转猿笔记", "🚀", Date.now(), SYSTEM_USER_ID]
  );

  await setNotebookOverview(GS_ID, GS_OVERVIEW, GS_QUESTIONS);
  await setNotebookPublic(GS_ID, true);
  await setNotebookFeatured(GS_ID, {
    featured: true,
    order: 0,
    cover: "linear-gradient(135deg,#6d5ae6 0%,#9a7cf0 52%,#b765ec 100%)",
    publisher: "社区示例",
    publisherAvatar: "✨",
  });

  for (const s of GS_SOURCES) {
    const src = await createSource(GS_ID, s.title, "text");
    await ingestSource(src.id, GS_ID, s.body, { authored: true });
    await setSourceGuide(src.id, s.summary, s.topics);
  }

  for (const o of GS_OUTPUTS) {
    await createStudioOutput(GS_ID, o.kind, o.title, o.content);
  }

  return { created: true, id: GS_ID };
}
