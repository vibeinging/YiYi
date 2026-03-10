/**
 * Workspace Page - Sandbox Viewer
 * Browse and manage files in the Agent's sandboxed working directory.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  FolderOpen as FolderOpenIcon,
  File,
  Trash2,
  Save,
  RefreshCw,
  X,
  FileText,
  Loader2,
  FileCode,
  Image as ImageIcon,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  FolderPlus,
  FilePlus,
} from 'lucide-react';
import {
  listWorkspaceFiles,
  loadWorkspaceFile,
  loadWorkspaceFileBinary,
  saveWorkspaceFile,
  deleteWorkspaceFile,
  createWorkspaceFile,
  createWorkspaceDir,
  getWorkspacePath,
  type WorkspaceFile,
} from '../api/workspace';
import { executeShell } from '../api/system';
import { toast, confirm } from '../components/Toast';

/** Open a file/directory with the system default application (macOS) */
async function openExternal(path: string) {
  try {
    await executeShell('open', [path]);
  } catch (e) {
    toast.error(String(e));
  }
}

// --- Helpers ---

interface TreeNode {
  name: string;       // display name (just filename)
  path: string;       // relative path from workspace root
  isDir: boolean;
  size: number;
  modified?: number;
  children: TreeNode[];
}

function buildTree(files: WorkspaceFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  // Ensure parent dirs exist in map
  const getOrCreateDir = (dirPath: string): TreeNode => {
    if (dirMap.has(dirPath)) return dirMap.get(dirPath)!;
    const parts = dirPath.split('/');
    const name = parts[parts.length - 1];
    const node: TreeNode = { name, path: dirPath, isDir: true, size: 0, children: [] };
    dirMap.set(dirPath, node);

    if (parts.length === 1) {
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = getOrCreateDir(parentPath);
      if (!parent.children.find(c => c.path === dirPath)) {
        parent.children.push(node);
      }
    }
    return node;
  };

  // First pass: create all directory nodes
  for (const f of files) {
    if (f.is_dir) {
      const node = getOrCreateDir(f.name);
      node.modified = f.modified;
      node.size = f.size;
    }
  }

  // Second pass: add files
  for (const f of files) {
    if (f.is_dir) continue;
    const parts = f.name.split('/');
    const name = parts[parts.length - 1];
    const fileNode: TreeNode = {
      name,
      path: f.name,
      isDir: false,
      size: f.size,
      modified: f.modified,
      children: [],
    };

    if (parts.length === 1) {
      root.push(fileNode);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = getOrCreateDir(parentPath);
      parent.children.push(fileNode);
    }
  }

  // Sort each level: dirs first, then alphabetically
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => { if (n.children.length) sortNodes(n.children); });
  };
  sortNodes(root);
  return root;
}

type FileCategory = 'text' | 'image' | 'other';

const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'py', 'rs', 'ts', 'tsx', 'js', 'jsx',
  'css', 'html', 'sh', 'bash', 'zsh', 'fish', 'log', 'csv', 'xml', 'env', 'cfg',
  'ini', 'conf', 'gitignore', 'dockerignore', 'makefile', 'dockerfile', 'sql', 'graphql',
  'svelte', 'vue', 'go', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'rb', 'php',
  'r', 'lua', 'zig', 'nix', 'lock',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico',
]);

function getFileCategory(filename: string): FileCategory {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  // Files without extension treated as text
  if (!filename.includes('.')) return 'text';
  return 'other';
}

function getFileIcon(filename: string, isDir: boolean, isOpen?: boolean) {
  if (isDir) return isOpen ? FolderOpenIcon : Folder;
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (IMAGE_EXTENSIONS.has(ext)) return ImageIcon;
  if (TEXT_EXTENSIONS.has(ext)) return FileCode;
  if (ext === 'md' || ext === 'txt' || ext === 'log') return FileText;
  return File;
}

function getLanguageLabel(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    md: 'Markdown', txt: 'Text', json: 'JSON', yaml: 'YAML', yml: 'YAML',
    toml: 'TOML', py: 'Python', rs: 'Rust', ts: 'TypeScript', tsx: 'TSX',
    js: 'JavaScript', jsx: 'JSX', css: 'CSS', html: 'HTML', sh: 'Shell',
    log: 'Log', csv: 'CSV', xml: 'XML', sql: 'SQL', go: 'Go',
    java: 'Java', swift: 'Swift', c: 'C', cpp: 'C++', rb: 'Ruby',
    php: 'PHP', lua: 'Lua', svg: 'SVG',
  };
  return map[ext] || ext.toUpperCase() || 'TEXT';
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// --- Tree Node Component ---

