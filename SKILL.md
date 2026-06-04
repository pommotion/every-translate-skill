---
name: every-translate
description: Translate and rewrite English articles into publication-ready Chinese. Use for fast-track translations (skill mode) that need quick output to a review queue, or pair with the every-translate aApp for multi-round editorial refinement. Produces glossed, fact-checked, and review-pending drafts in a separate workspace.
---

# Translate Pipeline (every-translate)

通用翻译 skill，从 `every-newsletter-pipeline` 的翻译模块抽离而来，**独立于原项目**。处理任意英文文章。

**两线交付**：
- **Skill 模式**（本 skill）：单次快出 → 走事实核查 → 走终审 → 输出到 remio 草稿 + 本地副本
- **aApp 模式**（every-translate aApp）：多轮编辑流水线 + UI 反向打磨

## ⚠️ 独立原则

| 禁止 | 后果 |
|---|---|
| ❌ 修改 every-to-newsletter 仓库 | 数据污染 |
| ❌ push 到 every.beyondmotion.net | 越权发布 |
| ❌ 复用 `every-newsletter-pipeline/scripts/every-newsletter.mjs` | 强耦合 |

## GitHub

- Skill 仓库：`https://github.com/pommotion/every-translate-skill`

## 实体与软链

- **实体目录**：`/Users/wanglingwei/.agents/skills/every-translate`（按 AGENTS.md 铁律）
- 其他 Agent skills 目录：只创建软链，不复制实体

## 核心工作流（Skill 模式）

```
📚 名词库加载（双写：remio 笔记 + glossary.json）
    ↓
✍️ 翻译（改写式翻译，rewrite-zh.md）
    ↓
🔎 事实核查 hook（吴查查：数据/人名/引语核对）
    ↓
📝 终审 hook（周审稿：评分 + 硬伤修复）
    ↓
📤 输出到 remio 草稿 + 本地 content/output/
```

## 命令

```bash
# 1. 处理指定 URL
node ~/.agents/skills/every-translate/scripts/every-translate.mjs process \
  --url "https://example.com/article" \
  --processor deepseek --model deepseek-v4-pro

# 2. 处理最新 N 篇（every.to newsletter）
node ~/.agents/skills/every-translate/scripts/every-translate.mjs process \
  --limit 1 --processor deepseek

# 3. 健康检查
node ~/.agents/skills/every-translate/scripts/every-translate.mjs preflight
```

## Hook 架构

```
[fetch] → [glossary.load]
       → [translate.rewrite-zh]
       → [factcheck.吴查查]
       → [review.周审稿]
       → [output.local]
```

## 名词库（双写）

| 位置 | 角色 | 写入方向 |
|---|---|---|
| remio 笔记合集「📚 Every 翻译名词库」 | **权威源**，手工编辑 | ✅ |
| `glossary/glossary.json`（仓库内） | **镜像**，脚本读取 | ← 来自 remio 同步 |

**同步流程**：翻译完成后 → `extractTermsHook` 提取术语 → `saveGlossary` 写 glossary.json → agent 调 `update_note` 同步到 remio 合集

**remio 合集 ID**：`mpzgcn4dclkdayo43gm`

## 迁移自 every-newsletter-pipeline

| 维度 | 旧 skill | 新 skill |
|---|---|---|
| 输入 | every.to only | **任意英文文章** |
| 输出 | content/articles/ + publish | content/output/ + remio 待审笔记 |
| 事实核查 | 无 | **吴查查 hook** |
| 终审 | 无 | **周审稿 hook** |
| 名词库 | 无 | **glossary.json + remio 双写** |
| git push | ✅ 推 every.beyondmotion.net | ❌ 只本地 commit |
| aApp 集成 | ❌ | ✅ 多轮精修 |
| 实体位置 | `~/.agents/skills/every-newsletter-pipeline` | `~/.agents/skills/every-translate`（独立） |

## 实施进度

- [x] **P1** — 翻译流水线 skill（CLI + 3 步 hook + 端到端跑通）
- [x] **P2-1** — 名词库自动收录（extractTermsHook + glossary 0→15 术语）
- [x] **P2-2** — remio 名词库合集创建
- [x] **P3** — aApp 骨架（10 endpoint，isValid=true）
- [ ] **P4** — scheduler + 新网站
