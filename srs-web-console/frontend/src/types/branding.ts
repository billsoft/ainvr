/** OEM 品牌信息（后端 /api/branding，来源：部署目录的 branding.yaml）。空字符串 = 不显示该项 */
export interface Branding {
  productName: string
  subtitle: string
  shortName: string
  /** 留空显示软件真实版本 */
  versionLabel: string
  tagline: string
  copyrightHolder: string
  copyrightStartYear: number | null
  contactName: string
  contactPhone: string
}
