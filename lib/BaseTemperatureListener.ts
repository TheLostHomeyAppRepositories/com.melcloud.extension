/* eslint-disable
  @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
*/
import type { DeviceCapability } from '../types'
import type Homey from 'homey/lib/Homey'
import type { HomeyAPIV3Local } from 'homey-api'
import ListenerEvent from './ListenerEvent'
import type MELCloudExtensionApp from '../app'

export default abstract class BaseTemperatureListener {
  protected temperatureListener: DeviceCapability = null

  protected readonly app: MELCloudExtensionApp

  protected readonly device: HomeyAPIV3Local.ManagerDevices.Device

  protected readonly homey: Homey

  protected readonly names: Record<string, string>

  public constructor(
    homey: Homey,
    device: HomeyAPIV3Local.ManagerDevices.Device,
  ) {
    this.homey = homey
    this.app = homey.app as MELCloudExtensionApp
    this.names = this.app.names
    this.device = device
  }

  public destroyTemperature(): void {
    if (this.temperatureListener !== null) {
      this.temperatureListener.destroy()
      this.temperatureListener = null
    }
    new ListenerEvent(this.homey, 'listener.cleaned', {
      capability: this.names.temperature,
      name: this.device.name,
    }).pushToUI()
  }

  protected async getCapabilityValue(
    capabilityId: string,
  ): Promise<number | string> {
    return (
      // @ts-expect-error: `homey-api` is partially typed
      (await this.app.api.devices.getCapabilityValue({
        capabilityId,
        deviceId: this.device.id,
      })) as number | string
    )
  }
}
