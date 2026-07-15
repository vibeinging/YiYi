# 数据库 ORM 与迁移指南

> "Bad programmers worry about the code. Good programmers worry about data structures and their relationships."
> 这份文档告诉你为什么我们选择 SQLAlchemy ORM + Alembic，以及如何正确使用。

---

## 一、为什么用 ORM？为什么是 SQLAlchemy？

### 核心原因：数据结构优先

**问题场景**：
```python
# 糟糕的方式：到处写 SQL 字符串
cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
row = cursor.fetchone()
user_name = row[3]  # 这是什么字段？谁知道！
```

**ORM 的方式**：
```python
# 清晰的数据结构
user = session.query(User).filter_by(id=user_id).first()
user_name = user.name  # 明确、类型安全、IDE 可提示
```

### 实用主义价值

1. **数据结构即文档**
   - 看 `models.py` 就知道数据库结构
   - 字段类型、关系、约束一目了然
   - 不需要额外的数据库文档

2. **跨数据库支持**
   - 开发用 SQLite，生产用 PostgreSQL
   - 不需要重写 SQL
   - 避免方言差异的陷阱

3. **类型安全**
   - Python 类型提示
   - IDE 自动补全
   - 编译期发现错误，不是运行时

4. **防止 SQL 注入**
   - 参数化查询自动处理
   - 不需要手动转义

### 为什么是 SQLAlchemy？

- **成熟稳定**：18年历史，经过数百万生产环境验证
- **灵活性**：既可以用高级 ORM，也可以写原始 SQL
- **生态完整**：Alembic、FastAPI、Flask 无缝集成
- **不过度抽象**：不像某些 ORM 试图"隐藏"数据库，SQLAlchemy 让你清楚知道底层发生了什么

---

## 二、为什么用 Alembic？

### 核心问题：数据库变更的版本控制

**没有迁移工具的灾难**：
```text
开发A：改了表结构，忘了告诉别人
开发B：拉代码后运行，程序崩溃："column not found"
开发C：手动改了数据库，但改错了字段类型
生产环境：不敢升级，怕表结构不一致
```

### Alembic 解决的问题

1. **数据库变更即代码**
   - 每次修改都生成迁移文件
   - 迁移文件进入版本控制
   - 团队同步，历史可追溯

2. **向后兼容铁律**
   - 每个迁移都可回滚
   - `upgrade()` 和 `downgrade()` 必须成对
   - 就像 Git 的 commit 和 revert

3. **生产环境安全**
   - 渐进式更新：先测试，再上线
   - 原子操作：要么成功，要么回滚
   - 数据迁移 + 表结构修改一起处理

---

## 三、如何使用：实战指南

### 3.1 基础工作流

我们提供了 `backend/scripts/alembic_manager.py` 工具，它比原生 Alembic 更智能。

#### 初始化（只需一次）
```bash
python scripts/alembic_manager.py init
```

#### 日常开发循环

**1. 修改模型（例如添加新字段）**
```python
# backend/models/knowledge_base.py
class KnowledgeBase(Base):
    __tablename__ = "knowledge_bases"

    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    # 新增字段
    knowledge_type = Column(String(64), nullable=False, comment="知识类型")
```

**2. 生成迁移文件**
```bash
python scripts/alembic_manager.py migrate "添加知识类型字段"
```

**自动检测和修复**：
- 工具会自动检测 NOT NULL 列问题
- 交互式询问默认值
- 自动重写为三步法（见下文）

**3. 应用迁移**
```bash
python scripts/alembic_manager.py upgrade
```

**4. 如果出问题，回滚**
```bash
python scripts/alembic_manager.py downgrade 1  # 回退 1 步
```

### 3.2 查看状态

```bash
# 查看当前数据库版本
python scripts/alembic_manager.py current

# 查看迁移历史
python scripts/alembic_manager.py history
```

---

## 四、核心原理：三步法迁移

### 问题场景

你给已有数据的表添加 NOT NULL 列：

```python
# ❌ 这会失败！
op.add_column('knowledge_bases',
    sa.Column('knowledge_type', sa.String(64), nullable=False)
)
# 原因：现有行的 knowledge_type 是 NULL，违反 NOT NULL 约束
```

### 三步法解决方案

`alembic_manager.py` 自动将上述操作重写为：

```python
# 步骤 1: 添加可空列
op.add_column('knowledge_bases',
    sa.Column('knowledge_type', sa.String(64), nullable=True)
)

# 步骤 2: 为现有数据填充默认值
op.execute(
    "UPDATE knowledge_bases SET knowledge_type = 'general' WHERE knowledge_type IS NULL"
)

# 步骤 3: 添加 NOT NULL 约束
op.alter_column(
    'knowledge_bases',
    'knowledge_type',
    nullable=False,
    server_default='general'
)
```

**原理**：
1. 先让新列允许 NULL，避免插入失败
2. 手动填充历史数据
3. 最后才加约束

**类比**：就像给高速公路添加收费站，你不能突然关闭道路，而是：
1. 先在旁边建收费站（可空列）
2. 引导车辆过收费站（填充数据）
3. 最后关闭老路（加约束）

---

## 五、常见陷阱与最佳实践

### 陷阱 1：忘记处理现有数据

```python
# ❌ 错误
op.add_column('users', sa.Column('status', sa.String(20), nullable=False))

# ✅ 正确：使用 server_default 或三步法
op.add_column('users', sa.Column('status', sa.String(20),
    nullable=False, server_default='active'))
```

