import { useState } from 'react'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { t } from '@/lang'

// element-plus 的 type → mantine notifications 的 color 映射
const typeColorMap: Record<string, string> = {
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'blue'
}

export const useElement = () => {
  // 正整数
  const upZeroInt = (rule: any, value: any, callback: any, msg: any) => {
    if (!value) {
      callback(new Error(`${msg}${t('common.cannotBeEmpty')}`))
    }
    if (/^\+?[1-9]\d*$/.test(value)) {
      callback()
    } else {
      callback(new Error(`${msg}${t('common.inputError')}`))
    }
  }

  // 正整数（包括0）
  const zeroInt = (rule: any, value: any, callback: any, msg: any) => {
    if (!value) {
      callback(new Error(`${msg}${t('common.cannotBeEmpty')}`))
    }
    if (/^\+?[0-9]\d*$/.test(value)) {
      callback()
    } else {
      callback(new Error(`${msg}${t('common.inputError')}`))
    }
  }

  // 金额
  const money = (rule: any, value: any, callback: any, msg: any) => {
    if (!value) {
      callback(new Error(`${msg}${t('common.cannotBeEmpty')}`))
    }
    if (/((^[1-9]\d*)|^0)(\.\d{0,2}){0,1}$/.test(value)) {
      callback()
    } else {
      callback(new Error(`${msg}${t('common.inputError')}`))
    }
  }

  // 手机号
  const phone = (rule: any, value: any, callback: any, msg: any) => {
    if (!value) {
      callback(new Error(`${msg}${t('common.cannotBeEmpty')}`))
    }
    if (/^0?1[0-9]{10}$/.test(value)) {
      callback()
    } else {
      callback(new Error(`${msg}${t('common.inputError')}`))
    }
  }

  // 邮箱
  const email = (rule: any, value: any, callback: any, msg: any) => {
    if (!value) {
      callback(new Error(`${msg}不能为空`))
    }
    if (/(^([a-zA-Z]|[0-9])(\w|-)+@[a-zA-Z0-9]+\.([a-zA-Z]{2,4}))$/.test(value)) {
      callback()
    } else {
      callback(new Error(`${msg}`))
    }
  }

  // reactive(state) → useState；下游按字段读取(不再有 .value)
  const [state] = useState<any>({
    /* table*/
    tableData: [],
    rowDeleteIdArr: [],
    loadingId: null,
    /* 表单*/
    formModel: {},
    subForm: {},
    searchForm: {},
    /* 表单校验*/
    formRules: {
      //非空
      isNull: (msg: any) => [{ required: false, message: `${msg}`, trigger: 'blur' }],
      isNotNull: (msg: any) => [{ required: true, message: `${msg}`, trigger: 'blur' }],
      // 正整数
      upZeroInt: (msg: any) => [
        { required: true, validator: (rule: any, value: any, callback: any) => upZeroInt(rule, value, callback, msg), trigger: 'blur' }
      ],
      // 正整数（包括0）
      zeroInt: (msg: any) => [
        { required: true, validator: (rule: any, value: any, callback: any) => zeroInt(rule, value, callback, msg), trigger: 'blur' }
      ],
      // 金额
      money: (msg: any) => [
        { required: true, validator: (rule: any, value: any, callback: any) => money(rule, value, callback, msg), trigger: 'blur' }
      ],
      // 手机号
      phone: (msg: any) => [
        { required: true, validator: (rule: any, value: any, callback: any) => phone(rule, value, callback, msg), trigger: 'blur' }
      ],
      // 邮箱
      email: (msg: any) => [
        { required: true, validator: (rule: any, value: any, callback: any) => email(rule, value, callback, msg), trigger: 'blur' }
      ]
    },
    /* 时间packing相关*/
    datePickerOptions: {
      //选择今天以后的日期，包括今天
      disabledDate: (time: any) => {
        return time.getTime() < Date.now() - 86400000
      }
    },
    startEndArr: [],
    /* dialog相关*/
    dialogTitle: t('common.add'),
    detailDialog: false,
    isDialogEdit: false,
    dialogVisible: false,
    tableLoading: false,
    /* 树相关*/
    treeData: [],
    defaultProps: {
      children: 'children',
      label: 'label'
    }
  })
  return {
    ...state
  }
}

/*
 * 通知弹框
 * message：通知的内容
 * type：通知类型
 * duration：通知显示时长（ms）
 * */
export const elMessage = (message?: any, type?: any) => {
  notifications.show({
    withCloseButton: true,
    message: message || t('common.success'),
    color: typeColorMap[type] || typeColorMap.success
  })
}
/*
 * loading加载框
 * 调用后通过 loadingId.close() 进行关闭
 * */
// TODO(migration): el-loading 是 element-plus 的全局命令式 loading(ElLoading.service)。
// Mantine 的 LoadingOverlay/Loader 是组件级,无全局服务。这里用一个全屏遮罩 DOM 兜底,保持原 API。
let loadingEl: HTMLElement | null = null
export const elLoading = (msg?: any) => {
  if (loadingEl) return
  loadingEl = document.createElement('div')
  loadingEl.style.cssText =
    'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.1);'
  loadingEl.textContent = msg || t('common.dataLoading')
  document.body.appendChild(loadingEl)
}
export const closeElLoading = () => {
  if (loadingEl) {
    loadingEl.remove()
    loadingEl = null
  }
}
/*
 * 提示
 * message: 提示内容
 * type：提示类型
 * title：提示标题
 * duration：提示时长（ms）
 * */
export const elNotify = (message?: any, type?: any, title?: any, duration?: any) => {
  notifications.show({
    title: title || t('common.notifyTitle'),
    color: typeColorMap[type] || typeColorMap.success,
    message: message || t('common.notifyMsg'),
    position: 'top-right',
    autoClose: duration || 2500
  })
}
/*
  确认弹框(没有取消按钮)
* title:提示的标题
* message:提示的内容
* return Promise
* */
export const elConfirmNoCancelBtn = (title?: any, message?: any) => {
  return new Promise<void>((resolve, reject) => {
    modals.openConfirmModal({
      title: title || t('common.confirmTitle'),
      children: message || t('common.confirmDelete'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      // showCancelButton: false → 隐藏取消按钮
      cancelProps: { display: 'none' },
      onConfirm: () => resolve(),
      onCancel: () => reject(new Error('cancel'))
    })
  })
}
/*
 * 确认弹框
 * title:提示的标题
 * message:提示的内容
 * return Promise
 * */
export const elConfirm = (title?: any, message?: any) => {
  return new Promise<void>((resolve, reject) => {
    modals.openConfirmModal({
      title: title || t('common.confirmTitle'),
      children: message || t('common.confirmDelete'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      onConfirm: () => resolve(),
      onCancel: () => reject(new Error('cancel'))
    })
  })
}

/* 级联*/
// cascaderKey 原是 vue ref,用于强制刷新级联选择器。React 端用模块级变量兜底。
let cascaderKey: any
export const casHandleChange = () => {
  // 解决目前级联选择器搜索输入报错问题
  cascaderKey += cascaderKey
}
