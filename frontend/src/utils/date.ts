/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 把 yyyy-MM-dd 解析为当天 0 点的毫秒数，非法日期返回 NaN */
export function parseDate(value: string): number {
  if (!value) return Number.NaN
  const parts = value.split('-').map((item) => Number(item))
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) return Number.NaN
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime()
}

/** 计算两个日期之间的整天数（to - from） */
export function daysBetween(from: string, to: string): number {
  const start = parseDate(from)
  const end = parseDate(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.round((end - start) / DAY_MS)
}

/** 今天（本地时区）的 yyyy-MM-dd */
export function todayIso(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
