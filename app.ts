/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import 'source-map-support/register'
import { App } from 'homey' // eslint-disable-line import/no-extraneous-dependencies
import { HomeyAPIV3Local } from 'homey-api'
import pushLogsToUI from './decorators/logs'
import type {
  CapabilityValue,
  HomeySettings,
  HomeySettingValue,
  LogParams,
  MELCloudListener,
  TemperatureListener,
  TemperatureListenerData,
  Thresholds,
} from './types'

const melcloudAtaDriverId = 'homey:app:com.mecloud:melcloud'

@pushLogsToUI
class MELCloudExtensionApp extends App {
  names!: Record<string, string>

  api!: HomeyAPIV3Local

  melCloudDevices: HomeyAPIV3Local.ManagerDevices.Device[] = []

  melCloudListeners: Record<string, MELCloudListener> = {}

  outdoorTemperatureListener!: TemperatureListener | undefined

  outdoorTemperatureCapability = ''

  outdoorTemperatureValue!: number

  async onInit(): Promise<void> {
    this.names = Object.fromEntries(
      ['device', 'outdoor_temperature', 'temperature', 'thermostat_mode'].map(
        (name: string): [string, string] => [
          name,
          this.homey.__(`names.${name}`),
        ],
      ),
    )

    this.api = (await HomeyAPIV3Local.createAppAPI({
      homey: this.homey,
    })) as HomeyAPIV3Local
    // @ts-expect-error: homey-api is partially typed
    await this.api.devices.connect()
    await this.initialize(true)

    // @ts-expect-error: homey-api is partially typed
    this.api.devices.on('device.create', async (): Promise<void> => {
      await this.initialize()
    })
    // @ts-expect-error: homey-api is partially typed
    this.api.devices.on('device.delete', async (): Promise<void> => {
      await this.initialize()
    })
    this.homey.on('unload', (): void => {
      this.cleanListeners().catch((error: Error): void => {
        this.formatLog('error', { message: error.message })
      })
    })
  }

  async initialize(retry = false): Promise<void> {
    await this.refreshDevices()
    try {
      await this.autoAdjustCoolingAta()
    } catch (error: unknown) {
      this.formatLog('error', {
        message: error instanceof Error ? error.message : String(error),
      })
      if (retry) {
        this.formatLog('log', {}, 'retry')
        this.homey.setTimeout(async (): Promise<void> => {
          await this.initialize()
        }, 60000)
      }
    }
  }

  async cleanListeners(): Promise<void> {
    await Promise.all(
      Object.values(this.melCloudListeners).map(
        async (listener: MELCloudListener): Promise<void> => {
          await this.cleanListener(listener, 'thermostat_mode')
          await this.cleanListener(listener, 'temperature')
        },
      ),
    )
    this.melCloudListeners = {}
    if (this.outdoorTemperatureListener) {
      await this.cleanListener(this.outdoorTemperatureListener, 'temperature')
    }
    this.formatLog('log', {}, 'listener.cleaned_all')
  }

  async cleanListener<T extends TemperatureListener>(
    listener: T extends MELCloudListener
      ? MELCloudListener
      : TemperatureListener,
    capability: T extends MELCloudListener
      ? keyof MELCloudListener
      : keyof TemperatureListener,
  ): Promise<void> {
    if (!(capability in listener)) {
      return
    }
    const { device } = listener
    const { name } = device
    const deviceId: string = device.id
    listener[capability].destroy()
    this.formatLog(
      'log',
      {
        name,
        capability: this.names[capability],
      },
      'listener.cleaned',
    )
    if (deviceId === this.outdoorTemperatureListener?.device.id) {
      delete this.outdoorTemperatureListener.temperature
      return
    }
    if (capability === 'thermostat_mode') {
      delete this.melCloudListeners[deviceId].thermostat_mode
    } else if (capability === 'temperature') {
      delete this.melCloudListeners[deviceId].temperature
      await this.revertTemperature(device, this.getThreshold(deviceId))
    }
  }

