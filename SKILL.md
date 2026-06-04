---
name: every-translate
description: Translate and rewrite Every.to newsletter articles into publication-ready Chinese. Use for fast-track translations (skill mode) that need quick output to a review queue, or pair with the every-translate aApp for multi-round editorial refinement. Produces glossed, fact-checked, and review-pending drafts in a separate workspace — does NOT touch every.beyondmotion.net.
---

# Every Translate (every-translate)

独立翻译 skill，从 `every-newsletter-pipeline` 抽离而来。**两线交付**：

- **Skill 模式**（本 skill）：单次快出 → 走事实核查 → 走终审 → 输出到 remio 草稿 + 本地副本
- **aApp 模式**（every-translate aApp）：多轮编辑流水线 + UI 反向打磨

## ⚠️ 独立原则（违反即视为污染）

| 禁止 | 后果 |
|---|---|
| ❌ 修改 every-to-newsletter 仓库 | 数据污染 |
| ❌ push 到 every.beyondmotion.net | 越权发布 |
| ❌ 复用 `every-newsletter-pipeline/scripts/every-newsletter.mjs` | 强耦合 |
| ❌ 复用 every-to-newsletter 仓库的 `data/articles.json` | 数据污染 |

## GitHub Repositories

- Skill 仓库：`https://github.com/violin86318/every-translate-skill`
- aApp 仓库：TBD（独立仓库，端口 8765，独立数据库）
- 新网站：TBD（独立站点，本地仓库副本，**与 every.beyondmotion.net 无关**）

## 实体与软链

- **实体目录**：`/Users/wanglingwei/.agents/skills/every-translate`（按 AGENTS.md 铁律）
- 其他 Agent skills 目录：只创建软链，不复制实体

## 核心工作流（Skill 模式）

```
🔓 原文完整性校验
    ↓
📚 名词库加载（双写：remio 笔记 + glossary.json）
    ↓
✍️ 翻译（5 步改写法，rewrite-zh.md）
    ↓
🔎 事实核查 hook（吴查查：数据/人名/引语核对）
    ↓
📝 终审 hook（周审稿：评分 + 硬伤修复）
    ↓
📤 输出到 remio 草稿（标 "待审"） + 本地 content/articles/（status: draft）
    ↓
🛑 绝不 push 到 every.beyondmotion.net
```

## 命令（待 Stage 2 改造完成后实装）

```bash
# 1. 健康检查
node ~/.agents/skills/every-translate/scripts/every-translate.mjs preflight

# 2. 发现最新文章
node ~/.agents/skills/every-translate/scripts/every-translate.mjs check --limit 3

# 3. 处理指定 URL（P1 测试样本：Opus 4.8）
node ~/.agents/skills/every-translate/scripts/every-translate.mjs process \
  --url "https://every.to/context-window/opus-4-8-is-smart-enough-to-get-in-your-way" \
  --processor deepseek --model deepseek-v4-pro

# 4. 处理最新 N 篇
node ~/.agents/skills/every-translate/scripts/every-translate.mjs process \
  --limit 1 --processor deepseek
```

## Hook 架构

```
[fetch] → [glossary.load]
       → [translate.rewrite-zh]
       → [factcheck.吴查查]   ← 调 dedao-brain aApp 的事实核查服务
       → [review.周审稿]     ← 调 dedao-brain aApp 的终审服务
       → [output.remio-draft]   ← 草稿笔记
       → [output.local]         ← 本地副本
```

## 名词库（双写）

| 位置 | 角色 | 写入方向 |
|---|---|---|
| remio 笔记合集「📚 Every 翻译名词库」 | **权威源**，手工编辑 | ✅ |
| `glossary/glossary.json`（仓库内） | **镜像**，脚本读取 | ← 来自 remio 同步 |

**schema**：

```json
{
  "version": "2026-06-04",
  "updatedAt": "2026-06-04T09:30:00Z",
  "terms": [
    { "en": "AI Agent", "zh": "智能体", "context": "通用", "note": "" },
    { "en": "Singularity", "zh": "技术奇点", "context": "AI/未来学", "note": "不要简译为'奇点'" }
  ]
}
```

## 迁移自 every-newsletter-pipeline

| 维度 | 旧 skill | 新 skill |
|---|---|---|
| 输出 | content/articles/ + publish | content/articles/ (status: draft) + remio 待审笔记 |
| 事实核查 | 无 | **吴查查 hook** |
| 终审 | 无 | **周审稿 hook** |
| 名词库 | 无 | **glossary.json + remio 双写** |
| git push | ✅ 推 every.beyondmotion.net | ❌ 只本地 commit |
| aApp 集成 | ❌ | ✅ 多轮精修 |
| 实体位置 | `~/.agents/skills/every-newsletter-pipeline` | `~/.agents/skills/every-translate`（独立） |

## 每日自动化

skill 模式不接 scheduler（用户明确："skill 处理需要快速出结果的"= 手动命令触发）。aApp 跑通后再接 scheduler。

## 实施进度

- [x] **P1 Stage 1** — 建骨架、复制核心、看 CLI 代码
- [ ] **P1 Stage 2** — 删 publish、加吴查查/周审稿 hook
- [ ] **P1 Stage 3** — 加 glossary.json + remio 同步脚本
- [ ] **P1 Stage 4** — 用 Opus 4.8 跑通，对比老 skill 质量
- [ ] **P1 Stage 5** — git init + commit + push 到 GitHub
- [ ] **P2** — 等待 aApp 设计
