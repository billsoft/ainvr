import { Navigate, useLocation } from 'react-router-dom'

/** 旧地址的重定向：保留查询参数（统计范围、状态筛选等）。 */
export function MovedTo({ to }: { to: string }) {
  const { search } = useLocation()
  return <Navigate to={to + search} replace />
}
