# every-translate

独立翻译 skill，从 [`every-newsletter-pipeline`](../every-newsletter-pipeline) 抽离而来。

## 🎯 一句话定位

> 翻译 Every.to 文章到中文，**带事实核查和终审**，输出到独立工作区，**绝不碰 every.beyondmotion.net**。

## 🆚 与 every-newsletter-pipeline 的区别

| 维度 | every-newsletter-pipeline | every-translate |
|---|---|---|
| 目标 | 维护 every.beyondmotion.net 网站 | 独立翻译工作流 |
| 输出 | 直接 publish 到网站 | remio 草稿 + 本地副本 |
| 审核 | 无 | **吴查查（事实）+ 周审稿（终审）** |
| 名词库 | 无 | **glossary.json + remio 双写** |
| git push | 是 | 否 |
| 触发方式 | scheduler 每日自动 | 手动命令 / aApp UI |

## 🚀 快速开始

```bash
# 健康检查
node ~/.agents/skills/every-translate/scripts/every-translate.mjs preflight

# 翻译指定文章
node ~/.agents/skills/every-translate/scripts/every-translate.mjs process \
  --url "https://every.to/context-window/opus-4-8-is-smart-enough-to-get-in-your-way" \
  --processor deepseek --model deepseek-v4-pro
```

## 📚 文档

- [SKILL.md](./SKILL.md) — 完整使用说明
- [references/prompts/rewrite-zh.md](./references/prompts/rewrite-zh.md) — 翻译方法论
- [glossary/](./glossary/) — 专有名词库
- [changelog/](./changelog/) — 变更日志

## 🔗 关联项目

- 上游：https://every.to/newsletter
- 老 skill（强耦合于 every.beyondmotion.net）：`every-newsletter-pipeline`
- dedao-brain aApp（提供吴查查/周审稿服务）：独立 aApp
- 新网站（待建）：独立站点，**与 every.beyondmotion.net 无关**

## 📋 当前状态

🚧 **P1 Stage 1 完工** — 骨架建好，准备进入 Stage 2（删 publish + 加审核 hook）