function TreeNodeItem({
  node,
  depth,
  expandedDirs,
  selectedFile,
  onToggleDir,
  onSelectFile,
  onDelete,
  t,
}: {
  node: TreeNode;
  depth: number;
  expandedDirs: Set<string>;
  selectedFile: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onDelete: (path: string) => void;
  t: (key: string) => string;
}) {
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedFile === node.path;
  const Icon = getFileIcon(node.name, node.isDir, isExpanded);

  return (
    <>
      <div
        onClick={() => node.isDir ? onToggleDir(node.path) : onSelectFile(node.path)}
        className="group flex items-center gap-1.5 py-1.5 pr-2 rounded-lg cursor-pointer transition-all"
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          background: isSelected ? 'var(--color-bg-subtle)' : 'transparent',
        }}
        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = isSelected ? 'var(--color-bg-subtle)' : 'transparent'; }}
      >
        {node.isDir ? (
          <span className="w-4 h-4 flex items-center justify-center shrink-0" style={{ color: 'var(--color-text-muted)' }}>
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <Icon
          size={15}
          style={{
            color: node.isDir
              ? 'var(--color-primary)'
              : isSelected ? 'var(--color-primary)' : 'var(--color-text-muted)',
          }}
          className="shrink-0"
        />
        <span
          className="truncate text-[13px]"
          style={{ color: isSelected ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
        >
          {node.name}
        </span>
        {!node.isDir && (
          <span className="ml-auto text-[10px] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--color-text-muted)' }}>
            {formatSize(node.size)}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(node.path); }}
          className="p-1 rounded-md transition-all opacity-0 group-hover:opacity-100 shrink-0"
          style={{ color: 'var(--color-error)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title={t('common.delete')}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {node.isDir && isExpanded && node.children.map((child) => (
        <TreeNodeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          expandedDirs={expandedDirs}
          selectedFile={selectedFile}
          onToggleDir={onToggleDir}
          onSelectFile={onSelectFile}
          onDelete={onDelete}
          t={t}
        />
      ))}
    </>
  );
}

// --- Main Component ---

interface NewItemDialog {
  open: boolean;
  name: string;
  type: 'file' | 'folder';
}

export function WorkspacePage() {
  const { t } = useTranslation();
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileCategory, setFileCategory] = useState<FileCategory>('text');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [newItemDialog, setNewItemDialog] = useState<NewItemDialog>({ open: false, name: '', type: 'file' });

  const tree = useMemo(() => buildTree(files), [files]);

  const fileCount = useMemo(() => files.filter(f => !f.is_dir).length, [files]);
  const dirCount = useMemo(() => files.filter(f => f.is_dir).length, [files]);

  // Load file list
  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const [filesData, path] = await Promise.all([
        listWorkspaceFiles(),
        getWorkspacePath(),
      ]);
      setFiles(filesData);
      setWorkspacePath(path);
    } catch (error) {
      console.error('Failed to load files:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // Toggle directory expand/collapse
  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Select and load a file
  const selectFile = useCallback(async (filePath: string) => {
    const category = getFileCategory(filePath);
    setSelectedFile(filePath);
    setFileCategory(category);
    setHasChanges(false);
    setFileContent('');
    setImageDataUrl(null);

    try {
      if (category === 'text') {
        const content = await loadWorkspaceFile(filePath);
        setFileContent(content);
      } else if (category === 'image') {
        const bytes = await loadWorkspaceFileBinary(filePath);
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
          bmp: 'image/bmp', ico: 'image/x-icon',
        };
        const mime = mimeMap[ext] || 'image/png';
        const uint8 = new Uint8Array(bytes);
        const binary = uint8.reduce((acc, byte) => acc + String.fromCharCode(byte), '');
        const base64 = btoa(binary);
        setImageDataUrl(`data:${mime};base64,${base64}`);
      }
    } catch (error) {
      console.error('Failed to load file:', error);
      toast.error(String(error));
    }
  }, []);

  // Save file
  const handleSave = async () => {
    if (!selectedFile) return;
    setSaving(true);
    try {
      await saveWorkspaceFile(selectedFile, fileContent);
      setHasChanges(false);
      await loadFiles();
    } catch (error) {
      toast.error(`${t('workspace.save')}: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  // Create new item
  const handleCreateItem = async () => {
    const name = newItemDialog.name.trim();
    if (!name) return;

    try {
      if (newItemDialog.type === 'folder') {
        await createWorkspaceDir(name);
      } else {
        await createWorkspaceFile(name, '');
      }
      await loadFiles();
      setNewItemDialog({ open: false, name: '', type: 'file' });
      // Auto-expand parent dir if creating in subdirectory
      const parts = name.split('/');
      if (parts.length > 1) {
        const parentParts: string[] = [];
        setExpandedDirs(prev => {
          const next = new Set(prev);
          for (let i = 0; i < parts.length - 1; i++) {
            parentParts.push(parts[i]);
            next.add(parentParts.join('/'));
          }
          return next;
        });
      }
      if (newItemDialog.type === 'file') {
        await selectFile(name);
      }
    } catch (error) {
      toast.error(String(error));
    }
  };

  // Delete file/dir
  const handleDelete = async (path: string) => {
    if (!(await confirm(`${t('common.delete')} ${path}?`))) return;
    try {
      await deleteWorkspaceFile(path);
      if (selectedFile === path) {
        setSelectedFile(null);
        setFileContent('');
        setImageDataUrl(null);
        setHasChanges(false);
      }
      await loadFiles();
    } catch (error) {
      toast.error(String(error));
    }
  };

  // Render viewer/editor based on file category
  const renderViewer = () => {
    if (!selectedFile) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: 'var(--color-bg-subtle)' }}>
              <Folder size={24} style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
            </div>
            <h3 className="text-[15px] font-semibold mb-1.5 tracking-tight" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text)' }}>
              {t('workspace.selectFile')}
            </h3>
            <p className="text-[12px] max-w-xs mx-auto" style={{ color: 'var(--color-text-muted)' }}>
              {t('workspace.emptyDesc')}
            </p>
          </div>
        </div>
      );
    }

    if (fileCategory === 'image') {
      return (
        <div className="flex-1 flex items-center justify-center p-8 overflow-auto"
          style={{
            backgroundImage: 'linear-gradient(45deg, var(--color-bg-muted) 25%, transparent 25%), linear-gradient(-45deg, var(--color-bg-muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--color-bg-muted) 75%), linear-gradient(-45deg, transparent 75%, var(--color-bg-muted) 75%)',
            backgroundSize: '20px 20px',
            backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
          }}
        >
          {imageDataUrl && (
            <img
              src={imageDataUrl}
              alt={selectedFile}
              className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
            />
          )}
        </div>
      );
    }

    if (fileCategory === 'other') {
      const ext = selectedFile.split('.').pop()?.toUpperCase() || '';
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: 'var(--color-bg-subtle)' }}>
              <File size={28} style={{ color: 'var(--color-text-muted)' }} />
            </div>
            <h3 className="text-[15px] font-semibold mb-1" style={{ color: 'var(--color-text)' }}>
              {selectedFile.split('/').pop()}
            </h3>
            <p className="text-[12px] mb-1" style={{ color: 'var(--color-text-muted)' }}>
              {ext} · {formatSize(files.find(f => f.name === selectedFile)?.size || 0)}
            </p>
            <p className="text-[12px] mb-5" style={{ color: 'var(--color-text-muted)' }}>
              {t('workspace.cannotPreview')}
            </p>
            <button
              onClick={() => {
                const f = files.find(f => f.name === selectedFile);
                if (f) openExternal(f.path);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
              style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
            >
              <ExternalLink size={14} />
              {t('workspace.openExternal')}
            </button>
          </div>
        </div>
      );
    }

    // Text editor
    return (
      <>
        <div className="flex-1 p-6 overflow-auto">
          <textarea
            value={fileContent}
            onChange={(e) => { setFileContent(e.target.value); setHasChanges(true); }}
            className="w-full h-full resize-none bg-transparent focus:outline-none font-mono text-[13px] leading-relaxed min-h-[400px]"
            style={{
              fontFamily: '"SF Mono", "Menlo", "Monaco", "Courier New", monospace',
              lineHeight: '1.7',
              color: 'var(--color-text)',
            }}
          />
        </div>
        <div className="h-8 flex items-center justify-between px-5 text-[11px]" style={{ color: 'var(--color-text-muted)', background: 'var(--color-bg-elevated)' }}>
          <span>{fileContent.split('\n').length} {t('workspace.lines')}</span>
          <span className="uppercase tracking-wider">{getLanguageLabel(selectedFile)}</span>
        </div>
      </>
    );
  };

  return (
    <div className="h-full flex overflow-hidden">
      {/* Left: Tree sidebar */}
      <div className="w-72 flex flex-col h-full" style={{ background: 'var(--color-bg-elevated)' }}>
        {/* Toolbar */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <h2 className="font-semibold text-[15px] tracking-tight" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text)' }}>
                {t('workspace.title')}
              </h2>
              <span className="text-[12px] px-2 py-0.5 rounded-lg" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                {fileCount}
              </span>
            </div>
            <button
              onClick={loadFiles}
              disabled={loading}
              className="w-8 h-8 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50"
              style={{ color: 'var(--color-text-secondary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title={t('common.refresh')}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setNewItemDialog({ open: true, name: '', type: 'file' })}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors"
              style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
            >
              <FilePlus size={14} />
              {t('workspace.newFile')}
            </button>
            <button
              onClick={() => setNewItemDialog({ open: true, name: '', type: 'folder' })}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] transition-colors"
              style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
            >
              <FolderPlus size={14} />
            </button>
          </div>
        </div>

        {/* Tree */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
          {loading && files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Loader2 size={18} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
            </div>
          ) : tree.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full" style={{ color: 'var(--color-text-muted)' }}>
              <Folder size={36} className="mb-3 opacity-20" />
              <p className="text-[13px]">{t('workspace.noFiles')}</p>
            </div>
          ) : (
            <div>
              {tree.map((node) => (
                <TreeNodeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  expandedDirs={expandedDirs}
                  selectedFile={selectedFile}
                  onToggleDir={toggleDir}
                  onSelectFile={selectFile}
                  onDelete={handleDelete}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer: workspace path */}
        {workspacePath && (
          <div className="px-3 py-2 text-[11px] font-mono truncate" style={{ borderTop: '1px solid var(--sidebar-border)', color: 'var(--color-text-muted)' }} title={workspacePath}>
            {workspacePath}
          </div>
        )}
      </div>

      {/* Right: Viewer/Editor */}
      <div className="flex-1 flex flex-col h-full min-w-0" style={{ background: 'var(--color-bg)' }}>
        {selectedFile && (
          <div className="h-14 flex items-center justify-between px-5 shrink-0" style={{ background: 'var(--color-bg-elevated)' }}>
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--color-bg-subtle)' }}>
                {(() => { const Icon = getFileIcon(selectedFile, false); return <Icon size={15} style={{ color: 'var(--color-text-secondary)' }} />; })()}
              </div>
              <span className="font-medium text-[13px] truncate" style={{ color: 'var(--color-text)' }}>{selectedFile}</span>
              {hasChanges && (
                <span className="text-[11px] px-2 py-0.5 rounded-lg font-medium shrink-0" style={{ background: 'var(--color-warning)', color: '#FFFFFF', opacity: 0.9 }}>
                  {t('workspace.unsaved')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {fileCategory !== 'text' && (
                <button
                  onClick={() => {
                    const f = files.find(f => f.name === selectedFile);
                    if (f) openExternal(f.path);
                  }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                  style={{ color: 'var(--color-text-secondary)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  title={t('workspace.openExternal')}
                >
                  <ExternalLink size={15} />
                </button>
              )}
              <button
                onClick={async () => {
                  if (hasChanges && !(await confirm(t('workspace.unsaved') + '?'))) return;
                  setSelectedFile(null);
                  setFileContent('');
                  setImageDataUrl(null);
                  setHasChanges(false);
                }}
                className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                title={t('common.close')}
              >
                <X size={15} />
              </button>
              {fileCategory === 'text' && (
                <button
                  onClick={handleSave}
                  disabled={saving || !hasChanges}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-40"
                  style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {t('workspace.save')}
                </button>
              )}
            </div>
          </div>
        )}
        {renderViewer()}
      </div>

      {/* New item dialog */}
      {newItemDialog.open && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="rounded-2xl p-6 w-full max-w-md shadow-2xl animate-scale-in" style={{ background: 'var(--color-bg-elevated)' }}>
            <h2 className="font-semibold text-[15px] mb-5" style={{ color: 'var(--color-text)' }}>
              {t('workspace.newFileTitle')}
            </h2>

            {/* Type toggle */}
            <div className="flex gap-1 p-1 rounded-xl mb-5" style={{ background: 'var(--color-bg-subtle)' }}>
              {(['file', 'folder'] as const).map(type => (
                <button
                  key={type}
                  onClick={() => setNewItemDialog({ ...newItemDialog, type })}
                  className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[13px] font-medium transition-all"
                  style={{
                    background: newItemDialog.type === type ? 'var(--color-bg-elevated)' : 'transparent',
                    color: newItemDialog.type === type ? 'var(--color-text)' : 'var(--color-text-muted)',
                    boxShadow: newItemDialog.type === type ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  }}
                >
                  {type === 'file' ? <FilePlus size={14} /> : <FolderPlus size={14} />}
                  {t(type === 'file' ? 'workspace.typeFile' : 'workspace.typeFolder')}
                </button>
              ))}
            </div>

            <div className="mb-6">
              <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                {t(newItemDialog.type === 'file' ? 'workspace.fileName' : 'workspace.folderName')}
              </label>
              <input
                type="text"
                value={newItemDialog.name}
                onChange={(e) => setNewItemDialog({ ...newItemDialog, name: e.target.value })}
                placeholder={t(newItemDialog.type === 'file' ? 'workspace.newFilePlaceholder' : 'workspace.newFolderPlaceholder')}
                className="w-full px-3 py-2.5 rounded-xl font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: 'none' }}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateItem(); }}
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setNewItemDialog({ open: false, name: '', type: 'file' })}
                className="px-4 py-2 text-[13px] font-medium rounded-xl transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleCreateItem}
                className="px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
                style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
              >
                {t('workspace.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
