/**
 * Permission Bridge — listens for permission://request events from the Rust
 * backend and renders an inline permission card in the chat stream.
 * The user's response is sent back via the respond_permission_request Tauri command.
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useChatStreamStore } from '../stores/chatStreamStore';

interface PermissionRequestPayload {
  request_id: string;
  permission_type: string;
  path: string;
  parent_folder: string;
  reason: string;
  risk_level: string;
}

export function usePermissionBridge() {
  useEffect(() => {
    const unlisten = listen<PermissionRequestPayload>('permission://request', (event) => {
      const req = event.payload;
      useChatStreamStore.getState().showPermission({
        requestId: req.request_id,
        permissionType: req.permission_type,
        path: req.path,
        parentFolder: req.parent_folder,
        reason: req.reason,
        riskLevel: req.risk_level,
        status: 'pending',
      });
    });

    return () => { unlisten.then((fn) => fn()); };
  }, []);
}
