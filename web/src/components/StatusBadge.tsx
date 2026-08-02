import type { TokenView, UserStatus } from '../api/client'

const labels: Record<TokenView['state'] | UserStatus, string> = {
  ACTIVE: '有效',
  GRACE: '时钟宽限',
  EXPIRED: '已过期',
  DISABLED: '已停用',
  PENDING: '待首次登录',
  SUSPENDED: '已暂停',
  DELETED: '已删除',
}

export function StatusBadge({ status }: { status: TokenView['state'] | UserStatus }) {
  return <span className={`status-badge status-${status.toLowerCase()}`}>{labels[status]}</span>
}
