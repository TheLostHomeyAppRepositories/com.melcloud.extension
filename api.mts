import {
  MEASURE_TEMPERATURE,
  OUTDOOR_TEMPERATURE,
  type Capability,
  type TemperatureListenerData,
  type TemperatureSensor,
} from './types.mts'

import type { Homey } from 'homey/lib/Homey'

class AtaDeviceNotFoundError extends Error {
  public constructor() {
    super('ataDeviceNotFound')
  }
}

const api = {
  async autoAdjustCooling({
    body,
    homey,
  }: {
    body: TemperatureListenerData
    homey: Homey
  }): Promise<void> {
    await homey.app.autoAdjustCooling(body)
  },
  getLanguage({ homey }: { homey: Homey }): string {
    return homey.i18n.getLanguage()
  },
  getTemperatureSensors({ homey }: { homey: Homey }): TemperatureSensor[] {
    const { app } = homey
    if (!app.melcloudDevices.length) {
      throw new AtaDeviceNotFoundError()
    }
    return app.temperatureSensors
      .flatMap((device) => {
        const capabilities = Object.values(
          // @ts-expect-error: `homey-api` is partially typed
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          (device.capabilitiesObj as Record<string, Capability> | null) ?? {},
        ).filter(({ id }) => id.startsWith(MEASURE_TEMPERATURE))
        const outdoorCapability = capabilities.find(
          ({ id }) =>
            app.melcloudDevices.includes(device) && id === OUTDOOR_TEMPERATURE,
        )
        return (outdoorCapability ? [outdoorCapability] : capabilities).map(
          ({ id, title }): TemperatureSensor => ({
            capabilityName: `${device.name} - ${title}`,
            capabilityPath: `${device.id}:${id}`,
          }),
        )
      })
      .sort((device1, device2) =>
        device1.capabilityName.localeCompare(device2.capabilityName),
      )
  },
}

export default api
