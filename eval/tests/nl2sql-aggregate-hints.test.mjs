import test from 'node:test';
import assert from 'node:assert/strict';

import { applyExplicitAggregateHints } from '../../server/src/engine/tools/sql_aggregate_hints.js';

test('explicit aggregate hints override only the named select aggregates', () => {
  const question = [
    '查询浙商证券股份有限公司在2024年12月31日的总盈亏(TOT_PL)、业务规模(MVAL_SCAL)、资金成本(CPTL_COST)、净盈亏(NET_PL)、增值税后收入(AFT_VAT_TOT_PL)。',
    '注意：CPTL_COST和NET_PL是节点级指标，同一节点同一日期重复，取单值（如MAX）；TOT_PL、MVAL_SCAL、AFT_VAT_TOT_PL需要按业务类型求和。',
  ].join('');
  const sql = [
    'SELECT MAX(TOT_PL) AS "总盈亏", MAX(MVAL_SCAL) AS "业务规模",',
    'MAX(CPTL_COST) AS "资金成本", MAX(NET_PL) AS "净盈亏",',
    'MAX(AFT_VAT_TOT_PL) AS "增值税后收入"',
    'FROM main.ads_zszq_daly_pl_df WHERE BUSI_DATE = 20241231',
  ].join(' ');

  const fixed = applyExplicitAggregateHints(sql, question);

  assert.match(fixed, /SUM\(TOT_PL\) AS "总盈亏"/);
  assert.match(fixed, /SUM\(MVAL_SCAL\) AS "业务规模"/);
  assert.match(fixed, /MAX\(CPTL_COST\) AS "资金成本"/);
  assert.match(fixed, /MAX\(NET_PL\) AS "净盈亏"/);
  assert.match(fixed, /SUM\(AFT_VAT_TOT_PL\) AS "增值税后收入"/);
});
