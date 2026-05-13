# Project Chroma — 移交文档包

这个目录是给 Claude Code 的项目执行包。**按顺序读**：

1. **HANDOFF.md** — 项目宪法。定位、范围、原则、工程纪律。
2. **ARCHITECTURE.md** — 四层架构。模块边界、技术栈选型、关键技术决策（坐标精度、WebGL2 实例化、tile 系统）。
3. **DESIGN_SYSTEM.md** — 视觉语言。配色 token、字体、间距、动效、交互规范。
4. **TWO_DAY_SPRINT.md** — 两天 demo 冲刺的逐 task 拆解。
5. **AGENT_PLAYBOOK.md** — Sub-agent 编排、git worktree、PR review、冲突处理。
6. **BENCHMARKS.md** — 性能基线、测量方法、报告格式。

## 给 Claude Code 的第一条指令

读完六份文档后，**用中文**回用户一份 confirmation checklist（≤ 5 条）：

- 你理解的项目定位
- 你接受的硬约束（性能 gate、技术栈、范围）
- 两天范围内会做 / 不会做的清单
- 你打算如何编排 agent team
- 你打算先动手的第一个 task（一般是 T0.1）

**等用户回 "go" 再开始执行。**

不要跳过这一步。这是项目唯一一次"对齐"的机会。

---

## 文档之外的隐含约定

- 用中文跟用户沟通
- 代码注释和 commit message 用英文
- 不要"为了节省时间"跳过测试
- 不要"为了完整性"做超出范围的功能
- 性能 benchmark 是 demo 发布的硬 gate
- 任何超出 §HANDOFF.4 技术栈的库引入需要用户批准

---

## 用户的现实预期校准

用户最初提出"两天完成 Phase 2"，本文档把范围实际定为"两天完成可演示的 Phase 1 核心 + Phase 2 关键 track"。

完整的 Phase 2 需要约两周。这是协调过的预期，**不要再回到"两天做完整 Phase 2"的承诺**，那是不可能的。

如果用户在执行中再次要求扩大范围：lead 必须明确拒绝，引用 HANDOFF §6 和本文。

---

## 仓库初始位置

文档建议放在最终仓库的 `docs/` 下。Claude Code 在 T0.1 仓库初始化时，把这六份文件 copy 进 `chroma/docs/`，作为唯一事实来源。
