-- PostgreSQL schema(从 lib/db.ts 的 SQLite DDL 翻译)。
-- 翻译规则:INTEGER→BIGINT(SQLite INTEGER 是 64 位;created_at 存 Date.now() ~1.7e12
-- 会溢出 PG 的 INT4,必须 BIGINT)、BLOB→BYTEA、INTEGER PK AUTOINCREMENT→BIGSERIAL。
-- 动态加的列(原 ensureColumns)已合并进 CREATE TABLE。CREATE TABLE IF NOT EXISTS 幂等。

CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📓',
  created_at BIGINT NOT NULL,
  summary TEXT,
  suggested_questions TEXT NOT NULL DEFAULT '[]',
  chat_style TEXT NOT NULL DEFAULT 'default',
  chat_instructions TEXT,
  response_length TEXT NOT NULL DEFAULT 'default',
  output_language TEXT,
  public BIGINT NOT NULL DEFAULT 0,
  pinned BIGINT NOT NULL DEFAULT 0,
  user_id TEXT,
  featured BIGINT NOT NULL DEFAULT 0,
  featured_order BIGINT NOT NULL DEFAULT 0,
  cover TEXT,
  cover_image TEXT,
  publisher TEXT,
  publisher_avatar TEXT,
  featured_category TEXT,
  editorial_note TEXT,
  chat_epoch BIGINT NOT NULL DEFAULT 0,
  overview_epoch BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  wechat_openid TEXT UNIQUE,
  -- 微信授权返回的最后一次真实昵称快照。与用户可自行修改的 name 独立，避免互相覆盖。
  wechat_nickname TEXT,
  -- 开放平台在可用时返回的稳定联合标识。
  wechat_unionid TEXT,
  avatar TEXT,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL DEFAULT 0,
  -- 只在成功颁发新会话时更新；日常请求仅刷新 last_seen。
  login_count BIGINT NOT NULL DEFAULT 0,
  last_login_at BIGINT NOT NULL DEFAULT 0,
  email TEXT,
  disabled BIGINT NOT NULL DEFAULT 0,
  is_admin BIGINT NOT NULL DEFAULT 0,
  admin_role TEXT,
  default_output_language TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'free',
  invite_code TEXT,
  referred_by TEXT,
  bonus_credits BIGINT NOT NULL DEFAULT 0,
  plan_expires_at BIGINT NOT NULL DEFAULT 0,
  hidden_tiles TEXT NOT NULL DEFAULT '',
  -- 注册试用额度的发放时间(0 = 未发放)。判重用它,不用 bonus_credits 余额。
  trial_granted_at BIGINT NOT NULL DEFAULT 0,
  -- 注册赠送积分累计已发行额。与当前余额分离，供升级补差和并发幂等裁决。
  signup_credits_granted BIGINT NOT NULL DEFAULT 0,
  -- 原始试用到期时间。调整权益档会覆盖 plan_expires_at，本列供兼容迁移使用。
  trial_expires_at BIGINT NOT NULL DEFAULT 0
);
-- email/invite_code 可空但存在时唯一(ALTER 无法内联加带谓词的 UNIQUE,用部分唯一索引)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code) WHERE invite_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  char_count BIGINT NOT NULL DEFAULT 0,
  pages BIGINT NOT NULL DEFAULT 0,          -- PDF 页数(0=非 PDF/未知);来源列表副标题「日期·N 页」
  chunk_count BIGINT NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  selected BIGINT NOT NULL DEFAULT 1,
  summary TEXT,
  key_topics TEXT NOT NULL DEFAULT '[]',
  origin TEXT,
  content_hash TEXT,
  fetched_at BIGINT,
  -- 抽取引擎与可复核元数据；正文/chunks/pages 与这些字段在摄取 claim 提交时原子换版。
  extraction_backend TEXT NOT NULL DEFAULT 'native',
  extraction_version TEXT,
  extraction_meta TEXT NOT NULL DEFAULT '{}',
  -- 摄取与导读都可能跨请求生命周期。原文抽取完后先暂存在 content，
  -- 再由 DB 租约单飞分块/嵌入；进程中断后页面轮询或同文件重传可续跑。
  ingest_authored BIGINT NOT NULL DEFAULT 0,
  ingest_lease_until BIGINT NOT NULL DEFAULT 0,
  ingest_claim_token TEXT NOT NULL DEFAULT '',
  ingest_attempts BIGINT NOT NULL DEFAULT 0,
  -- 导读/全本概览不能只靠 after() 内存回调；租约避免重复 URL 并发放大模型调用。
  enrich_lease_until BIGINT NOT NULL DEFAULT 0,
  enrich_claim_token TEXT NOT NULL DEFAULT '',
  enrich_attempts BIGINT NOT NULL DEFAULT 0,
  enrich_retry_at BIGINT NOT NULL DEFAULT 0,
  enriched_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  chunk_index BIGINT NOT NULL,
  content TEXT NOT NULL,
  embedding BYTEA NOT NULL,
  section TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_notebook ON chunks(notebook_id);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL,
  -- created_at 只精确到毫秒，并发/快速写入可同值。用单调序号作稳定次序，
  -- 否则“重新生成替换最后答案”可能把同毫秒 user 误当成尾行。
  message_seq BIGSERIAL,
  feedback TEXT,
  skill_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_notebook ON messages(notebook_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',
  created_at BIGINT NOT NULL,
  converted_to_source BIGINT NOT NULL DEFAULT 0,
  shadow_source_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebook_id);

