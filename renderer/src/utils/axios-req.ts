import axios, { AxiosError, type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { notifications } from '@mantine/notifications'
import { useBasicStore } from '@/store/basic'
import { useConfigStore } from '@/store/config'
import i18n from '@/lang'

/** 业务错误统一弹 toast（替代 element-plus ElMessage.error） */
const errorToast = (message: string) => {
  notifications.show({ color: 'red', message, autoClose: 2000 })
}

// 扩展配置：保留原工程的 ignoreCode / ignoreMsg / isNotTipErrorMsg 语义
export interface ReqConfig extends AxiosRequestConfig {
  ignoreCode?: number | number[]
  ignoreMsg?: boolean
  isNotTipErrorMsg?: boolean
  /** 业务侧自定义标记：跳过全局 loading 遮罩(对齐原工程) */
  ignoreLoading?: boolean
}

const service = axios.create()
let tempReqUrlSave = ''

// ── Electron:把请求改走 ipc(主进程经进程通道转本地后端),前端不直连 HTTP。──
// JSON / FormData 上传 / blob 下载 全走 ipc;SSE 走 subscribeStream(api-stream.ts)。浏览器(无 electronAPI)回退 xhr。
const _xhrAdapter = (axios as any).getAdapter('xhr')
function _ipcPath(config: any): string {
  let url = config.url || ''
  try { if (/^https?:\/\//i.test(url)) { const u = new URL(url); url = u.pathname + u.search } } catch { /* keep */ }
  const p = config.params
  if (p && typeof p === 'object') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null) qs.append(k, String(v))
    const s = qs.toString()
    if (s) url += (url.includes('?') ? '&' : '?') + s
  }
  return url
}
function _flatHeaders(h: any): Record<string, string> {
  const out: Record<string, string> = {}
  const src = h && typeof h.toJSON === 'function' ? h.toJSON() : h || {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null || typeof v === 'object') continue
    out[k] = String(v)
  }
  return out
}
// 字节 ↔ base64(分块避免 String.fromCharCode 爆栈;过 ipc 通道用)
function _b64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[])
  return btoa(bin)
}
function _bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function _arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  return ab
}
const ipcAdapter = async (config: any) => {
  const ea = (window as any).electronAPI
  if (!ea?.apiRequest) return _xhrAdapter(config) // 浏览器:原生 xhr
  const isForm = typeof FormData !== 'undefined' && config.data instanceof FormData
  const wantBlob = config.responseType === 'blob'
  const wantArrayBuffer = config.responseType === 'arraybuffer'

  let body: string | null = null
  let bodyEncoding: string | undefined
  const headers = _flatHeaders(config.headers)
  if (isForm) {
    // FormData → 真实 multipart 字节(借浏览器 Request 编码)+ 带 boundary 的 content-type,base64 过通道
    const enc = new Request('http://x', { method: 'POST', body: config.data })
    const ab = await enc.arrayBuffer()
    body = _b64FromBytes(new Uint8Array(ab))
    bodyEncoding = 'base64'
    delete headers['Content-Type']
    delete headers['content-type']
    const ct = enc.headers.get('content-type')
    if (ct) headers['Content-Type'] = ct
  } else {
    body = config.data == null ? null : typeof config.data === 'string' ? config.data : JSON.stringify(config.data)
    if (body != null && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'
  }

  // 裸 axios 调用(下载等直调,绕过 service 拦截器)在此兜底加 token
  if (!headers['Authorization'] && !headers['authorization']) {
    const token = useBasicStore.getState().token
    if (token) headers['Authorization'] = `Bearer ${token}`
  }
  const r = await ea.apiRequest({ method: (config.method || 'get').toUpperCase(), url: _ipcPath(config), headers, body, bodyEncoding })

  let data: any
  if (r.bodyB64 !== undefined) {
    const bytes = _bytesFromB64(r.bodyB64)
    const ab = _arrayBufferFromBytes(bytes)
    data = wantBlob ? new Blob([ab], { type: String((r.headers && r.headers['content-type']) || '') })
      : wantArrayBuffer ? ab : bytes
  } else {
    data = r.json !== undefined ? r.json : r.body
  }
  const response: any = {
    data,
    status: r.status,
    statusText: r.statusText || '',
    headers: r.headers || {},
    config,
    request: {},
  }
  if (!config.validateStatus || config.validateStatus(r.status)) return response
  throw new AxiosError(
    `Request failed with status code ${r.status}`,
    r.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    response,
  )
}
// axios 读的是 defaults.adapter(不是 instance.adapter!)—— 必须设到 defaults 才生效。
service.defaults.adapter = ipcAdapter
// 全局兜底:裸 axios(axios.get/post 直调,绕过 service)也走 ipc —— 下载/上传/其它直调
axios.defaults.adapter = ipcAdapter

service.interceptors.request.use(
  (req) => {
    const basicStore = useBasicStore.getState()
    const token = basicStore.token

    req.cancelToken = new axios.CancelToken((cancel) => {
      tempReqUrlSave = req.url || ''
      basicStore.axiosPromiseArr.push({ url: req.url, cancel })
    })

    if (token && !req.headers.Authorization) {
      req.headers.Authorization = `Bearer ${token}`
    }

    const configStore = useConfigStore.getState()
    const langMap: Record<string, string> = { zh: 'zh-CN', en: 'en-US' }
    req.headers['Accept-Language'] = langMap[configStore.language] || 'zh-CN'

    if ('get'.includes((req.method || '').toLowerCase()) && !req.params) req.params = req.data
    return req
  },
  (err) => Promise.reject(err)
)

service.interceptors.response.use(
  (res: AxiosResponse) => {
    useBasicStore.getState().remotePromiseArrByReqUrl(tempReqUrlSave)
    const { success, message, msg } = res.data || {}
    const config = res.config as ReqConfig

    if (success === true) return res.data as any

    if (
      config.ignoreCode &&
      ((Array.isArray(config.ignoreCode) && config.ignoreCode.includes(res.data.code)) || config.ignoreCode === res.data.code)
    ) {
      return res.data as any
    }

    if (!config.ignoreMsg && !config.isNotTipErrorMsg) {
      errorToast(message || msg || i18n.t('common.http.requestFailed'))
    }
    return Promise.reject(res.data)
  },
  (err) => {
    useBasicStore.getState().remotePromiseArrByReqUrl(tempReqUrlSave)
    const status = err.response?.status
    const errorMessage = err.response?.data?.message || err.response?.data?.msg || err.message
    const config = (err.config || {}) as ReqConfig

    const tip = (key: string) => {
      errorToast(errorMessage || i18n.t(key))
      return Promise.reject(err)
    }

    if (status === 401) return tip('common.http.authFailed')
    if (status === 403) return tip('common.http.forbidden')
    if (status === 404) return tip('common.http.notFound')
    if (status === 422) return tip('common.http.serverError')
    if (status === 400) return tip('common.http.badRequest')
    if (status >= 400 && status < 500) return tip('common.http.clientError')
    if (status >= 500) return tip('common.http.internalError')

    if (!err.response) {
      errorToast(i18n.t('common.http.networkError'))
      return Promise.reject(err)
    }

    if (!config.ignoreMsg) {
      errorToast(errorMessage || i18n.t('common.http.requestFailed'))
    }
    return Promise.reject(err.message || err)
  }
)

// 返回 Promise<any>:响应拦截器已把 AxiosResponse 解包成业务信封({success,data,message,...}),
// 调用方直接读 res.success/res.data,故对外类型用 any,避免全工程到处 `as any`。
export default function axiosReq(config: ReqConfig): Promise<any> {
  return service({
    baseURL: import.meta.env.VITE_APP_BASE_URL || window.location.origin || '',
    timeout: 0,
    ...config
  }) as unknown as Promise<any>
}
