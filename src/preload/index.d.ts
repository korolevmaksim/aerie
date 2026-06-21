import type { AerieApi } from './index'

declare global {
  interface Window {
    aerie: AerieApi
  }
}
