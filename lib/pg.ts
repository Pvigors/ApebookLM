// PostgreSQL 连接池。better-sqlite3(同步)→ pg(异步)迁移的连接层。
import { Pool, types } from "pg";

// 【关键】pg 默认把 BIGINT(int8,OID 20)返回为 string —— 为防大数精度丢失。
// 本项目所有 BIGINT 列都是:毫秒时间戳(Date.now() ~1.7e12)或计数,全部 < 2^53,
// 转 Number 安全无损。不转的话业务代码(把 created_at 当 number 比较、progress 做算术)
// 会拿到字符串而静默出错。故全局把 int8 解析成 Number。
types.setTypeParser(20, (v: string | null) => (v === null ? null : Number(v)));
// 【关键】numeric(OID 1700)pg 也默认返回 string。本项目 schema 无任何 NUMERIC/DECIMAL 列
// (全 text/bigint/bytea),numeric 只可能是 SUM(bigint) 等【整数聚合】的结果 —— 全是整数且远
// 小于 2^53,转 Number 无损。不转的话业务代码会静默出错:如 credit_ledger 对账页
// byOp.reduce((s,r)=>s+r.credits,0) 会把 "275"+"145" 字符串拼接成 "0275145..."(tsc 抓不到,
// 因为返回类型标的是 number 但运行时是 string)。若将来新增带小数的 NUMERIC 金额列,需在此按列 OID 细分。
types.setTypeParser(1700, (v: string | null) => (v === null ? null : Number(v)));

const CONN =
  process.env.DATABASE_URL ||
  // 本地开发默认:与 createdb nblm_dev 对齐;生产必须显式配 DATABASE_URL。
  "postgres://localhost:5432/nblm_dev";

// 跨 dev 热重载复用连接池(否则每次热重载都新开一池,连接泄漏)。
const g = globalThis as unknown as { __nblm_pg?: Pool };

export function getPool(): Pool {
  if (!g.__nblm_pg) {
    const pool = new Pool({
      connectionString: CONN,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // 【兜底】所有借出连接的服务端语句超时 30s。本应用所有 SQL 都亚秒级(最慢是几百行的
      // 后台聚合),真正的慢活(LLM/ffmpeg/嵌入)都在 SQL 之外;卡超 30s 的查询一定是异常
      // (DB 半死/锁等待),让服务端 cancel 掉,借出的 client 才能在 finally 归还,防池被卡死查询占满。
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30_000),
    });
    // 【关键·稳定性】pg 池必挂 'error' 监听。空闲连接的后端错误(PG 重启/主备切换/云侧对
    // 空闲 TCP 发 RST/pg_terminate_backend)会让 pool 触发 'error';Pool extends EventEmitter,
    // 'error' 无监听器 = Node 抛 uncaughtException → 整进程崩(better-sqlite3 进程内无网络连接,
    // 迁 pg 后才有的失败模式)。池会自行剔除坏连接,这里吞掉错误只记日志、不崩服务。
    // 监听仅在 !g.__nblm_pg 分支注册一次,天然幂等、不随热重载叠加。
    pool.on("error", (err) => {
      try {
        console.error("[pg pool idle client error]", err?.message || err);
      } catch {}
    });
    g.__nblm_pg = pool;
  }
  return g.__nblm_pg;
}
