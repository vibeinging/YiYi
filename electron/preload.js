// Electron preload —— 经 contextBridge 把安全的原生能力暴露到 window.electronAPI。
// 前端检测 window.electronAPI 即知运行在桌面壳内。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  apiBaseUrl: 'http://localhost:57138', // 开发/评测后端端口;桌面生产请求走 IPC
  getPathForFile: (file) => {
    try { return webUtils?.getPathForFile ? webUtils.getPathForFile(file) : ''; } catch { return ''; }
  },
  isDirectoryPath: (path) => ipcRenderer.invoke('is-directory-path', path),
  // 原生文件/文件夹选择
  pickPaths: (defaultPath) => ipcRenderer.invoke('pick-paths', defaultPath ?? null),
  pickFolder: (defaultPath) => ipcRenderer.invoke('pick-folder', defaultPath ?? null),
  // 在 Finder / 资源管理器中显示
  revealInFinder: (p) => ipcRenderer.invoke('reveal-in-finder', p),
  // 工作区本地目录路径
  workspacePath: (wsId) => ipcRenderer.invoke('workspace-path', wsId),
  // 默认本地数据根目录: ~/.yiw
  defaultDataRoot: () => ipcRenderer.invoke('default-data-root'),
  // 注册当前会话允许渲染的本地工作区根(yiw-file:// 只读图片协议使用)
  registerLocalFileRoot: (rootPath) => ipcRenderer.invoke('register-local-file-root', rootPath),
  // 将超长粘贴文本保存成当前工作区内的 txt 附件。
  savePastedTextAttachment: (payload) => ipcRenderer.invoke('save-pasted-text-attachment', payload),
  // 没有磁盘路径的拖入文件(例如来自其它 App)落到当前工作区后再作为附件使用。
  saveDroppedFileAttachment: (payload) => ipcRenderer.invoke('save-dropped-file-attachment', payload),
  // 网络设置需要主进程在启动后端前读取,因此保存到 Electron userData。
  loadNetworkSettings: () => ipcRenderer.invoke('network-settings-load'),
  saveNetworkSettings: (settings) => ipcRenderer.invoke('network-settings-save', settings),
  // REST 请求经主进程转发到本地后端进程(axios adapter 用,不直连 HTTP)
  apiRequest: (req) => ipcRenderer.invoke('api-request', req),
  // SSE 流式:主进程从本地后端进程拉,逐块经 `yiw-stream:<id>` 推回;onMsg 收 {type:'head'|'data'|'end'|'error'}。
  // 返回 dispose():移除监听 + 取消上游(供前端 AbortSignal / 组件卸载)。
  streamStart: (req, onMsg) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const channel = `yiw-stream:${id}`;
    const listener = (_e, msg) => {
      onMsg(msg);
      if (msg && (msg.type === 'end' || msg.type === 'error')) ipcRenderer.removeListener(channel, listener);
    };
    ipcRenderer.on(channel, listener);
    ipcRenderer.invoke('stream-start', { ...req, id });
    return () => {
      ipcRenderer.removeListener(channel, listener);
      ipcRenderer.send('stream-abort', id);
    };
  },
});
