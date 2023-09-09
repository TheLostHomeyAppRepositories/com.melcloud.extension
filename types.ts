import type { HomeyAPIV3Local } from 'homey-api'

export interface Log {
  readonly action: string
  readonly message: string
}

export interface TimestampedLog extends Log {
  readonly time: number
}

export type Thresholds = Partial<Record<string, number>>

export type CapabilityValue = boolean | number | string

export type SettingValue =
  | boolean
  | string
  | TimestampedLog[]
  | Thresholds
  | null
  | undefined

export interface HomeySettings {
  readonly enabled?: boolean | null
  readonly capabilityPath?: string | null
  readonly thresholds?: Thresholds | null
  readonly lastLogs?: TimestampedLog[] | null
}

export interface MeasureTemperatureDevice {
  readonly capabilityName: string
  readonly capabilityPath: string
}

export interface TemperatureListenerData {
  readonly capabilityPath: string
  readonly enabled: boolean
}

// @ts-expect-error: homey-api is partially typed
type DeviceCapability = HomeyAPIV3Local.ManagerDevices.Device.DeviceCapability

interface BaseListener {
  device: HomeyAPIV3Local.ManagerDevices.Device
}

export interface TemperatureListener extends BaseListener {
  temperature?: DeviceCapability
}

export interface MELCloudListener extends TemperatureListener {
  thermostat_mode?: DeviceCapability
}
