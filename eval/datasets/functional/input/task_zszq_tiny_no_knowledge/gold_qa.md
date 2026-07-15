# 问题 / SQL / 答案

## T1

**问题**：截止2024年12月31日，浙商证券股份有限公司总盈亏、业务规模、资金成本、净盈亏、增值税后收入各是多少

```sql
## T1

**问题**：截止2024年12月31日，浙商证券股份有限公司总盈亏、业务规模、资金成本、净盈亏、增值税后收入各是多少

```sql
SELECT SUM(TOT_PL)         AS 总盈亏,
       SUM(MVAL_SCAL)      AS 业务规模,
       MAX(CPTL_COST)      AS 资金成本,
       MAX(NET_PL)         AS 净盈亏,
       SUM(AFT_VAT_TOT_PL) AS 增值税后收入
FROM ads_zszq_daly_pl_df
WHERE BUSI_DATE = '20241231' AND IVSM_NODE_NUM = '-1';
```

**答案**：总盈亏 328,852.67；业务规模 7,030,304.74；资金成本 72,683.61；净盈亏 256,169.06；增值税后收入 319,779.75

## T2

**问题**：截止2024年12月31日，基金总持仓市值是多少

```sql
SELECT SUM(FUND_AMT) AS 基金总持仓市值
FROM ads_zszq_fund_hold_df
WHERE BUSI_DATE = '20241231';
```

**答案**：3,703,592,846.64

## T4

**问题**：截止2024年12月31日，总盈亏最多基金是哪只，赚了多少

```sql
SELECT SCR_NAME, SUM(TOT_PL) AS 总盈亏
FROM ads_zszq_fund_hold_df
WHERE BUSI_DATE = '20241231'
GROUP BY SCR_NAME ORDER BY 总盈亏 DESC LIMIT 1;
```

**答案**：基金109，96,935,334.84

## T7

**问题**：截止2024年12月31日，互换便利的可供户投资组合持有标的有哪些

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

**答案**：股票107（股票）、基金103（基金），无债券持仓

## T9

**问题**：截止2024年12月31日，投资研究部持仓总盈亏最多基金是哪只，赚了多少

```sql
SELECT f.SCR_NAME, SUM(f.TOT_PL) AS 总盈亏
FROM ads_zszq_fund_hold_df f
JOIN dim_comm_ivsm_acc_df d ON f.ACC_NUM = d.IVSM_ACC_NUM
WHERE f.BUSI_DATE='20241231' AND d.DEPT_NAME='投资研究部'
GROUP BY f.SCR_NAME ORDER BY 总盈亏 DESC LIMIT 1;
```

**答案**：基金102，375.50
