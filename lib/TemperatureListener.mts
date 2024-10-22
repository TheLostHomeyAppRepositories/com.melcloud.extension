import type { HomeyAPIV3Local } from 'homey-api'

import type MELCloudExtensionApp from '../app.mjs'
import type { DeviceCapability, Value } from '../types.mjs'

export abstract class TemperatureListener {
  protected readonly app: MELCloudExtensionApp

  protected readonly device: HomeyAPIV3Local.ManagerDevices.Device

  protected readonly names: Record<string, string>

  protected temperatureListener: DeviceCapability = null

  protected constructor(
    app: MELCloudExtensionApp,
    device: HomeyAPIV3Local.ManagerDevices.Device,
  ) {
    this.app = app
    this.device = device
    ;({ names: this.names } = app)
  }

  protected async destroyTemperature(): Promise<void> {
    if (this.temperatureListener !== null) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      this.temperatureListener.destroy()
      this.temperatureListener = null
    }
    this.app.pushToUI('cleaned', {
      capability: this.names.temperature,
      name: this.device.name,
    })
    return Promise.resolve()
  }

  protected async getCapabilityValue(capabilityId: string): Promise<Value> {
    return (
      // @ts-expect-error: `homey-api` is partially typed
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (await this.app.api.devices.getCapabilityValue({
        capabilityId,
        deviceId: this.device.id,
      })) as Value
    )
  }
}