/* eslint-disable
  @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
*/
import {
  type CapabilityValue,
  DEFAULT_0,
  type DeviceCapability,
  type Thresholds,
} from '../types'
import BaseTemperatureListener from './BaseTemperatureListener'
import type Homey from 'homey/lib/Homey'
import type { HomeyAPIV3Local } from 'homey-api'
import ListenerEvent from './ListenerEvent'
import OutdoorTemperatureListener from './OutdoorTemperatureListener'

const MAX_TEMPERATURE = 38
const MAX_TEMPERATURE_GAP = 8

export default class MELCloudListener extends BaseTemperatureListener {
  public static readonly listeners: Map<string, MELCloudListener> = new Map<
    string,
    MELCloudListener
  >()

  #thermostatModeListener: DeviceCapability = null

  public constructor(
    homey: Homey,
    device: HomeyAPIV3Local.ManagerDevices.Device,
  ) {
    super(homey, device)
    if (!MELCloudListener.listeners.has(device.id)) {
      MELCloudListener.listeners.set(device.id, this)
    }
  }

  public static async destroy(): Promise<void> {
    await Promise.all(
      Array.from(this.listeners.values()).map(
        async (listener: MELCloudListener): Promise<void> => {
          await listener.#destroy()
        },
      ),
    )
  }

  public async destroyTemperature(): Promise<void> {
    if (this.temperatureListener !== null) {
      super.destroyTemperature()
      await this.#revertTemperature()
    }
  }

  public async listenToThermostatMode(): Promise<void> {
    const currentThermostatMode: string = (await this.getCapabilityValue(
      'thermostat_mode',
    )) as string
    this.#thermostatModeListener = this.device.makeCapabilityInstance(
      'thermostat_mode',
      async (value: CapabilityValue): Promise<void> => {
        new ListenerEvent(this.homey, 'listener.listened', {
          capability: this.names.thermostatMode,
          name: this.device.name,
          value,
        }).pushToUI()
        if (value === 'cool') {
          await this.#listenToTargetTemperature()
          return
        }
        await this.destroyTemperature()
        if (
          !this.#isItCoolingElsewhere() &&
          OutdoorTemperatureListener.listener
        ) {
          OutdoorTemperatureListener.listener.destroyTemperature()
        }
      },
    )
    new ListenerEvent(this.homey, 'listener.created', {
      capability: this.names.thermostatMode,
      name: this.device.name,
    }).pushToUI()
    if (currentThermostatMode === 'cool') {
      await this.#listenToTargetTemperature()
    }
  }

  public async setTargetTemperature(): Promise<void> {
    if (this.temperatureListener !== null) {
      const value: number = this.#getTargetTemperature()
      await this.temperatureListener.setValue(value)
      new ListenerEvent(this.homey, 'target_temperature.calculated', {
        name: this.device.name,
        outdoorTemperature: `${OutdoorTemperatureListener.listener?.value}\u00A0°C`,
        threshold: `${this.#getThreshold()}\u00A0°C`,
        value: `${value}\u00A0°C`,
      }).pushToUI()
    }
  }

  async #destroy(): Promise<void> {
    await this.destroyTemperature()
    if (this.#thermostatModeListener !== null) {
      this.#thermostatModeListener.destroy()
    }
    new ListenerEvent(this.homey, 'listener.cleaned', {
      capability: this.names.thermostatMode,
      name: this.device.name,
    }).pushToUI()
    MELCloudListener.listeners.delete(this.device.id)
  }

  #getTargetTemperature(): number {
    return Math.min(
      Math.max(
        this.#getThreshold(),
        Math.ceil(OutdoorTemperatureListener.listener?.value ?? DEFAULT_0) -
          MAX_TEMPERATURE_GAP,
      ),
      MAX_TEMPERATURE,
    )
  }

  #getThreshold(): number {
    return this.#getThresholds()[this.device.id] ?? DEFAULT_0
  }

  #getThresholds(): Thresholds {
    return this.app.getHomeySetting('thresholds') ?? {}
  }

  #isItCoolingElsewhere(): boolean {
    return Array.from(MELCloudListener.listeners.values())
      .filter(({ device: { id } }) => id !== this.device.id)
      .map(
        (listener: MELCloudListener): string =>
          listener.#thermostatModeListener.value as string,
      )
      .some((mode: string) => mode === 'cool')
  }

  async #listenToTargetTemperature(): Promise<void> {
    if (
      this.temperatureListener === null &&
      OutdoorTemperatureListener.listener
    ) {
      await OutdoorTemperatureListener.listener.listenToOutdoorTemperature()
      const currentTargetTemperature: number = (await this.getCapabilityValue(
        'target_temperature',
      )) as number
      this.temperatureListener = this.device.makeCapabilityInstance(
        'target_temperature',
        async (value: CapabilityValue): Promise<void> => {
          if (value !== this.#getTargetTemperature()) {
            new ListenerEvent(this.homey, 'listener.listened', {
              capability: this.names.temperature,
              name: this.device.name,
              value: `${value as number}\u00A0°C`,
            }).pushToUI()
            await this.#setThreshold(value as number)
          }
        },
      )
      new ListenerEvent(this.homey, 'listener.created', {
        capability: this.names.temperature,
        name: this.device.name,
      }).pushToUI()
      await this.#setThreshold(currentTargetTemperature)
    }
  }

  async #revertTemperature(): Promise<void> {
    const value: number = this.#getThreshold()
    await this.device.setCapabilityValue({
      capabilityId: 'target_temperature',
      value,
    })
    new ListenerEvent(this.homey, 'target_temperature.reverted', {
      name: this.device.name,
      value: `${value}\u00A0°C`,
    }).pushToUI()
  }

  async #setThreshold(value: number): Promise<void> {
    const thresholds: Thresholds = this.#getThresholds()
    thresholds[this.device.id] = value
    this.app.setHomeySettings({ thresholds })
    new ListenerEvent(this.homey, 'target_temperature.saved', {
      name: this.device.name,
      value: `${value}\u00A0°C`,
    }).pushToUI()
    await this.setTargetTemperature()
  }
}
