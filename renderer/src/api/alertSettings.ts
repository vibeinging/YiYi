import axiosReq from '@/utils/axios-req'

export function getAlertSettingsReq() {
  return axiosReq({
    url: '/api/admin/alert-settings',
    method: 'get'
  })
}

export function updateAlertSettingsReq(data: any) {
  return axiosReq({
    url: '/api/admin/alert-settings',
    method: 'put',
    data
  })
}
