// 批量 schema 向量任务:提交即返回、逐表处理、终态回写。
export default {
  id: 'vector-background-job',
  desc: '批量向量生成持久任务与失败项重试信息',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('vector-background-job-eval');
    const filePath = writeFixture('vector_items.csv', 'id,name\n1,alpha\n2,beta\n');
    const imported = await driver.importTable(pid, filePath, { dsName: `vector-job-${Date.now()}` });
    const tableRows = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables?per_page=100`);
    const tableIds = (tableRows.json?.data?.items || []).map((table) => table.id).filter(Boolean);

    const session = await api('POST', `/api/projects/${pid}/sessions`, {
      title: 'vector-background-origin', source_type: 'agent', source_id: pid, action_type: 'agentic_chat',
    });
    const sid = session.json?.data?.id;
    const submitted = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/tables/store-vectors`, {
      table_ids: tableIds,
      only_pending: false,
      session_id: sid,
    });
    assert.status(submitted, 200, '批量向量任务提交成功');
    const job = submitted.json?.data?.job;
    assert.ok(!!job?.id, '批量向量任务返回 job.id');
    assert.eq(job?.status, 'queued', '批量向量任务提交即返回');
    assert.eq(Number(submitted.json?.data?.submitted_count), tableIds.length, '任务记录待处理表数量');

    let backgroundEvent = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const messages = await api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
      const data = messages.json?.data;
      const items = Array.isArray(data) ? data : (data?.items || data?.messages || []);
      backgroundEvent = items.find((message) => {
        const metadata = typeof message.message_metadata === 'string'
          ? JSON.parse(message.message_metadata || '{}')
          : (message.message_metadata || {});
        return metadata.background_job?.job_id === job.id;
      });
      if (backgroundEvent) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(!!backgroundEvent, '向量任务终态写回原会话');
    const metadata = typeof backgroundEvent?.message_metadata === 'string'
      ? JSON.parse(backgroundEvent.message_metadata || '{}')
      : (backgroundEvent?.message_metadata || {});
    const event = metadata.background_job || {};
    assert.ok(['completed', 'blocked_configuration', 'failed'].includes(event.status), `任务返回明确终态(${event.status})`);
    assert.eq(
      JSON.stringify([...(event.result?.requested_table_ids || [])].sort()),
      JSON.stringify([...tableIds].sort()),
      '任务结果保留最初请求的表 ID，供重启后继续处理',
    );
    if (event.status !== 'completed') {
      assert.ok(!!event.result?.failed_table_ids?.length, '失败结果只记录需要重试的表 ID');
      const retried = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/tables/store-vectors`, {
        retry_job_id: job.id,
        only_pending: false,
        session_id: sid,
      });
      assert.status(retried, 200, '可按原任务重试失败项');
      assert.eq(retried.json?.data?.retry_of_job_id, job.id, '重试任务关联原 job');
      assert.eq(
        Number(retried.json?.data?.submitted_count),
        event.result.failed_table_ids.length,
        '重试只提交上次失败的表',
      );
    }
  },
};
