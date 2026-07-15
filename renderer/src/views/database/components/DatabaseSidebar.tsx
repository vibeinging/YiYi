import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Badge } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './DatabaseSidebar.module.scss'

// 与源 ../composables/useDatabaseState.js 中的数据库项保持一致
export interface DatabaseItem {
  id: string
  name: string
  db_type: string
  host: string
  port: string | number
  database: string
  [k: string]: any
}

// 源组件的 databaseState 为 Vue composable(useDatabaseState),React 侧解包为普通值/方法
export interface DatabaseSidebarState {
  databaseList: DatabaseItem[]
  selectedDatabase: DatabaseItem | null
  isCollapsed: boolean
  getDbTypeTagType: (dbType: string) => string
  getDatabaseList: () => void | Promise<void>
  [k: string]: any
}

export interface DatabaseSidebarProps {
  databaseState: DatabaseSidebarState
  // defineEmits → 回调 props
  onSelectDatabase?: (database: DatabaseItem) => void
  onCreateDatabase?: () => void
}

// Element Plus el-tag type → Mantine Badge color 映射(保持原 getDbTypeTagType 语义)
const TAG_TYPE_COLOR: Record<string, string> = {
  primary: 'blue',
  success: 'green',
  danger: 'red',
  warning: 'orange',
  info: 'gray',
}

