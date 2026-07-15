// members 域路由表(成员与邀请 CRUD,抽自 routes/members_crud.js)。一域一文件,避免多 agent 扇出冲突。
import * as members from '../app/members/index.js';

export const membersRoutes = [
  { m: 'POST', p: '/api/projects/:pid/members', fn: members.addMember, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/members/:userId', fn: members.updateMember, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/members/:userId', fn: members.deleteMember, auth: true },
  { m: 'POST', p: '/api/projects/:pid/invite-links', fn: members.createInviteLink, auth: true },
  { m: 'POST', p: '/api/projects/:pid/invite-links/:id/revoke', fn: members.revokeInviteLink, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/invite-links/:id', fn: members.deleteInviteLink, auth: true },
  { m: 'GET', p: '/api/projects/join/:code/verify', fn: members.verifyInviteCode, auth: true },
  { m: 'POST', p: '/api/projects/join/:code', fn: members.joinProject, auth: true },
  { m: 'POST', p: '/api/projects/:pid/transfer-ownership', fn: members.transferOwnership, auth: true },
];