### 陷阱 2：删除列前没考虑代码兼容性

**场景**：你删了一个列，部署时旧代码还在读这个字段。

**安全做法**：
1. 第一次部署：代码停止写入该字段，但仍读取
2. 第二次部署：代码停止读取
3. 第三次部署：数据库删除字段

**核心原则**："Never break userspace" —— 渐进式迁移，不破坏运行中的代码。

### 陷阱 3：迁移文件出现 `sa.NullType()`

**原因**：Alembic 自动检测失败，生成了空类型。

**解决**：`alembic_manager.py` 自动清理这个问题。

手动修复：
```python
# ❌ Alembic 生成的
op.alter_column('table', 'column', existing_type=sa.NullType())

# ✅ 删除这行或修正类型
op.alter_column('table', 'column', existing_type=sa.String(64))
```

### 陷阱 4：直接修改生产数据库

**永远不要这样做**：
```bash
# ❌ 禁止
mysql -u root -p production_db
> ALTER TABLE users ADD COLUMN status VARCHAR(20);
```

**必须通过迁移**：
```bash
# ✅ 正确流程
# 1. 开发环境：生成迁移
python scripts/alembic_manager.py migrate "添加用户状态"

# 2. 测试环境：验证迁移
python scripts/alembic_manager.py upgrade

# 3. 提交代码（迁移文件进入版本控制）
git add migrations/versions/xxx.py
git commit -m "添加用户状态字段"

# 4. 生产环境：应用迁移
python scripts/alembic_manager.py upgrade
```

---

## 六、最佳实践总结

### 原则 1：数据结构优先

```python
# ✅ 好：模型定义清晰
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String(255), unique=True, nullable=False, index=True)

# ❌ 差：到处写 SQL 字符串
cursor.execute("CREATE TABLE users (id INT, email VARCHAR(255))")
```

### 原则 2：简洁执念

- 迁移文件只做一件事
- 避免在迁移中写复杂逻辑
- 如果超过 50 行，考虑拆分

### 原则 3：向后兼容

- 添加列：使用 `server_default` 或三步法
- 删除列：渐进式下线（先停写，再停读，最后删表）
- 改类型：创建新列 → 数据迁移 → 删旧列

### 原则 4：测试先行

```bash
# 开发环境测试
python scripts/alembic_manager.py upgrade
# 运行单元测试
pytest tests/
# 回滚测试
python scripts/alembic_manager.py downgrade 1
python scripts/alembic_manager.py upgrade
```

### 原则 5：迁移文件进版本控制

```bash
# ✅ 必须提交
git add migrations/versions/*.py
git commit -m "数据库迁移：添加XX功能"

# ❌ 禁止
# - 不提交迁移文件
# - 手动修改已提交的迁移文件
# - 删除历史迁移记录
```

---

## 七、快速参考

### 常用命令

```bash
# 创建迁移
python scripts/alembic_manager.py migrate "描述信息"

# 应用所有未执行的迁移
python scripts/alembic_manager.py upgrade

# 回滚 1 步
python scripts/alembic_manager.py downgrade 1

# 查看当前版本
python scripts/alembic_manager.py current

# 查看历史
python scripts/alembic_manager.py history
```

### SQLAlchemy 查询速查

```python
# 查询单条
user = session.query(User).filter_by(id=1).first()

# 查询多条
users = session.query(User).filter(User.age > 18).all()

# 添加
new_user = User(name="Alice", email="alice@example.com")
session.add(new_user)
session.commit()

# 更新
user.name = "Bob"
session.commit()

# 删除
session.delete(user)
session.commit()

# 关联查询（假设 User 有 posts 关系）
user_with_posts = session.query(User).options(
    joinedload(User.posts)
).filter_by(id=1).first()
```

---

## 八、故障排查

### 问题 1：迁移失败 "Target database is not up to date"

**原因**：数据库版本与代码不一致。

**解决**：
```bash
# 查看当前版本
python scripts/alembic_manager.py current
# 查看缺失的迁移
python scripts/alembic_manager.py history
# 应用迁移
python scripts/alembic_manager.py upgrade
```

### 问题 2："Can't locate revision xxx"

**原因**：迁移文件丢失或版本冲突。

**解决**：
1. 检查 `migrations/versions/` 目录
2. 从版本控制恢复丢失的文件
3. 如果是本地开发环境，可以删除数据库重建：
   ```bash
   rm backend/data.db
   python scripts/alembic_manager.py upgrade
   ```

### 问题 3：数据库锁定（SQLite）

**原因**：SQLite 不支持并发写入。

**解决**：
- 开发环境：关闭其他连接
- 生产环境：使用 PostgreSQL/MySQL

---

## 总结

**核心理念**：
- ORM 让数据结构清晰（Good programmers worry about data structures）
- Alembic 让变更可控（Never break userspace）
- 工具自动化避免人为错误（实用主义）

**一句话**：把数据库操作变成类型安全的 Python 代码，把表结构变更变成可回滚的版本控制。

**开始使用**：
1. 定义模型：`backend/models/`
2. 生成迁移：`python scripts/alembic_manager.py migrate "xxx"`
3. 应用迁移：`python scripts/alembic_manager.py upgrade`
4. 提交代码：`git add migrations/versions/*.py && git commit`

就是这么简单。