export default function DatabaseSidebar({ databaseState, onSelectDatabase, onCreateDatabase }: DatabaseSidebarProps) {
  const { t } = useTranslation()

  // 使用状态管理(从 databaseState 中获取)
  const { databaseList, selectedDatabase, isCollapsed, getDbTypeTagType } = databaseState

  // 简单的本地搜索状态
  const [localSearchKeyword, setLocalSearchKeyword] = useState('')

  const localFilteredList = useMemo(() => {
    if (!localSearchKeyword.trim()) {
      return databaseList
    }
    const keyword = localSearchKeyword.toLowerCase()
    return databaseList.filter(
      (db) =>
        db.name.toLowerCase().includes(keyword) ||
        db.db_type.toLowerCase().includes(keyword) ||
        db.host.toLowerCase().includes(keyword) ||
        db.database.toLowerCase().includes(keyword),
    )
  }, [localSearchKeyword, databaseList])

  const handleSearch = () => {
    // 搜索已通过 useMemo 自动处理
  }

  // 处理数据库点击
  const handleDatabaseClick = (database: DatabaseItem) => {
    onSelectDatabase?.(database)
  }

  // 组件挂载时获取数据库列表
  useEffect(() => {
    void databaseState.getDatabaseList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={`${styles.databaseSidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.sidebarHeader}>
        <div className={styles.title}>{t('database.sidebar.title')}</div>
        <Input
          value={localSearchKeyword}
          onChange={(e) => setLocalSearchKeyword(e.currentTarget.value)}
          placeholder={t('database.search.placeholder')}
          onKeyUp={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
          className={styles.searchInput}
          rightSection={
            <span className={styles.searchIcon} onClick={handleSearch}>
              <ElSvgIcon name="Search" size={16} />
            </span>
          }
        />
      </div>

      <div className={styles.databaseList}>
        {localFilteredList.map((item) => (
          <div
            key={item.id}
            data-testid="database-item"
            data-database-id={item.id}
            data-database-name={item.name}
            className={`${styles.databaseItem} ${
              selectedDatabase && selectedDatabase.id === item.id ? styles.active : ''
            }`}
            onClick={() => handleDatabaseClick(item)}
          >
            <div className={styles.dbInfo}>
              <div className={styles.dbTypeIcon}>
                <svg className={styles.dbIcon} viewBox="0 0 32 32">
                  {/* MySQL 图标 */}
                  {item.db_type === 'MySQL' ? (
                    <g className="mysql-icon">
                      <circle cx="16" cy="16" r="14" fill="#00618a" />
                      <path d="M10 12c4-2 8-2 12 0v8c-4 2-8 2-12 0V12z" fill="#f29111" />
                      <ellipse cx="16" cy="12" rx="6" ry="1.5" fill="#ffffff" />
                      <ellipse cx="16" cy="20" rx="6" ry="1.5" fill="#00758f" />
                    </g>
                  ) : /* PostgreSQL 图标 */ item.db_type === 'PostgreSQL' ? (
                    <g className="postgresql-icon">
                      <circle cx="16" cy="16" r="14" fill="#336791" />
                      <path
                        d="M12 10h8c2 0 4 2 4 4v4c0 2-2 4-4 4h-8c-2 0-4-2-4-4v-4c0-2 2-4 4-4z"
                        fill="#ffffff"
                      />
                      <text x="16" y="18" textAnchor="middle" fill="#336791" fontSize="6" fontWeight="bold">
                        P
                      </text>
                    </g>
                  ) : /* Oracle 图标 */ item.db_type === 'Oracle' ? (
                    <g className="oracle-icon">
                      <circle cx="16" cy="16" r="14" fill="#f80000" />
                      <ellipse cx="16" cy="16" rx="10" ry="6" fill="#ffffff" />
                      <ellipse cx="16" cy="16" rx="8" ry="4" fill="#f80000" />
                      <ellipse cx="16" cy="16" rx="6" ry="2" fill="#ffffff" />
                    </g>
                  ) : /* SQL Server 图标 */ item.db_type === 'SQLServer' ? (
                    <g className="sqlserver-icon">
                      <rect x="4" y="4" width="24" height="24" rx="2" fill="#cc2927" />
                      <rect x="6" y="6" width="20" height="20" rx="1" fill="#ffffff" />
                      <text x="16" y="14" textAnchor="middle" fill="#cc2927" fontSize="5" fontWeight="bold">
                        SQL
                      </text>
                      <text x="16" y="20" textAnchor="middle" fill="#cc2927" fontSize="4">
                        Server
                      </text>
                    </g>
                  ) : /* SQLite 图标 */ item.db_type === 'SQLite' ? (
                    <g className="sqlite-icon">
                      <circle cx="16" cy="16" r="14" fill="#0f80cc" />
                      <path
                        d="M8 10h16c1 0 2 1 2 2v8c0 1-1 2-2 2H8c-1 0-2-1-2-2v-8c0-1 1-2 2-2z"
                        fill="#ffffff"
                      />
                      <circle cx="12" cy="16" r="2" fill="#0f80cc" />
                      <circle cx="20" cy="16" r="2" fill="#0f80cc" />
                    </g>
                  ) : /* OpenGauss 图标 */ item.db_type === 'OpenGauss' ? (
                    <g className="opengauss-icon">
                      <circle cx="16" cy="16" r="14" fill="#009b72" />
                      <path d="M8 12l8-4 8 4v8l-8 4-8-4v-8z" fill="#ffffff" />
                      <path d="M12 14l4-2 4 2v4l-4 2-4-2v-4z" fill="#009b72" />
                    </g>
                  ) : /* ClickHouse 图标 */ item.db_type === 'ClickHouse' ? (
                    <g className="clickhouse-icon">
                      <circle cx="16" cy="16" r="14" fill="#ffcc01" />
                      <rect x="9" y="9" width="14" height="12" rx="2" fill="#111111" />
                      <rect x="10" y="10" width="12" height="10" rx="1" fill="#ffcc01" />
                      <rect x="12" y="12" width="8" height="2" rx="0.5" fill="#111111" />
                      <rect x="12" y="16" width="5" height="2" rx="0.5" fill="#111111" />
                      <circle cx="21" cy="17" r="1" fill="#111111" />
                    </g>
                  ) : (
                    /* 默认数据库图标 */
                    <g className="default-icon">
                      <circle cx="16" cy="16" r="14" fill="#606266" />
                      <rect x="8" y="10" width="16" height="12" rx="1" fill="#ffffff" />
                      <line x1="10" y1="14" x2="22" y2="14" stroke="#606266" strokeWidth="1" />
                      <line x1="10" y1="16" x2="22" y2="16" stroke="#606266" strokeWidth="1" />
                      <line x1="10" y1="18" x2="22" y2="18" stroke="#606266" strokeWidth="1" />
                    </g>
                  )}
                </svg>
              </div>
              <div className={styles.dbContent}>
                <div className={styles.dbType}>
                  <Badge size="sm" color={TAG_TYPE_COLOR[getDbTypeTagType(item.db_type)] || 'gray'}>
                    {item.db_type}
                  </Badge>
                </div>
                <div className={styles.dbName}>{item.name}</div>
              </div>
            </div>
            <div className={styles.dbExtra}>{item.host + ':' + item.port + '/' + item.database}</div>
          </div>
        ))}
      </div>

      {/* 底部新建按钮 */}
      <div className={styles.sidebarFooter}>
        <Button data-testid="database-create-button" className={styles.createBtn} size="sm" onClick={() => onCreateDatabase?.()}>
          {t('database.create.button')}
        </Button>
      </div>
    </div>
  )
}
