/// <reference types="vite/client" />
/// <reference types="vite-plugin-svg-icons/client" />

interface ImportMetaEnv {
  readonly VITE_APP_ENV: string
  readonly VITE_APP_BASE_URL: string
  readonly VITE_APP_IMAGE_URL: string
  readonly VITE_APP_CALLBACK_BASE_URL: string
  readonly VITE_APP_DEV_PORT: string
  readonly VITE_PROXY_BASE_URL: string
  readonly VITE_PROXY_URL: string
  readonly VITE_BASE_PATH: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// html2pdf.js 无类型声明
declare module 'html2pdf.js'
declare module 'html2pdf.js/dist/html2pdf.bundle.min.js'

// js-error-collection 无类型声明
declare module 'js-error-collection'
