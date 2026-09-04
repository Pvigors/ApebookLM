export type SourceType =
  | "pdf"
  | "text"
  | "url"
  | "youtube"
  | "bilibili"
  | "audio"
  | "markdown"
  | "image";

export type SourceStatus = "processing" | "ready" | "error";

export interface Notebook {
  id: string;
  title: string;
  emoji: string;
  cover_image?: string | null; // custom cover image (data URL) shown instead of the emoji
  created_at: number;
  /** 最近活动时间(来源/产物/笔记/本身的最新时间戳;列表「最近更新」列用)。 */
  last_activity?: number;
  source_count?: number;
  summary?: string | null;
  suggested_questions?: string[];
  // Per-notebook chat/generation settings (NotebookLM "Configure chat" + output language)
  chat_style?: string; // 'default' | 'learning' | 'custom'
  chat_instructions?: string | null;
  response_length?: string; // 'default' | 'longer' | 'shorter'
  output_language?: string | null; // '' = follow sources; else a language label
  public?: boolean; // shared read-only via /share/<id>
  pinned?: boolean; // 置顶到列表最前(每用户至多一个)
  user_id?: string | null; // owner
  // Curated "精选笔记本" (featured gallery)
  featured?: boolean;
  featured_order?: number;
  cover?: string | null; // CSS gradient string for the gallery cover
  publisher?: string | null; // e.g. "社区示例"
  publisher_avatar?: string | null; // emoji shown in the publisher chip
  featured_category?: string | null; // 精选分类(首页精选区的 chips 按此筛选);空=未分类
  editorial_note?: string | null; // 编者按(策展人手写,独立于机器概览 summary;订阅智库门面正文)
  overview_epoch?: number; // 全本概览 CAS 版本，防旧来源快照覆盖新概览
}

export interface User {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  wechat_openid: string | null;
  /** 微信授权最后一次返回的昵称快照；与用户可自改的 name 独立。 */
  wechat_nickname?: string | null;
  /** 开放平台在可用时返回的稳定联合标识。 */
  wechat_unionid?: string | null;
  avatar: string | null;
  created_at: number;
  last_seen: number;
  /** 成功颁发登录会话的累计次数；存量账号可能是保守回填值。 */
  login_count?: number;
  /** 最近一次成功颁发登录会话的时间。 */
  last_login_at?: number;
  /** 全局默认输出语言(空/缺省 = 跟随来源);被每本笔记的 output_language 覆盖。 */
  default_output_language?: string | null;
  /** 权益档位:free|trial|test(内部测试)|starter(Pro)|pro(Max)|max(Ultra)。 */
  plan_tier?: string;
  /** 限时权益到期时间(ms)；0/缺省 = 无限时权益。到期后惰性回落 free。 */
  plan_expires_at?: number;
  /** 1 = 后台停用,登录态作废、无法访问。 */
  disabled?: number;
  /** 1 = 数据库授予的管理员。
   *  三员体系下 is_admin=1 且未设 admin_role 者兼容视为超级管理员(super)。 */
  is_admin?: number;
  /** 三员角色:super(系统管理员)| operator(运营员)| auditor(安全审计员)。
   *  空 = 普通用户(除非 is_admin/env 判定为 super)。见 lib/admin.ts 权限矩阵。 */
  admin_role?: string | null;
  /** 用户自定义隐藏的生成磁贴(逗号分隔 tile id,见 studio-shared ARTIFACT_TILES;空=全显示)。 */
  hidden_tiles?: string | null;
  /** 本人的邀请码(推广链接用);首次进入推广页时惰性生成。 */
  invite_code?: string | null;
  /** 经谁的邀请链接注册(归因,一次性,注册时写入)。 */
  referred_by?: string | null;
  /** 奖励额度余额；无有效套餐时也可直接按次抵扣。 */
  bonus_credits?: number;
  /** 注册试用实际发放时间;0 = 尚未发放。 */
  trial_granted_at?: number;
  /** 注册赠送积分累计已发行额；不等于当前余额。 */
  signup_credits_granted?: number;
  /** 原始试用到期时间；调整权益档后仍保留，供兼容迁移使用。 */
  trial_expires_at?: number;
}

/** 活动记录的操作者类别。 */
export type ActivityActorKind = "user" | "admin" | "anon" | "system";

/** 统一活动 / 审计记录(谁在何时对什么做了什么)。 */
export interface ActivityEvent {
  id: number;
  ts: number;
  actor_id: string | null;
  actor_kind: ActivityActorKind;
  /** 点分动词,如 notebook.create / source.add / admin.user_disable / auth.login。 */
  action: string;
  target_type: string | null;
  target_id: string | null;
  notebook_id: string | null;
  /** JSON 旁注:{title,kind,from,to,status,error,ip,...}(密钥已脱敏)。 */
  meta: string | null;
  ip: string | null;
  ua: string | null;
  /** 仅 listEvents 联表带出,便于展示操作者名。 */
  actor_name?: string | null;
}

export type JobStatus = "draft" | "queued" | "running" | "done" | "error" | "canceled";
export type JobLane = "cad" | "non_cad";

