import { useCallback, useState } from 'react'
import dayjs from 'dayjs'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import axiosReq from '@/utils/axios-req'
import { t } from '@/lang'

// 通知弹框(对齐原 use-element 的 elMessage：ElMessage → @mantine/notifications)
const elMessage = (message: string, type?: 'success' | 'warning' | 'error' | 'info') => {
  const colorMap: Record<string, string> = { success: 'green', warning: 'yellow', error: 'red', info: 'blue' }
  notifications.show({
    color: colorMap[type || 'success'] || 'green',
    message: message || t('common.success'),
    withCloseButton: true
  })
}

// 确认弹框(对齐原 use-element 的 elConfirm：ElMessageBox.confirm → @mantine/modals)
const elConfirm = (title: string, message: string): Promise<void> => {
  return new Promise<void>((resolve) => {
    modals.openConfirmModal({
      title: title || t('common.confirmTitle'),
      children: message || t('common.confirmDelete'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      onConfirm: () => resolve()
    })
  })
}

export const useTable = (searchForm: any, selectPageReq: () => void) => {
  /*define ref*/
  const [tableListData, setTableListData] = useState<any[]>([])
  const [totalPage, setTotalPage] = useState(0)
  const [pageNum, setPageNum] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  //列表请求
  const tableListReq = useCallback(
    (config: any) => {
      const data: any = Object.assign(
        {
          pageNum,
          pageSize
        },
        JSON.parse(JSON.stringify(searchForm))
      )
      Object.keys(data).forEach((fItem) => {
        if (['', null, undefined, Number.NaN].includes(data[fItem])) delete data[fItem]
        if (config.method === 'get') {
          if (Array.isArray(data[fItem])) delete data[fItem]
          if (data[fItem] instanceof Object) delete data[fItem]
        }
      })
      const reqConfig = {
        data,
        ...config
      }
      return axiosReq(reqConfig)
    },
    [pageNum, pageSize, searchForm]
  )

  /**
   * 日期范围选择处理
   * @param timeArr choose the time
   * @author 熊猫哥
   * @date 2022/9/25 14:02
   */
  const dateRangePacking = useCallback(
    (timeArr: any) => {
      if (timeArr && timeArr.length === 2) {
        searchForm.startTime = timeArr[0]
        //取今天23点
        if (searchForm.endTime) {
          searchForm.endTime = dayjs(timeArr[1]).endOf('day').format('YYYY-MM-DD HH:mm:ss')
        }
      } else {
        searchForm.startTime = ''
        searchForm.endTime = ''
      }
    },
    [searchForm]
  )
  //当前页
  const handleCurrentChange = useCallback(
    (val: number) => {
      setPageNum(val)
      selectPageReq()
    },
    [selectPageReq]
  )
  const handleSizeChange = useCallback(
    (val: number) => {
      setPageSize(val)
      selectPageReq()
    },
    [selectPageReq]
  )
  const resetPageReq = useCallback(() => {
    setPageNum(1)
    selectPageReq()
  }, [selectPageReq])

  /*多选*/
  const [multipleSelection, setMultipleSelection] = useState<any[]>([])
  const handleSelectionChange = useCallback((val: any[]) => {
    setMultipleSelection(val)
  }, [])
  /*批量删除*/
  const multiDelBtnDill = useCallback(
    (reqConfig: any) => {
      let rowDeleteIdArr: any[] = []
      let deleteNameTitle = ''
      rowDeleteIdArr = multipleSelection.map((mItem) => {
        deleteNameTitle = `${deleteNameTitle + mItem.id},`
        return mItem.id
      })
      if (rowDeleteIdArr.length === 0) {
        elMessage('表格选项不能为空', 'warning')
        return
      }
      const stringLength = deleteNameTitle.length - 1
      elConfirm('删除', `您确定要删除【${deleteNameTitle.slice(0, stringLength)}】吗`).then(() => {
        const data = rowDeleteIdArr
        // bfLoading 为原工程 axiosReq 的自定义 loading 标记,用 any 透传避免 ReqConfig 超额属性报错
        axiosReq({
          data,
          method: 'DELETE',
          bfLoading: true,
          ...reqConfig
        } as any).then(() => {
          elMessage('删除成功')
          resetPageReq()
        })
      })
    },
    [multipleSelection, resetPageReq]
  )
  //单个删除
  const tableDelDill = useCallback(
    (row: any, reqConfig: any) => {
      elConfirm('确定', `您确定要删除【${row.id}】吗？`).then(() => {
        axiosReq(reqConfig).then(() => {
          resetPageReq()
          elMessage(`【${row.id}】删除成功`)
        })
      })
    },
    [resetPageReq]
  )

  return {
    pageNum,
    pageSize,
    totalPage,
    tableListData,
    tableListReq,
    dateRangePacking,
    multipleSelection,
    handleSelectionChange,
    handleCurrentChange,
    handleSizeChange,
    resetPageReq,
    multiDelBtnDill,
    tableDelDill,
    // 暴露 setter,供消费方在 React 中更新原本由 ref.value 直接赋值的字段
    setTableListData,
    setTotalPage,
    setPageNum,
    setPageSize,
    setMultipleSelection
  }
}
