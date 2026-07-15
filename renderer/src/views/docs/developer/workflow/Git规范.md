# Git 工作流规范

> 适用于 10 人团队 | Gitee 托管 | 按需发布 | 简洁高效

## 目录

- [🚀 5 分钟快速上手](#-5分钟快速上手)
- [核心原则](#核心原则)
- [分支策略](#分支策略)
- [Commit 规范](#commit规范)
- [PR 流程](#pr流程)
- [常见场景](#常见场景)
- [AI 辅助工具](#ai辅助工具)
- [FAQ](#faq)

---

## 🚀 5 分钟快速上手

### 新团队成员首次使用

```bash
# 1. 克隆仓库
git clone <项目地址>
cd <项目目录>

# 2. 创建功能分支
git checkout main
git pull origin main
git checkout -b feature/你的功能名称

# 3. 开发和提交
git add .
# 使用AI生成commit message
git commit -m "feat(module): 添加新功能"

# 4. 推送并创建PR
git push origin feature/你的功能名称
```

### 必知必会（3 分钟掌握）

| 操作         | 命令                       | 说明             |
| ------------ | -------------------------- | ---------------- |
| **查看状态** | `git status`               | 了解当前改动状态 |
| **切换分支** | `git checkout main`        | 切换到主分支     |
| **同步代码** | `git pull origin main`     | 获取最新代码     |
| **提交代码** | `git add .` + `git commit` | 暂存并提交改动   |
| **推送代码** | `git push origin <分支名>` | 推送到远程       |

### 分支命名规则

```bash
✅ feature/user-authentication
✅ feature/data-export-xlsx
✅ hotfix/session-timeout

❌ feature/dev              # 太模糊
❌ feature/张三的修改        # 不要用人名
❌ feature/fix-bug          # fix用hotfix
```

### 核心规则（记住 3 条）

1. **不直接 push 到 main**：所有改动必须通过 PR 合并
2. **使用 AI 生成 commit**：让 AI 分析 git diff 生成
3. **及时删除 feature 分支**：合并后立即清理

---

## 核心原则

### 工作流模型：Shared Repository + Feature Branch

```
主仓库（团队共享）
  ├── main (保护分支，始终可部署)
  ├── feature/user-auth (功能分支)
  ├── feature/data-export (功能分支)
  └── hotfix/critical-bug (紧急修复)
```

### 三个关键规则

1. **`main`分支神圣不可侵犯**：只通过 PR 合并，禁止直接 push
2. **所有改动必须 Code Review**：至少 1 人审核通过
3. **Commit 信息必须清晰**：遵循 Conventional Commits 规范

---

## 分支策略

### 分支类型

| 分支类型    | 命名规范           | 生命周期 | 用途                         |
| ----------- | ------------------ | -------- | ---------------------------- |
| `main`      | 固定               | 永久     | 主分支，保护分支，始终可部署 |
| `feature/*` | `feature/功能描述` | 临时     | 新功能开发                   |
| `hotfix/*`  | `hotfix/问题描述`  | 临时     | 生产环境紧急修复             |

### 分支命名示例

**✅ 好的命名**：

```bash
feature/user-authentication
feature/data-export-xlsx
feature/nl2sql-optimization
hotfix/session-timeout
hotfix/database-connection
```

**❌ 不好的命名**：

```bash
feature/dev              # 太模糊
feature/张三的修改        # 不要用人名
feature/fix-bug          # fix应该用hotfix
feature/test123          # 无意义
```

### 分支保护规则（Gitee 配置）

**`main`分支设置**：

1. 管理后台 → 分支管理 → 保护分支
2. 勾选以下选项：
   - ✅ 禁止直接推送
   - ✅ 需要代码评审（至少 1 人）
   - ✅ 需要 CI 检查通过（如已配置）
3. 设置合并策略：Squash 合并（推荐）或普通合并

---

## Commit 规范

### 推荐使用 AI 生成 Commit Message

**尽量使用 AI 工具生成 commit message，AI 生成的格式都很规范。**

#### 使用 AI 生成 Commit 的步骤

1. **暂存改动**：

   ```bash
   git add .
   ```

2. **让 AI 分析并生成**：

   ```text
   请根据 git diff 生成一个符合规范的 commit message，
   说明改动的类型、范围和详细内容。
   ```

3. **复制生成的 message 并提交**：

   ```bash
   git commit -m "feat(auth): 添加JWT认证功能

   为了提升系统安全性，新增JWT认证机制。
   包含登录验证、token刷新和权限控制。

   ```

#### AI 生成的 Commit Message 特点

- **格式统一**：自动遵循 Conventional Commits 规范
- **内容准确**：准确识别改动的类型和影响范围
- **描述清晰**：详细说明改动原因和内容
- **无需学习**：团队成员无需记忆复杂的规范

#### 手动编写时的建议

如果需要手动编写 commit message，建议包含：

- **类型**：feat（新功能）、fix（修复）、docs（文档）等
- **影响范围**：涉及的模块或文件
- **具体改动**：简要说明改动了什么
- **原因说明**：为什么要做这个改动

---

## PR 流程

### 1. 创建功能分支

```bash
# 从main拉取最新代码
git checkout main
git pull origin main

# 创建功能分支
git checkout -b feature/user-profile

# 开发完成后提交
git add .
git commit  # 使用规范的commit message

# 推送到远程
git push origin feature/user-profile
```

### 2. 在 Gitee 创建 Pull Request

1. 进入项目页面，点击"Pull Requests"
2. 点击"创建 Pull Request"
3. 填写 PR 信息：

**PR 标题**：与主要 commit 标题一致

```
feat(auth): 添加用户认证功能
```

**PR 描述模板**：

```markdown
## 改动内容

- 添加了 JWT 认证中间件
- 实现用户登录/登出接口
- 添加权限验证装饰器

## 测试情况

- [x] 单元测试通过
- [x] 本地手动测试
- [x] CI 检查通过

## 相关 Issue

Closes #123

## 注意事项

需要在配置文件中添加 SECRET_KEY
```

### 3. Code Review

**审核者检查清单**：

- [ ] 代码逻辑是否正确
- [ ] 是否有潜在的性能问题
- [ ] 是否有安全隐患
- [ ] 代码风格是否一致
- [ ] 测试是否充分
- [ ] Commit 信息是否清晰

**审核意见类型**：

- **Comment**：询问或讨论
- **Request Changes**：必须修改才能合并
- **Approve**：批准合并

### 4. 合并 PR

**合并策略选择**：

| 策略            | 说明                      | 何时使用                 |
| --------------- | ------------------------- | ------------------------ |
| **Squash 合并** | 将所有 commit 压缩为 1 个 | 推荐：保持 main 历史清晰 |
| 普通合并        | 保留所有 commit           | 功能复杂需要详细历史     |
| Rebase 合并     | 线性历史                  | 经验丰富团队             |

**推荐使用 Squash 合并**：

- 压缩后的 commit 标题从 PR 标题生成
- 自动包含所有 commit 信息在 body
- main 分支历史清晰，每个 commit 对应一个完整功能

### 5. 删除已合并分支

```bash
# 本地删除
git branch -d feature/user-profile

# 远程删除（Gitee可自动删除）
git push origin --delete feature/user-profile
```

---

## 常见场景

### 场景 1：开发新功能

```bash
# 1. 从main创建分支
git checkout main
git pull origin main
git checkout -b feature/data-export

# 2. 开发并提交
# ... 修改代码 ...
git add .
git commit -m "feat(export): 添加Excel导出功能"

# 3. 推送并创建PR
git push origin feature/data-export
# 在Gitee创建PR
```

### 场景 2：同步 main 最新改动

**方式一：Rebase（推荐）**

```bash
git checkout feature/my-feature
git fetch origin
git rebase origin/main

# 如果有冲突，解决后：
git add .
git rebase --continue

# 强制推送（因为rebase改变了历史）
git push origin feature/my-feature --force-with-lease
```

**方式二：Merge**

```bash
git checkout feature/my-feature
git pull origin main

# 解决冲突（如果有）
git add .
git commit -m "merge: 合并main最新改动"
git push origin feature/my-feature
```

### 场景 3：紧急修复生产 Bug

```bash
# 1. 从main创建hotfix分支
git checkout main
git pull origin main
git checkout -b hotfix/session-timeout

# 2. 修复并提交
# ... 修复代码 ...
git add .
git commit -m "fix(session): 修复会话超时问题"

# 3. 推送并创建高优先级PR
git push origin hotfix/session-timeout
# 在PR中标注"紧急修复"，立即通知reviewer

# 4. 合并后立即部署
```

### 场景 4：修改最后一次 commit

**仅修改 commit message**：

```bash
git commit --amend
# 编辑message后保存
git push origin feature/my-feature --force-with-lease
```

**添加遗漏的文件**：

```bash
git add forgotten-file.py
git commit --amend --no-edit
git push origin feature/my-feature --force-with-lease
```

**⚠️ 警告**：只对未 push 或仅自己使用的分支使用`--amend`

### 场景 5：撤销错误的 commit

**撤销最后一次 commit（保留改动）**：

```bash
git reset --soft HEAD~1
# 重新修改后再次commit
```

**撤销最后一次 commit（丢弃改动）**：

```bash
git reset --hard HEAD~1
git push origin feature/my-feature --force-with-lease
```

### 场景 6：暂存当前工作切换分支

```bash
# 保存当前工作
git stash save "正在开发的用户认证功能"

# 切换到其他分支处理问题
git checkout hotfix/urgent-issue
# ... 处理问题 ...

# 回到原分支恢复工作
git checkout feature/user-auth
git stash pop
```

---

## AI 辅助工具

### 手动使用 Claude Code 生成 commit

如果你在使用 Claude Code 编辑器：

1. **暂存改动**：`git add .`
2. **让 Claude 分析**：
   ```
   请根据 git diff 生成一个符合规范的 commit message，
   说明改动的类型、范围和详细内容。
   ```
3. **复制生成的 message 并提交**

### AI 生成 Commit 的优势

- **无需记忆规范**：AI 自动识别类型和格式
- **内容准确**：根据代码改动自动生成准确的描述
- **效率提升**：几秒钟生成高质量的 commit message
- **格式统一**：团队成员生成的 message 格式一致

---

## FAQ

### Q1: 什么时候创建 PR？

**推荐**：功能完成并自测通过后立即创建 PR。

- 小功能：开发完就提 PR
- 大功能：可以分阶段提多个 PR（每个 PR 是独立可工作的子功能）

### Q2: PR 应该多大？

**原则**：能拆就拆，但要保持完整性。

**✅ 好的 PR 大小**：

- 200-400 行代码改动
- 聚焦单一功能
- 不超过 30 分钟审核时间

**❌ 避免的 PR**：

- 超过 1000 行（reviewer 无法仔细审核）
- 包含多个不相关功能
- 改动过小（如只改一个 typo）

### Q3: 如何处理长期 feature 分支？

**策略**：定期从 main rebase

```bash
# 每2-3天执行一次
git checkout feature/long-term
git fetch origin
git rebase origin/main
```

**更好的方式**：拆分大功能为多个小 PR。

### Q4: commit 提交错了怎么办？

**场景 1：还没 push**

```bash
# 修改最后一次commit
git commit --amend

# 撤销最后几次commit
git reset --soft HEAD~3
# 重新提交
```

**场景 2：已经 push 到 feature 分支**

```bash
# 修改后强制推送
git commit --amend
git push origin feature/my-feature --force-with-lease
```

**场景 3：已经合并到 main**

```
不要修改！创建新commit修复问题。
```

### Q5: main 分支有冲突怎么办？

**在本地解决后再推送**：

```bash
git checkout feature/my-feature
git fetch origin
git rebase origin/main

# 解决冲突
# ... 手动编辑冲突文件 ...
git add .
git rebase --continue

# 推送
git push origin feature/my-feature --force-with-lease
```

**在 Gitee 上**：

- 点击 PR 页面的"解决冲突"按钮
- 在线编辑解决冲突
- 提交冲突解决

### Q6: 如何回滚 main 上的错误合并？

**方式一：Revert（推荐）**

```bash
git checkout main
git pull origin main
git revert <错误的commit-hash>
git push origin main
```

**方式二：联系管理员临时解除保护后 reset**

```
仅在紧急情况使用，需要团队同步。
```

### Q7: 为什么不用 Fork 模型？

Fork 模型适合开源项目（外部贡献者）。

**10 人内部团队使用 Shared Repository 的优势**：

- ✅ 简单：只有 1 个仓库
- ✅ 同步方便：`git pull`即可
- ✅ 权限集中管理
- ✅ 学习曲线平缓

---

## 最佳实践

### 1. Commit 粒度

**✅ 好的 commit**：

- 一个 commit 完成一个完整的小改动
- 可以独立回滚而不影响其他功能
- commit message 清晰说明改动原因

**❌ 避免的 commit**：

```bash
git commit -m "更新"              # 太模糊
git commit -m "WIP"                # 不应该push到远程
git commit -m "修复bug"            # 什么bug？
```

### 2. 提交频率

- **本地提交**：频繁 commit（每完成一个小步骤）
- **推送到远程**：整理后再 push（可以用`git rebase -i`整理）
- **不要**：一天结束时一次性提交所有改动

### 3. 分支生命周期

- **短生命周期**：feature 分支尽快合并（不超过 3 天）
- **及时删除**：合并后立即删除分支
- **长期分支**：只有 main 是长期分支

### 4. Code Review 文化

**作为代码作者**：

- 提 PR 前自己先 review 一遍
- 主动说明复杂逻辑的设计思路
- 积极响应 reviewer 的问题

**作为 Reviewer**：

- 24 小时内给出反馈
- 先看整体设计，再看细节
- 提建设性意见，不要攻击代码作者
- 学习他人代码的优点

### 5. 分支命名规范

**使用英文**：

```bash
✅ feature/user-authentication
❌ feature/用户认证
```

**用短横线分隔**：

```bash
✅ feature/data-export-xlsx
❌ feature/data_export_xlsx
❌ feature/dataExportXlsx
```

### 6. 保持 main 稳定

- 合并前确保 CI 通过
- 合并前本地充分测试
- 紧急修复也要走 PR 流程（快速审核）

---

## 工具配置

### Gitee Webhooks（可选）

配置钉钉/飞书通知：

1. Gitee 项目 → 管理 → Webhooks
2. 添加钉钉机器人 URL
3. 勾选触发事件：Push、Pull Request、合并请求

### Git 别名（提升效率）

在`~/.gitconfig`添加：

```ini
[alias]
    # 查看状态
    st = status

    # 美化的log
    lg = log --graph --oneline --decorate --all

    # 快速切换分支
    co = checkout
    cob = checkout -b

    # 快速提交
    cm = commit -m
    ca = commit --amend

    # 同步main
    sync = !git fetch origin && git rebase origin/main

    # 查看最近的commit
    last = log -1 HEAD
```

使用：

```bash
git st              # 替代 git status
git lg              # 美化的log
git cob feature/x   # 创建并切换分支
```

---

## 参考资料

- [Conventional Commits 规范](https://www.conventionalcommits.org/)
- [GitHub Flow 工作流](https://docs.github.com/en/get-started/quickstart/github-flow)
- [Git Book 中文版](https://git-scm.com/book/zh/v2)

---

## 文档维护

- **当前版本**：v1.0
- **最后更新**：2025-11-05
- **维护者**：开发团队
- **反馈渠道**：提 Issue 或 PR 改进此文档

---

**记住**：规范是为了提升效率，不是束缚。遇到特殊情况灵活处理，但要在团队内达成共识。