export interface Job {
  id: string;
  notebook_id: string;
  user_id: string | null;
  kind: JobKind;
  title: string;
  status: JobStatus;
  progress: number; // 0-100
  params: string | null; // JSON
  output_id: string | null; // resulting studio_output id
  error: string | null;
  created_at: number;
  updated_at: number;
  /**
   * 本次 worker 认领代次。每次 queued → running 必须在数据库内原子 +1；
   * worker 的一切写副作用都必须携带认领时读到的值做 CAS，防止超时旧跑
   * 在新一跑已开始后落产物、写进度或改写终态。
   */
  run_attempt: number;
  /** 队列优先级(整数,越大越先被 worker 认领;NULL/旧行 → DEFAULT 0 等同 FIFO)。
   *  由 lib/jobs.ts enqueueArtifact 按 user.plan_tier→ getPlan(tier).queuePriority 写入。 */
  priority: number;
  /** 任务真实认领车道与时间边界。存量行为 null/0，不伪造历史。 */
  lane: JobLane | null;
  started_at: number;
  finished_at: number;
  /** CAD 阶段由 worker 进入真实步骤时写入；非 CAD 保持 null/0。 */
  stage: string | null;
  stage_started_at: number;
  /** 生成前预留价、成功后的真实 Token 结算价与用量。旧任务均为 0。 */
  credits_reserved: number;
  credits_final: number;
  tokens_in: number;
  tokens_out: number;
  idempotency_key?: string | null;
}

export interface Source {
  id: string;
  notebook_id: string;
  title: string;
  type: SourceType;
  status: SourceStatus;
  error: string | null;
  char_count: number;
  pages?: number; // PDF 页数(0=非 PDF/未知)
  chunk_count: number;
  created_at: number;
  selected: boolean;
  summary?: string | null;
  key_topics?: string[];
  origin?: string | null; // original URL for web / youtube sources
  fetched_at?: number | null; // 网页类来源最近一次抓取完成时间(NULL=存量行,前端用 created_at 兜底)
  extraction_backend?: "native" | "docling" | "crawl4ai";
  extraction_version?: string | null;
  /** JSON 字符串：引擎、版本、输入/输出 hash、耗时、页数和 fallback code。 */
  extraction_meta?: string;
}

export interface Chunk {
  id: string;
  source_id: string;
  notebook_id: string;
  chunk_index: number;
  content: string;
  /** F6:章节路径元数据(如「第二章 > 2.1 小节」);NULL=无标题文本或存量旧块。
   *  零重嵌入设计:embedding 只算 content,section 仅用于 BM25 词法信号与
   *  对话上下文块头(§ 路径),引用 snippet/前端高亮仍取 content。 */
  section?: string | null;
}

export interface RetrievedChunk extends Chunk {
  score: number;
  source_title: string;
  citation: number;
  /** 联网搜索结果使用临时来源；普通笔记本块缺省为 document。 */
  source_kind?: "document" | "web";
  source_url?: string;
}

export interface Citation {
  number: number;
  source_id: string;
  source_title: string;
  chunk_index: number;
  snippet: string;
  /** 新引用的精确证据定位；均为可选，兼容历史 messages.citations JSON。 */
  chunk_id?: string;
  quote?: string;
  source_start?: number;
  source_end?: number;
  source_content_hash?: string;
  source_kind?: "document" | "web";
  source_url?: string;
  /** web 当前只能核验搜索服务返回的摘要，不能冒充已抓取网页全文。 */
  evidence_kind?: "source_text" | "search_snippet";
  /** 核验时使用的相邻语境；高亮仍只使用 quote/source_start/source_end。 */
  verification_context?: string;
  verification_start?: number;
  verification_end?: number;
  /** 调试/审计字段：该证据实际核验的回答陈述。 */
  claim?: string;
  /** 去除“第一项结论是”等组织语后，实际送入证据核验的事实核心。 */
  evidence_claim?: string;
  /** 模型原始角标；最终展示编号可能因重复角标拆分而重新连续编号。 */
  original_number?: number;
}

export interface ChatMessage {
  id: string;
  notebook_id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  created_at: number;
  feedback?: "up" | "down" | null;
  /** 该用户轮由哪个服务端技能触发;只存安全 id,不存 prompt。 */
  skill_id?: string | null;
}

export type NoteKind = "manual" | "chat" | "report";

export interface Note {
  id: string;
  notebook_id: string;
  title: string;
  content: string;
  kind: NoteKind;
  created_at: number;
  converted_to_source?: number; // 1 once "转入来源" has run (greys the action)
  shadow_source_id?: string | null; // 隐藏的影子来源 id(让笔记进 RAG)
}

// Studio outputs: one-click reports, mind maps, and (P3) audio overviews.
export type StudioKind =
  | "study_guide"
  | "briefing"
  | "faq"
  | "timeline"
  | "toc"
  | "blog"
  | "custom"
  | "mindmap"
  | "audio"
  | "video"
  | "flashcards"
  | "quiz"
  | "infographic"
  | "slides"
  | "table"
  | "excalidraw"
  | "xhs"
  | "drawviso"
  | "cad";

/** 系统任务(非用户制品,不进 KIND_TITLE/积分/磁贴映射):订阅源轮询两级 job。 */
export type SystemJobKind = "feed_enum" | "feed_ingest";
export type JobKind = StudioKind | SystemJobKind;

export interface StudioOutput {
  id: string;
  notebook_id: string;
  kind: StudioKind;
  title: string;
  content: string; // markdown (reports) or mindmap markdown
  data: string | null; // json sidecar (e.g. audio path / metadata)
  status: SourceStatus;
  job_id?: string | null;
  run_attempt?: number | null;
  created_at: number;
  converted_to_source?: number; // 1 once "转入来源" has run (greys the action)
}

// 消息中心通知
export type NotificationType = "generation" | "collab" | "quota" | "feedback" | "system" | "feed";
export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  summary: string | null;
  link: string | null;
  read: number; // 0 | 1
  created_at: number;
}