  async revertTemperature(
    device: HomeyAPIV3Local.ManagerDevices.Device,
    value: number,
  ): Promise<void> {
    try {
      await device.setCapabilityValue({
        capabilityId: 'target_temperature',
        value,
      })
      this.formatLog(
        'log',
        {
          name: device.name,
          value: `${value}\u00A0°C`,
        },
        'target_temperature.reverted',
      )
    } catch (error: unknown) {
      this.formatLog('error', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  getThreshold(deviceId: string): number {
    return this.homey.settings.get('thresholds')[deviceId] as number
  }

  updateThreshold(
    device: HomeyAPIV3Local.ManagerDevices.Device,
    value: number,
  ): number {
    const thresholds: Thresholds =
      (this.homey.settings.get('thresholds') as Thresholds | null) ?? {}
    thresholds[device.id] = value
    this.setSettings({ thresholds })
    this.formatLog(
      'log',
      {
        name: device.name,
        value: `${value}\u00A0°C`,
      },
      'target_temperature.saved',
    )
    return value
  }

  async refreshDevices(): Promise<HomeyAPIV3Local.ManagerDevices.Device[]> {
    this.melCloudDevices = []
    const devices: HomeyAPIV3Local.ManagerDevices.Device[] =
      // @ts-expect-error: homey-api is partially typed
      (await this.api.devices.getDevices()) as HomeyAPIV3Local.ManagerDevices.Device[]
    return Object.values(devices).reduce<
      HomeyAPIV3Local.ManagerDevices.Device[]
    >((acc, device: HomeyAPIV3Local.ManagerDevices.Device) => {
      // @ts-expect-error: homey-api is partially typed
      if (device.driverId === melcloudAtaDriverId) {
        this.melCloudDevices.push(device)
      } else if (
        // @ts-expect-error: homey-api is partially typed
        device.capabilities.some((capability: string) =>
          capability.startsWith('measure_temperature'),
        )
      ) {
        acc.push(device)
      }
      return acc
    }, [])
  }

  async autoAdjustCoolingAta(
    { capabilityPath, enabled }: TemperatureListenerData = {
      capabilityPath:
        (this.homey.settings.get('capabilityPath') as string | null) ?? '',
      enabled: (this.homey.settings.get('enabled') as boolean | null) ?? false,
    },
  ): Promise<void> {
    if (!capabilityPath) {
      if (enabled) {
        throw new Error(this.homey.__('error.missing'))
      }
      this.setSettings({
        capabilityPath,
        enabled,
      })
      await this.cleanListeners()
      return
    }
    await this.handleTemperatureListenerData({
      capabilityPath,
      enabled,
    })
    if (enabled) {
      await this.listenToThermostatModes()
    }
  }

  async handleTemperatureListenerData({
    capabilityPath,
    enabled,
  }: TemperatureListenerData): Promise<void> {
    try {
      const [device, capability]: [
        HomeyAPIV3Local.ManagerDevices.Device,
        string,
      ] = await this.validateCapabilityPath(capabilityPath)
      this.setSettings({
        capabilityPath,
        enabled,
      })
      if (!this.outdoorTemperatureListener) {
        this.outdoorTemperatureListener = { device }
      } else if (device.id !== this.outdoorTemperatureListener.device.id) {
        this.outdoorTemperatureListener.device = device
      }
      this.outdoorTemperatureCapability = capability
      this.handleOutdoorTemperatureDeviceUpdate(capabilityPath)
    } catch (error: unknown) {
      throw new Error(error instanceof Error ? error.message : String(error))
    } finally {
      await this.cleanListeners()
    }
  }

  async validateCapabilityPath(
    capabilityPath: string,
  ): Promise<[HomeyAPIV3Local.ManagerDevices.Device, string]> {
    const [deviceId, capability]: string[] = capabilityPath.split(':')
    let device: HomeyAPIV3Local.ManagerDevices.Device | null = null
    try {
      // @ts-expect-error: homey-api is partially typed
      device = (await this.api.devices.getDevice({
        id: deviceId,
      })) as HomeyAPIV3Local.ManagerDevices.Device | null
    } catch (error: unknown) {
      throw new Error(
        this.homey.__('error.not_found', {
          name: this.names.device,
          id: deviceId,
        }),
      )
    }
    // @ts-expect-error: homey-api is partially typed
    if (!device || !(capability in (device.capabilitiesObj ?? {}))) {
      throw new Error(
        this.homey.__('error.not_found', {
          name: this.names.outdoor_temperature,
          id: capability,
        }),
      )
    }
    return [device, capability]
  }

  handleOutdoorTemperatureDeviceUpdate(capabilityPath: string): void {
    // @ts-expect-error: homey-api is partially typed
    this.outdoorTemperatureListener.device.on(
      'update',
      async (): Promise<void> => {
        if (
          !(
            this.outdoorTemperatureCapability in
            // @ts-expect-error: homey-api is partially typed
            (this.outdoorTemperatureListener.device.capabilitiesObj ?? {})
          )
        ) {
          this.formatLog(
            'error',
            {
              name: this.names.outdoor_temperature,
              id: capabilityPath,
            },
            'not_found',
          )
          await this.cleanListeners()
        }
      },
    )
  }

  async listenToThermostatModes(): Promise<void> {
    this.melCloudListeners = Object.fromEntries(
      this.melCloudDevices.map(
        (
          device: HomeyAPIV3Local.ManagerDevices.Device,
        ): [string, { device: HomeyAPIV3Local.ManagerDevices.Device }] => [
          device.id,
          { device },
        ],
      ),
    )
    const capabilityId = 'thermostat_mode'
    const capability: string = this.names.thermostat_mode
    await Promise.all(
      Object.values(this.melCloudListeners).map(
        async (listener: MELCloudListener): Promise<void> => {
          const { device } = listener
          const { name } = device
          const deviceId: string = device.id
          const currentThermostatMode: string =
            // @ts-expect-error: homey-api is partially typed
            (await this.api.devices.getCapabilityValue({
              deviceId,
              capabilityId,
            })) as string
          this.melCloudListeners[deviceId].thermostat_mode =
            device.makeCapabilityInstance(
              capabilityId,
              async (value: CapabilityValue): Promise<void> => {
                this.formatLog(
                  'log',
                  {
                    name,
                    capability,
                    value,
                  },
                  'listener.listened',
                )
                if (value === 'cool') {
                  await this.listenToTargetTemperature(listener)
                  return
                }
                await this.cleanListener(listener, 'temperature')
                const thermostatModes: string[] =
                  await this.getOtherThermostatModes(listener)
                if (thermostatModes.every((mode: string) => mode !== 'cool')) {
                  if (this.outdoorTemperatureListener) {
                    await this.cleanListener(
                      this.outdoorTemperatureListener,
                      'temperature',
                    )
                  }
                }
              },
            )
          this.formatLog(
            'log',
            {
              name,
              capability,
            },
            'listener.created',
          )
          if (currentThermostatMode === 'cool') {
            await this.listenToTargetTemperature(listener)
          }
        },
      ),
    )
  }

  async getOtherThermostatModes(
    excludedListener: MELCloudListener,
  ): Promise<string[]> {
    const capabilityId = 'thermostat_mode'
    return Promise.all(
      Object.values(this.melCloudListeners)
        .filter(({ device }) => device.id !== excludedListener.device.id)
        .map(
          ({ device }): Promise<string> =>
            // @ts-expect-error: homey-api is partially typed
            this.api.devices.getCapabilityValue({
              deviceId: device.id,
              capabilityId,
            }) as string,
        ),
    )
  }

  async listenToTargetTemperature(listener: MELCloudListener): Promise<void> {
    if ('temperature' in listener) {
      return
    }
    const { device } = listener
    const { name } = device
    const deviceId: string = device.id
    const capabilityId = 'target_temperature'
    const capability: string = this.names.temperature
    await this.listenToOutdoorTemperature()
    const currentTargetTemperature: number =
      // @ts-expect-error: homey-api is partially typed
      (await this.api.devices.getCapabilityValue({
        deviceId,
        capabilityId,
      })) as number
    this.melCloudListeners[deviceId].temperature =
      device.makeCapabilityInstance(
        capabilityId,
        async (value: CapabilityValue): Promise<void> => {
          if (
            value === this.getTargetTemperature(this.getThreshold(deviceId))
          ) {
            return
          }
          this.formatLog(
            'log',
            {
              name,
              capability,
              value: `${value as number}\u00A0°C`,
            },
            'listener.listened',
          )
          await this.handleTargetTemperature(
            listener,
            this.updateThreshold(device, value as number),
          )
        },
      )
    this.formatLog(
      'log',
      {
        name,
        capability,
      },
      'listener.created',
    )
    await this.handleTargetTemperature(
      listener,
      this.updateThreshold(device, currentTargetTemperature),
    )
  }

  async listenToOutdoorTemperature(): Promise<void> {
    if (
      !this.outdoorTemperatureListener ||
      'temperature' in this.outdoorTemperatureListener
    ) {
      return
    }
    const { device } = this.outdoorTemperatureListener
    const { name } = device
    const deviceId: string = device.id
    const capabilityId: string = this.outdoorTemperatureCapability
    const capability: string = this.names.temperature
    this.outdoorTemperatureValue =
      // @ts-expect-error: homey-api is partially typed
      (await this.api.devices.getCapabilityValue({
        deviceId,
        capabilityId,
      })) as number
    if ('temperature' in this.outdoorTemperatureListener) {
      return
    }
    this.outdoorTemperatureListener.temperature = device.makeCapabilityInstance(
      capabilityId,
      async (value: CapabilityValue): Promise<void> => {
        this.outdoorTemperatureValue = value as number
        this.formatLog(
          'log',
          {
            name,
            capability,
            value: `${value}\u00A0°C`,
          },
          'listener.listened',
        )
        await Promise.all(
          Object.values(this.melCloudListeners).map(
            (listener: MELCloudListener): Promise<void> =>
              this.handleTargetTemperature(
                listener,
                this.getThreshold(listener.device.id),
              ),
          ),
        )
      },
    )
    this.formatLog(
      'log',
      {
        name,
        capability,
      },
      'listener.created',
    )
  }

  getTargetTemperature(threshold: number): number {
    return Math.min(
      Math.max(threshold, Math.ceil(this.outdoorTemperatureValue) - 8),
      38,
    )
  }

  async handleTargetTemperature(
    listener: MELCloudListener,
    threshold: number,
  ): Promise<void> {
    await this.listenToOutdoorTemperature()
    if (!('temperature' in listener)) {
      return
    }
    await this.updateTargetTemperature(listener, threshold)
  }

  async updateTargetTemperature(
    listener: MELCloudListener,
    threshold: number,
  ): Promise<void> {
    if (!('temperature' in listener)) {
      return
    }
    const value: number = this.getTargetTemperature(threshold)
    try {
      await listener.temperature.setValue(value)
      this.formatLog(
        'log',
        {
          name: listener.device.name,
          value: `${value}\u00A0°C`,
          threshold: `${threshold}\u00A0°C`,
          outdoorTemperature: `${this.outdoorTemperatureValue}\u00A0°C`,
        },
        'target_temperature.calculated',
      )
    } catch (error: unknown) {
      this.formatLog('error', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  setSettings(settings: Partial<HomeySettings>): void {
    Object.entries(settings)
      .filter(
        ([setting, value]: [string, HomeySettingValue]) =>
          value !== this.homey.settings.get(setting),
      )
      .forEach(([setting, value]: [string, HomeySettingValue]): void => {
        this.homey.settings.set(setting, value)
      })
  }

  formatLog(
    logType: 'error' | 'log',
    params: LogParams,
    action?: string,
  ): void {
    this[logType](
      action
        ? this.homey
            .__(`${logType}.${action}`, params)
            .replace(/a el/gi, 'al')
            .replace(/de le/gi, 'du')
        : params.message,
      logType === 'error' ? '#error' : `#${action}`,
    )
  }

  async onUninit(): Promise<void> {
    await this.cleanListeners()
  }
}

export = MELCloudExtensionApp