CREATE TABLE IF NOT EXISTS studio_outputs (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  data TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  job_id TEXT,
  run_attempt BIGINT,
  created_at BIGINT NOT NULL,
  converted_to_source BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_studio_notebook ON studio_outputs(notebook_id);
-- job_id 是存量表 addCol 字段；相关索引统一在 lib/db.ts addCol 后创建。

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 系统管理员的独立短会话：cookie 保存随机 token，数据库只存 SHA-256。
-- credential_version 与环境凭据版本绑定，密码轮换后旧管理会话立即失效。
CREATE TABLE IF NOT EXISTS admin_password_principals (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  credential_version BIGINT NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  enabled BIGINT NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_version BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

-- 专用用户名/密码入口的共享登录限流。bucket_hash 只保存 SHA-256 指纹，
-- 不落 IP、用户名或访问密钥原文；蓝绿切换/进程重启后仍继续计数。
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_hash TEXT PRIMARY KEY,
  window_started_at BIGINT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated ON auth_rate_limits(updated_at);

CREATE TABLE IF NOT EXISTS notebook_collaborators (
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (notebook_id, user_id)
);

-- 用户收藏的精选笔记本(user-scoped 收藏夹;「精选笔记本」tab 展示的即此关系)。
-- 与 notebook_collaborators 同构的 join 表;删用户/笔记本级联清理。
CREATE TABLE IF NOT EXISTS notebook_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL DEFAULT 0,  -- 订阅注意力游标:该用户在此(智库)笔记本看到哪了。订阅时=now,防历史算未读。
  muted BIGINT NOT NULL DEFAULT 0,         -- 免打扰:保留未读徽章,不进站内铃铛。
  PRIMARY KEY (user_id, notebook_id)
);
CREATE INDEX IF NOT EXISTS idx_nbfav_user ON notebook_favorites(user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  user_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  progress BIGINT NOT NULL DEFAULT 0,
  params TEXT,
  output_id TEXT,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  run_attempt BIGINT NOT NULL DEFAULT 0,       -- 每次 queued→running 原子+1，隔离超时旧跑。
  priority BIGINT NOT NULL DEFAULT 0,
  lane TEXT,                                   -- 实际认领车道:cad / non_cad；旧任务 NULL。
  started_at BIGINT NOT NULL DEFAULT 0,        -- 首次被 worker 认领的毫秒时间。
  finished_at BIGINT NOT NULL DEFAULT 0,       -- done/error/canceled 终态的毫秒时间。
  stage TEXT,                                  -- CAD 真实执行阶段；非 CAD/旧任务可为 NULL。
  stage_started_at BIGINT NOT NULL DEFAULT 0,  -- 当前 stage 开始时间。
  channel_id TEXT,                             -- R1:feed 系统任务所属频道(用户任务 NULL)。
  idempotency_key TEXT,                        -- 用户任务幂等键；当前用于 CAD v3 网络重发。
                                               -- 补偿器/孤儿批回收按索引列联查,废掉 params LIKE 子串匹配
  credits_reserved BIGINT NOT NULL DEFAULT 0,  -- 生成前明确提示并预留的积分。
  credits_final BIGINT NOT NULL DEFAULT 0,     -- 成功后按真实 Token 结算的积分。
  tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_notebook ON jobs(notebook_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
-- 注意:channel_id 列的索引不在这里建 —— 存量库的 jobs 表已存在(IF NOT EXISTS 跳过建表),
-- 此时列还没被 addCol 补上,索引会炸。统一在 initSchema 的 addCol 之后建(见 lib/db.ts)。

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  link TEXT,
  read BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT
);

-- 用户自带模型接口：密钥仅保存 AES-256-GCM 密文，绝不进入 users/app_settings。
-- revision 同时是任务冻结的数据路由版本；改配置后旧排队任务会 fail closed。
CREATE TABLE IF NOT EXISTS user_model_configs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  chat_model TEXT NOT NULL,
  vision_model TEXT NOT NULL DEFAULT '',
  research_model TEXT NOT NULL DEFAULT '',
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  key_tag TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  enabled BIGINT NOT NULL DEFAULT 0,
  revision BIGINT NOT NULL DEFAULT 1,
  tested_revision BIGINT NOT NULL DEFAULT 0,
  last_tested_at BIGINT NOT NULL DEFAULT 0,
  last_test_status TEXT NOT NULL DEFAULT 'untested',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_model_configs_enabled
  ON user_model_configs(enabled, updated_at);

CREATE TABLE IF NOT EXISTS ai_calls (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  ms BIGINT NOT NULL,
  ok BIGINT NOT NULL,
  status BIGINT,
  error TEXT,
  tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0,
  -- 调用发生时按当时模型单价固化的人民币微元(1 元 = 1,000,000 micros)。
  -- 不在查询时用“今日价格”重算历史，避免改价后利润报表漂移。
  cost_micros BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_ts ON ai_calls(ts);

CREATE TABLE IF NOT EXISTS usage_daily (
  day BIGINT NOT NULL,
  provider TEXT NOT NULL,
  tokens_in BIGINT NOT NULL DEFAULT 0,
  tokens_out BIGINT NOT NULL DEFAULT 0,
  calls BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  actor_id TEXT,
  actor_kind TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  notebook_id TEXT,
  meta TEXT,
  ip TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_log(actor_id, ts);
CREATE INDEX IF NOT EXISTS idx_activity_notebook ON activity_log(notebook_id, ts);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action, ts);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  content TEXT NOT NULL,
  contact TEXT,
  images TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL,
  handled_at BIGINT,
  handled_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at);

CREATE TABLE IF NOT EXISTS user_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day BIGINT NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  op TEXT NOT NULL,
  credits BIGINT NOT NULL,
  ts BIGINT NOT NULL,
  bonus BIGINT NOT NULL DEFAULT 0,
  -- 本笔由套餐日额度承担的有符号积分。NULL = 旧版未拆桶流水。
  -- 消耗为正，同日退回为负；跨日权益退回转持久 bonus，该退回行记 0。
  plan_credits BIGINT,
  -- 扣减时是否为不限量权益。积分退回必须读快照，不能看退回时的当前权益档；
  -- 否则跨日退回会错误地把无限积分变成永久 bonus。
  unlimited_at_charge BIGINT NOT NULL DEFAULT 0,
  refunded BIGINT NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_ts ON credit_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id, ts);
-- 200 分升级补发每个用户至多一笔；用户行 marker 是主裁决，本索引是账本第二道保险。
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_signup_upgrade_200
  ON credit_ledger(user_id, op) WHERE op = 'bonus:signup:upgrade:200:v1';

CREATE TABLE IF NOT EXISTS credit_refund_outbox (
  ledger_id BIGINT PRIMARY KEY REFERENCES credit_ledger(id) ON DELETE CASCADE,
  job_id TEXT,
  user_id TEXT NOT NULL,
  op TEXT NOT NULL,
  credits BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts BIGINT NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0,
  claimed_at BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  done_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_credit_refund_due ON credit_refund_outbox(state, next_at);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  referee_id TEXT NOT NULL,
  milestone TEXT NOT NULL,
  credits BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  UNIQUE(referee_id, milestone)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

-- 订阅式发布源(领域智库):一个频道绑定一个精选笔记本,worker 定期轮询,有更新即抓取入库。
-- 设计见 docs/featured-subscription-design.md v2 §2.1 + docs/thinktank-library-design.md。
CREATE TABLE IF NOT EXISTS feed_channels (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- rss | weblist | sitemap | manual
  url TEXT NOT NULL DEFAULT '',                -- 轮询目标(manual 为空;抓取一律走 ssrfSafeFetch)
  config TEXT NOT NULL DEFAULT '{}',           -- adapter 私有配置 JSON:ua/tls_lax/item_filter/selector 等
  enabled BIGINT NOT NULL DEFAULT 1,
  interval_minutes BIGINT NOT NULL DEFAULT 360,-- AIMD 基准(钳 15..1440)
  next_poll_at BIGINT NOT NULL DEFAULT 0,      -- 抢占键:扫描器只写短租约,真值由 job 尾 CAS 写回
  poll_token TEXT,                             -- 抢占凭据:job 尾写回 WHERE poll_token=$claimed,防僵尸旧跑/运营手改被覆盖
  last_polled_at BIGINT NOT NULL DEFAULT 0,
  last_content_at BIGINT NOT NULL DEFAULT 0,   -- 最近真的抓到新内容(未读徽章比较基准)
  daily_ingested BIGINT NOT NULL DEFAULT 0,    -- 当日已入库篇数(每日配额闸,防 AIMD 放大)
  daily_reset_at BIGINT NOT NULL DEFAULT 0,
  fail_count BIGINT NOT NULL DEFAULT 0,        -- 连续失败:指数退避;≥5 置 broken 报警
  status TEXT NOT NULL DEFAULT 'active',       -- active | backfilling | broken
  last_error TEXT,
  etag TEXT,
  last_modified TEXT,
  created_at BIGINT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_feed_channels_notebook ON feed_channels(notebook_id);
CREATE INDEX IF NOT EXISTS idx_feed_channels_poll ON feed_channels(enabled, next_poll_at);

-- 已见条目(变化检测的集合差右操作数)。guid = RSS guid / 规范化 URL / content_hash 兜底。
CREATE TABLE IF NOT EXISTS feed_items (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES feed_channels(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  batch_id TEXT,                               -- 批身份:原子认领 + 简报幂等键
  backfill BIGINT NOT NULL DEFAULT 0,          -- R1:回填身份在【条目】粒度(枚举时按频道当时状态打标)——
                                               -- 频道 status 是 read-then-decide,死批经孤儿回收后身份会丢;
                                               -- 条目标志让「回填不是更新」在任何时序下都成立(诚实性①③)
  retry_after BIGINT NOT NULL DEFAULT 0,       -- 首败时间退避:此刻前不可认领(接力是秒级的,没有它两击重试=瞬态故障秒杀)
  source_id TEXT,                              -- 软引用 sources.id(源可删,不 CASCADE,防已见集丢失致重复入库)
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | ingested | failed | skipped
  error TEXT,
  published_at BIGINT,
  ingested_at BIGINT,                          -- 入库成功时刻(未读计数的正确基准)
  created_at BIGINT NOT NULL,
  UNIQUE(channel_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_feed_items_channel ON feed_items(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feed_items_unread ON feed_items(channel_id, status, ingested_at);

-- ── 数据工作台(lib/metrics.ts)的逐日聚合索引 ──────────────────────────────
-- 这些指标一律按「某个时间列 >= 窗口起点」再 GROUP BY 日序号。过滤条件本身是
-- sargable 的,一条普通 B-tree 索引就能把顺序扫变成范围扫;GROUP BY 用的日序号
-- 表达式吃不上索引顺序,会退化成 hash 聚合,但相对扫全表的代价可以忽略。
-- 不建的话,回看 1 天和回看 365 天的成本完全一样 —— 每次都是整表扫一遍。
CREATE INDEX IF NOT EXISTS idx_sources_created ON sources(created_at);
CREATE INDEX IF NOT EXISTS idx_studio_created ON studio_outputs(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
-- 「来源导入量」要排除订阅抓来的来源,判据是 feed_items.source_id 这条软引用
-- (订阅来源的 origin 与用户手动导入的完全相同,没有别的办法区分)。
-- 该表原有的两条索引都以 channel_id 打头,反查 source_id 用不上。
CREATE INDEX IF NOT EXISTS idx_feed_items_source ON feed_items(source_id) WHERE source_id IS NOT NULL;
