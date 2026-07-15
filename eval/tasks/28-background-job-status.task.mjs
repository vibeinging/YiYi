// 持久后台任务:提交即返回 job.id，失败原因可被 Agent 精确查询。
export default {
  id: 'background-job-status',
  desc: '文档后台任务持久状态与 Agent 精确查询',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('background-job-status-eval');
    const filePath = writeFixture('empty-document.txt', '');
    const session = await api('POST', `/api/projects/${pid}/sessions`, {
      title: 'background-job-origin',
      source_type: 'agent',
      source_id: pid,
      action_type: 'agentic_chat',
    });
    const sid = session.json?.data?.id;
    assert.ok(!!sid, '创建后台任务原会话');

    const source = await api('POST', `/api/projects/${pid}/unstructured-datasources`, {
      name: `background-job-${Date.now()}`,
      description: '后台任务 eval',
    });
    assert.status(source, 200, '创建非结构化数据源');
    const dsid = source.json?.data?.id;

    const submitted = await api('POST', `/api/projects/${pid}/unstructured-datasources/${dsid}/documents`, {
      file_path: filePath,
      session_id: sid,
    });
    assert.status(submitted, 200, '文档提交立即返回');
    const job = submitted.json?.data?.job;
    assert.ok(!!job?.id, '提交响应包含持久 job.id');
    assert.eq(job?.status, 'queued', '提交响应不等待后台完成');

    let document = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const list = await api('GET', `/api/projects/${pid}/unstructured-datasources/${dsid}/documents?per_page=20`);
      document = (list.json?.data?.items || []).find((item) => item.id === submitted.json?.data?.document?.id);
      if (document?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.eq(document?.status, 'failed', '空文档后台处理进入明确失败状态');
    assert.ok(/空|提取/.test(document?.error_msg || ''), '文档保留可操作失败原因');

    const messages = await api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
    const messageData = messages.json?.data;
    const messageItems = Array.isArray(messageData)
      ? messageData
      : (messageData?.items || messageData?.messages || []);
    const backgroundMessage = messageItems.find((message) => {
      const metadata = typeof message.message_metadata === 'string'
        ? JSON.parse(message.message_metadata || '{}')
        : (message.message_metadata || {});
      return metadata.source === 'background_job' && metadata.background_job?.job_id === job.id;
    });
    assert.ok(!!backgroundMessage, '任务终态主动写回原会话');

    const result = await driver.askAgent(
      pid,
      `查询后台任务 ${job.id} 的真实状态和失败原因。必须调用 job_status 并传 job_id，不要猜测。`,
      { title: 'background-job-status' },
    );
    const statusTool = (result.blocks || []).find(
      (block) => block.type === 'tool' && block.metadata?.tool_name === 'job_status',
    );
    assert.ok(!!statusTool, 'Agent 使用 job_status(job_id) 查询');
    assert.ok(/failed/.test(String(statusTool?.content || '')), 'Agent 看到持久任务失败状态');
    assert.ok(/empty_document|文档内容为空/.test(String(statusTool?.content || '')), 'Agent 看到稳定错误码和原因');
  },
};
