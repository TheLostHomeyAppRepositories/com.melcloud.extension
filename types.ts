import { type HomeyAPIV3Local } from 'homey-api'

export type Settings = Record<string, any>

export type CapabilityValue = boolean | number | string

export interface CapabilityObj {
  id: string
  title: string
}

export interface MeasureTemperatureDevice {
  readonly capabilityName: string
  readonly capabilityPath: string
}

export interface TemperatureListenerData {
  readonly capabilityPath: string
  readonly enabled: boolean
}

// @ts-expect-error bug
type DeviceCapability = HomeyAPIV3Local.ManagerDevices.Device.DeviceCapability

export interface Listener {
  device: HomeyAPIV3Local.ManagerDevices.Device
  temperature?: DeviceCapability
  thermostat_mode?: DeviceCapability
}

export interface MELCloudListener extends Listener {}

export type TemperatureListener = Exclude<Listener, 'thermostat_mode'>

export interface Log {
  time: string
  message: string
  bold?: boolean
  color?: string
}
