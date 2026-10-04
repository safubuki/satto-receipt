/** Calendar date in the user's local timezone, YYYY-MM-DD. */
export const formatLocalDate = (date = new Date()): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Calendar month in the user's local timezone, YYYY-MM. */
export const formatLocalMonth = (date = new Date()): string => formatLocalDate(date).slice(0, 7)

/** Move a YYYY-MM value by a number of calendar months. */
export const shiftMonth = (month: string, delta: number): string => {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const monthIndex = Number(monthText) - 1
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) return formatLocalMonth()
  return formatLocalMonth(new Date(year, monthIndex + delta, 1))
}
