import request from '@/utils/axios-req'
import { useBasicStore } from '@/store/basic'

/**
 * 解析上传的 Word 模板文件
 * @param {string} projectId - 项目 ID
 * @param {File} file - 上传的 Word 文件
 * @returns {Promise} 解析结果
 */
export const parseTemplate = (projectId: any, file: any) => {
  const token = useBasicStore.getState().token || ''

  const formData = new FormData()
  formData.append('file', file)

  return request({
    url: `/api/projects/${projectId}/templates/parse`,
    method: 'post',
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data'
    }
  })
}
