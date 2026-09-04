# 贡献指南

感谢参与 ApebookLM。

## 开始前

1. 先搜索现有 Issue 和 Pull Request。
2. 较大功能先创建讨论，确认范围和数据合同。
3. 安全漏洞按 `SECURITY.md` 私密报告。

## 本地验证

项目需要 Node.js 20 和 PostgreSQL 16。测试必须使用通过 `PG_ADMIN_URL` 指定的独立管理库账号，测试框架会创建并删除 `nblm_test_*` 数据库。

提交前运行：

```bash
npx tsc --noEmit --incremental false
npm test
npm run check:public
npm run build
```

## Pull Request 要求

- 一个 PR 解决一个清晰问题。
- 行为变化应包含回归测试和必要文档。
- 不降低鉴权、SSRF、任务幂等、积分退回或 CAD 验证门禁。
- 不提交真实凭据、内部资料、生产配置或来源不明的资产。
- 修改第三方改编代码时保留上游版权和许可说明。

提交贡献即表示你有权提交相关内容，并同意其按本仓库许可证发布。项目在引入双许可证前将另行讨论贡献者授权机制。
