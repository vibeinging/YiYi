import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coalesceEntityFieldsByRecordId,
  enrichExtractedIdFields,
  normalizeExtractSchemaParam,
} from '../../server/src/engine/tools/semantic_extract_subtask.js';

test('semantic extract schema accepts array input', () => {
  const schema = [{ name: 'molecule_id', type: 'string', description: '分子ID' }];

  assert.deepEqual(normalizeExtractSchemaParam(schema), schema);
});

test('semantic extract schema accepts JSON string input from function calling', () => {
  const schema = normalizeExtractSchemaParam('[{"name":"molecule_id","type":"string"}]');

  assert.deepEqual(schema, [{ name: 'molecule_id', type: 'string' }]);
});

test('semantic extract schema wraps single object input', () => {
  const schema = normalizeExtractSchemaParam({ name: 'is_carcinogenic', type: 'boolean' });

  assert.deepEqual(schema, [{ name: 'is_carcinogenic', type: 'boolean' }]);
});

test('semantic extract enriches budget and event record ids from row text context', () => {
  const schema = [
    { name: 'budget_id', type: 'string', description: '预算ID' },
    { name: 'event_id', type: 'string', description: '活动ID' },
  ];
  const enriched = enrichExtractedIdFields(
    { budget_id: null, event_id: null },
    {
      content:
        'The event supported by budget recTxecmwIhCdIKvl has been concluded. ' +
        'All related materials are archived under the event record recggMW2eyCYceNcy.',
    },
    schema,
  );

  assert.equal(enriched.budget_id, 'recTxecmwIhCdIKvl');
  assert.equal(enriched.event_id, 'recggMW2eyCYceNcy');
  assert.equal(enriched.record_id, 'recTxecmwIhCdIKvl');
  assert.equal(enriched.linked_event_id, 'recggMW2eyCYceNcy');
  assert.equal(enriched.record_ids, 'recTxecmwIhCdIKvl,recggMW2eyCYceNcy');
});

test('semantic extract treats campaign record as budget id and linked event record as event id', () => {
  const schema = [
    { name: 'budget_id', type: 'string', description: '预算ID' },
    { name: 'event_id', type: 'string', description: '活动ID' },
  ];
  const enriched = enrichExtractedIdFields(
    { budget_id: null, event_id: 'recykdvf4LgsyA3wZ' },
    {
      content:
        'The outsourced campaign, recvKTAWAFKkVNnXQ, has concluded. ' +
        "Its final event_status is Closed, with the agency's final report linked via the event record recykdvf4LgsyA3wZ.",
    },
    schema,
  );

  assert.equal(enriched.budget_id, 'recvKTAWAFKkVNnXQ');
  assert.equal(enriched.event_id, 'recykdvf4LgsyA3wZ');
  assert.equal(enriched.record_id, 'recvKTAWAFKkVNnXQ');
  assert.equal(enriched.linked_event_id, 'recykdvf4LgsyA3wZ');
});

test('semantic extract does not treat ordinary rec-prefixed words as record ids', () => {
  const enriched = enrichExtractedIdFields(
    {},
    {
      content:
        'The final reconciliation and later reclassification were reviewed before recruitment planning.',
    },
    [{ name: 'budget_id', type: 'string', description: '预算ID' }],
  );

  assert.equal(enriched.record_ids, undefined);
  assert.equal(enriched.record_id, undefined);
});

test('semantic extract infers budget amount from amount-specific text context', () => {
  const enriched = enrichExtractedIdFields(
    { budget_id: null, amount: null },
    {
      content:
        "The financial instrument recTxecmwIhCdIKvl was allocated 55. " +
        'Current records show that 54.25 has been spent, with 0.75 remaining.',
    },
    [
      { name: 'budget_id', type: 'string', description: '预算ID' },
      { name: 'amount', type: 'number', description: '预算金额' },
    ],
  );

  assert.equal(enriched.budget_id, 'recTxecmwIhCdIKvl');
  assert.equal(enriched.amount, 55);
});

test('semantic extract coalesces scattered entity fields by record id', () => {
  const schema = [
    { name: 'event_id', type: 'string', description: '活动ID' },
    { name: 'category', type: 'string', description: '预算类别' },
    { name: 'amount', type: 'number', description: '预算金额' },
  ];
  const rows = coalesceEntityFieldsByRecordId(
    [
      { record_id: 'recTxecmwIhCdIKvl', linked_event_id: null, event_id: null, category: 'Advertisement', amount: null },
      { record_id: 'recTxecmwIhCdIKvl', linked_event_id: null, event_id: null, category: null, amount: 55 },
      { record_id: 'recTxecmwIhCdIKvl', linked_event_id: 'recggMW2eyCYceNcy', event_id: null, category: null, amount: null },
    ],
    schema,
  );

  for (const row of rows) assert.equal(row.event_id, 'recggMW2eyCYceNcy');
  assert.equal(rows.filter((row) => row.is_entity_primary).length, 1);
  assert.equal(rows[2].is_entity_primary, true);
  assert.equal(rows[2].category, 'Advertisement');
  assert.equal(rows[2].amount, 55);
  assert.equal(rows[0].amount, null);
  assert.equal(rows[1].amount, null);
});
