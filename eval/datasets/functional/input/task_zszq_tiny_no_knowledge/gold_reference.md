# task_zszq_daly_pl 多轮问题 Gold 参考

> 2026-06-11。10 轮问题（去重后）的标准答案、查询口径与 SQL，全部从 `context/csv/` 实算得出。
> 已经独立审计复核（DECIMAL 精确算术重算，去重前 14/14 PASS，去重仅删重复未改任何 gold）。
> 判分配置见 `task.json` 的 `per_turn.expected`；字段字典见 `schema_descriptions.json`。

> 2026-06-11 去重：原 14 题删除三个重复（旧T4=旧T3、旧T12=旧T11、旧T14=旧T1）；资产配置部题应需求改为固定收益部后与固收三类题重复、合并删除，现为 10 题。
## T1 · 公司五指标

**问题**：截止2024年12月31日，浙商证券股份有限公司总盈亏、业务规模、资金成本、净盈亏、增值税后收入各是多少

**答案**：

| 总盈亏 | 业务规模 | 资金成本 | 净盈亏 | 增值税后收入 |
|--------|---------|---------|--------|------------|
| 328,852.67 | 7,030,304.74 | 72,683.61 | 256,169.06 | 319,779.75 |

**口径与陷阱**：
- 数据源：每日盈亏表 `ads_zszq_daly_pl_df`，公司汇总节点 `IVSM_NODE_NUM='-1'`，取 20241231 快照（TOT_PL 本身是累计口径，"截止"=取末日）。
- ⚠ **主陷阱**：`CPTL_COST`（资金成本）和 `NET_PL`（净盈亏）是**节点级常量**——同节点同日的 25 行上重复出现同一个值，对它们 SUM 会得到 25 倍的垃圾值（1,817,090.31）。只有 TOT_PL / MVAL_SCAL / AFT_VAT_TOT_PL 是按业务类型分布、需要求和的。
- 同一业务类型出现两行（如"债券"229,321.92 + 0）是**数值不同的组成分量**，全行求和才正确。
- 自洽校验：总盈亏 − 资金成本 = 净盈亏，误差仅 5.4e-6 ✓（按类型去重求和则等式破裂）。

```sql
SELECT SUM(TOT_PL)         AS 总盈亏,
       SUM(MVAL_SCAL)      AS 业务规模,
       MAX(CPTL_COST)      AS 资金成本,   -- 节点常量，取一行即可
       MAX(NET_PL)         AS 净盈亏,     -- 同上
       SUM(AFT_VAT_TOT_PL) AS 增值税后收入
FROM ads_zszq_daly_pl_df
WHERE BUSI_DATE = '20241231' AND IVSM_NODE_NUM = '-1';
```

---

## T2 · 基金总持仓市值

**问题**：截止2024年12月31日，基金总持仓市值是多少

> 题面原为"总持仓规模"，四跑出现四种口径解读（FUND_AMT/OCCP_SCAL/无日期过滤/MVAL_SCAL），2026-06-11 消歧为"总持仓市值"锚定 FUND_AMT。

**答案**：**3,703,592,846.64**（SUM(FUND_AMT) @ 20241231）

**口径与陷阱**：
- 口径内证：`SUM(HLDP_SHR × UNIT_NAV)`（份额×净值）与 `SUM(FUND_AMT)` **逐分不差**——FUND_AMT 就是持仓市值。
- ⚠ 干扰口径：`OCCP_SCAL`（占资规模）求和 = 3,069,509,316.27，是资金占用口径，不是持仓规模。

```sql
SELECT SUM(FUND_AMT) AS 基金总持仓规模
FROM ads_zszq_fund_hold_df
WHERE BUSI_DATE = '20241231';
```

---

## T4 · 总盈亏最多的基金

**问题**：截止2024年12月31日，总盈亏最多基金是哪只，赚了多少

**答案**：**基金109，赚 96,935,334.84**

**口径与陷阱**：
- ⚠ 必须按基金名称 `SCR_NAME` **聚合**——一只基金分布在多个组合、多行（基金101 有 8 行）。
- ⚠ `ACC_NAME` 是组合名称，不是基金名称（实体注册规则已声明）。

```sql
SELECT SCR_NAME, SUM(TOT_PL) AS 总盈亏
FROM ads_zszq_fund_hold_df
WHERE BUSI_DATE = '20241231'
GROUP BY SCR_NAME ORDER BY 总盈亏 DESC LIMIT 1;
```

---

## T7 · 互换便利组合的持有标的

**问题**：截止2024年12月31日，互换便利的可供户投资组合持有标的有哪些

**答案**：**股票107（股票）、基金103（基金）**，无债券持仓

**口径与陷阱**：
- 互换便利业务归属**便利投资部**；账户维表中该部门唯一账户 = 组合116（`IVSM_ACC_NUM='449.COMBI'`）。
- ⚠ **必须用编号 join**（`ACC_NUM ↔ IVSM_ACC_NUM`）：脱敏后名称大面积碰撞——dim 里"组合116"对应 2 个不同账户，bond 表有 157 行 `ACC_NAME='组合116'` 实属固定收益部组合108。名称 join 会 fanout 出错值。
- 📌 **2026-06-12 口径裁决（勿再翻改）**：曾有一次按"名称 join"口径把债券104/107/109 计入便利投资部（bond 表 `ACC_NAME='组合116'` 行），经 daly_pl 公司总账仲裁后回退——@20241231 债券市值>0 的部门为 投研/固收/基金管理/公司委托/做市，**便利投资部总账只有基金+股票两行，无债券业务行**。本脱敏数据集名称列与编号列被独立打乱（fund 表 449.COMBI 行自带名称是"组合106"；bond 表 kzzkjhzzh-SLY 自带名称"组合116"但维表同编号行叫"组合108"），两套键均无外部真相，gold 统一采用**编号 join 口径**（与 T2/T4/T9/T10 一致、与 daly_pl 总账自洽）。

```sql
SELECT '股票' AS 类别, SCR_ABBR AS 标的
FROM ads_zszq_stk_hold_dd
WHERE BUSI_DATE='20241231' AND DEPT_NAME='便利投资部' AND HLDP_VOL > 0
UNION ALL
SELECT '基金', f.SCR_NAME
FROM ads_zszq_fund_hold_df f
JOIN dim_comm_ivsm_acc_df d ON f.ACC_NUM = d.IVSM_ACC_NUM
WHERE f.BUSI_DATE='20241231' AND d.DEPT_NAME='便利投资部';
```

---

## T9 · 投资研究部最赚基金

**问题**：截止2024年12月31日，投资研究部持仓总盈亏最多基金是哪只，赚了多少

**答案**：**基金102，赚 375.50**

| 基金 | 总盈亏 |
|------|--------|
| 基金102 | **375.50** |
| 基金101 | −286,829.69 |

**口径与陷阱**：
- 基金表没有部门列，必须经账户维表 join 取部门（编号键）。
- ⚠ 该部门只有两只基金，另一只是负的——基金102 的 375.50 虽小但就是最大值。
- ⚠ 行级取 max 会错：投研的基金101 有一行 +358,308.60（>375.50），不先 GROUP BY 会答成基金101。

```sql
SELECT f.SCR_NAME, SUM(f.TOT_PL) AS 总盈亏
FROM ads_zszq_fund_hold_df f
JOIN dim_comm_ivsm_acc_df d ON f.ACC_NUM = d.IVSM_ACC_NUM
WHERE f.BUSI_DATE='20241231' AND d.DEPT_NAME='投资研究部'
GROUP BY f.SCR_NAME ORDER BY 总盈亏 DESC;
```

---
