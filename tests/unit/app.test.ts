import type * as HomeyApi from 'homey-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HomeyLib from '../../lib/homey.mts'
import type {
  HomeySettings,
  OutdoorSources,
  TimestampedLog,
} from '../../types.mts'
import { changelog } from '../../files.mts'
import { assertDefined, cast } from '../helpers.ts'
import {
  type MockDevice,
  type MockHomey,
  createApiCall,
  createMockDevice,
  createMockDevicesManager,
  createMockHomey,
} from '../mocks.ts'
import MELCloudExtensionApp from '../../app.mts'

const { createAppAPIMock } = vi.hoisted(() => ({
  createAppAPIMock: vi.fn<() => Promise<unknown>>(),
}))

vi.mock(import('../../lib/homey.mts'), async () => {
  const { mock: mockModule } = await import('../helpers.ts')
  class AppStub {
    public readonly error = vi.fn<(...args: unknown[]) => void>()

    public readonly log = vi.fn<(...args: unknown[]) => void>()
  }
  return mockModule<typeof HomeyLib>({ App: AppStub })
})

vi.mock(import('homey-api'), async () => {
  const { mock: mockModule } = await import('../helpers.ts')
  return mockModule<typeof HomeyApi>({
    HomeyAPIV3Local: { createAppAPI: createAppAPIMock },
  })
})

const INIT_DELAY = 1000
const NOTIFICATION_DELAY = 10_000

const LATEST_VERSION = Object.keys(changelog).at(-1) ?? ''

const SENSOR_SOURCE = 'sensor-1:measure_temperature.outdoor'
const HOME_DEVICE_DATA = { id: 'uuid-home-1' }
// A device whose data carries no usable MELCloud id cannot be joined to
// a building, so it has no siblings to inherit from.
const NO_JOIN_ID = {}
const SHARED_BUILDING = [
  { deviceIds: ['1000', 'uuid-home-1'], name: 'Domicile' },
]
const SEPARATE_BUILDINGS = [
  { deviceIds: ['1000'], name: 'Domicile' },
  { deviceIds: ['uuid-home-1'], name: 'Chalet' },
]

interface Harness {
  readonly apiCall: ReturnType<typeof vi.fn>
  readonly app: MELCloudExtensionApp
  readonly manager: ReturnType<typeof createMockDevicesManager>
  readonly mockHomey: MockHomey
}

// One seeding scenario: what the settings already hold, what com.melcloud
// answers for the grouping, and the sources the app must end up with.
interface SeedCase {
  readonly expected: OutdoorSources
  readonly grouping: unknown
  readonly homeDeviceData: object
  readonly sources: OutdoorSources
}

const createDevices = (): {
  classicDevice: MockDevice
  homeDevice: MockDevice
  sensorDevice: MockDevice
} => ({
  classicDevice: createMockDevice({
    capabilities: [
      'measure_temperature',
      'measure_temperature.outdoor',
      'target_temperature',
      'thermostat_mode',
    ],
    driverId: 'homey:app:com.mecloud:melcloud',
    id: 'classic-1',
    melcloudId: '1000',
    name: 'Living room',
    values: {
      'measure_temperature.outdoor': 30,
      target_temperature: 23,
      thermostat_mode: 'cool',
    },
  }),
  homeDevice: createMockDevice({
    capabilities: [
      'measure_temperature',
      'target_temperature',
      'thermostat_mode',
    ],
    driverId: 'homey:app:com.mecloud:home-melcloud',
    id: 'home-1',
    melcloudId: 'uuid-home-1',
    name: 'Bedroom',
    values: { target_temperature: 21, thermostat_mode: 'heat' },
  }),
  sensorDevice: createMockDevice({
    capabilities: ['measure_power'],
    driverId: 'homey:app:com.other:plug',
    id: 'plug-1',
    name: 'Plug',
  }),
})

const createHarness = async (
  mockDevices: readonly MockDevice[],
  {
    settings = {},
    version = '0.0.0',
  }: {
    readonly settings?: Partial<HomeySettings>
    readonly version?: string
  } = {},
): Promise<Harness> => {
  const manager = createMockDevicesManager(mockDevices)
  const mockHomey = createMockHomey({ settings, version })
  const apiCall = createApiCall()
  createAppAPIMock.mockResolvedValue({
    call: apiCall,
    devices: manager.manager,
  })
  const app = new MELCloudExtensionApp()
  Object.assign(app, { homey: mockHomey.homey })
  await app.onInit()
  return { apiCall, app, manager, mockHomey }
}

const advancePastInit = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(INIT_DELAY)
}

const logCategories = (mockHomey: MockHomey): string[] =>
  (mockHomey.settingsStore.lastLogs ?? []).map(({ category }) => category ?? '')

const logMessages = (mockHomey: MockHomey): string[] =>
  (mockHomey.settingsStore.lastLogs ?? []).map(({ message }) => message)

describe(MELCloudExtensionApp, () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should expose the building grouping fetched from com.melcloud', async () => {
    const { classicDevice } = createDevices()
    const groups = [{ deviceIds: ['1000'], name: 'Domicile' }]
    const { app, mockHomey } = await createHarness([classicDevice])
    mockHomey.apiAppGet.mockReturnValue(groups)

    await advancePastInit()

    expect(mockHomey.apiAppGet).toHaveBeenCalledWith('/devices/groups')
    expect(app.deviceGroups).toStrictEqual(groups)
  })

  it('should poke open webviews with the freshness event at boot', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice])

    await advancePastInit()

    expect(mockHomey.realtime).toHaveBeenCalledWith(
      'webview_hashes_changed',
      null,
    )
  })

  it('should stamp the legacy weather default on the first seeding', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice])

    await advancePastInit()

    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': null,
    })
    expect(mockHomey.settingsStore.hasSeededOutdoorSources).toBe(true)
  })

  it('should read absent settings as empty without any AC device', async () => {
    const { sensorDevice } = createDevices()
    const { mockHomey } = await createHarness([sensorDevice])

    await advancePastInit()

    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({})
  })

  it.each<[string, SeedCase]>([
    [
      'default a newcomer in its own building to disabled',
      {
        expected: { 'classic-1': SENSOR_SOURCE, 'home-1': 'none' },
        grouping: SEPARATE_BUILDINGS,
        homeDeviceData: HOME_DEVICE_DATA,
        sources: { 'classic-1': SENSOR_SOURCE },
      },
    ],
    [
      'start both newcomers of a fresh building disabled',
      {
        // The sibling vote reads only pre-seed entries: neither newcomer
        // may count the other's freshly inferred value as a decision.
        expected: { 'classic-1': 'none', 'home-1': 'none' },
        grouping: SHARED_BUILDING,
        homeDeviceData: HOME_DEVICE_DATA,
        sources: {},
      },
    ],
    [
      'default a newcomer to disabled when no grouping is available',
      {
        expected: { 'classic-1': null, 'home-1': 'none' },
        grouping: 'not-a-grouping',
        homeDeviceData: HOME_DEVICE_DATA,
        sources: { 'classic-1': null },
      },
    ],
    [
      'inherit the building setting for a newcomer joining it',
      {
        expected: { 'classic-1': SENSOR_SOURCE, 'home-1': SENSOR_SOURCE },
        grouping: SHARED_BUILDING,
        homeDeviceData: HOME_DEVICE_DATA,
        sources: { 'classic-1': SENSOR_SOURCE },
      },
    ],
    [
      'default a newcomer without a usable join id to disabled',
      {
        // Unjoinable, so it starts disabled — the same answer as an
        // ungrouped one, even though its building shares a source.
        expected: { 'classic-1': SENSOR_SOURCE, 'home-1': 'none' },
        grouping: SHARED_BUILDING,
        homeDeviceData: NO_JOIN_ID,
        sources: { 'classic-1': SENSOR_SOURCE },
      },
    ],
    [
      'inherit the Homey-weather default from the building siblings',
      {
        expected: { 'classic-1': null, 'home-1': null },
        grouping: SHARED_BUILDING,
        homeDeviceData: HOME_DEVICE_DATA,
        sources: { 'classic-1': null },
      },
    ],
  ])(
    'should %s',
    async (_description, { expected, grouping, homeDeviceData, sources }) => {
      const { classicDevice, homeDevice } = createDevices()
      Object.assign(homeDevice.device, { data: homeDeviceData })
      const { mockHomey } = await createHarness([classicDevice, homeDevice], {
        settings: { hasSeededOutdoorSources: true, outdoorSources: sources },
      })
      mockHomey.apiAppGet.mockReturnValue(grouping)

      await advancePastInit()

      expect(mockHomey.settingsStore.outdoorSources).toStrictEqual(expected)
    },
  )

  it('should re-read the grouping on demand, following a rename', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice])
    mockHomey.apiAppGet.mockReturnValue([
      { deviceIds: ['1000'], name: 'Domicile' },
    ])

    await advancePastInit()

    mockHomey.apiAppGet.mockReturnValue([
      { deviceIds: ['1000'], name: 'Nouvelle maison' },
    ])

    await expect(app.refreshDeviceGroups()).resolves.toStrictEqual([
      { deviceIds: ['1000'], name: 'Nouvelle maison' },
    ])
    expect(app.deviceGroups).toStrictEqual([
      { deviceIds: ['1000'], name: 'Nouvelle maison' },
    ])
  })

  it('should read an off-shape grouping payload as no grouping', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice])
    mockHomey.apiAppGet.mockReturnValue('nonsense')

    await advancePastInit()

    expect(app.deviceGroups).toBeNull()
  })

  it('should read a failed grouping fetch as no grouping', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice])
    mockHomey.apiAppGet.mockRejectedValue(new Error('not_installed'))

    await advancePastInit()

    expect(app.deviceGroups).toBeNull()
  })

  it('should classify Classic and Home AC devices as adjustable', async () => {
    const { classicDevice, homeDevice, sensorDevice } = createDevices()
    const { app } = await createHarness([
      classicDevice,
      homeDevice,
      sensorDevice,
    ])

    await advancePastInit()

    expect(app.melcloudDevices.map(({ id }) => id)).toStrictEqual([
      'classic-1',
      'home-1',
    ])
    expect(app.temperatureSensors.map(({ id }) => id)).toStrictEqual([
      'classic-1',
      'home-1',
    ])
  })

  it('should adjust a Home-only account via the Homey weather by default', async () => {
    const { homeDevice } = createDevices()
    homeDevice.values.thermostat_mode = 'cool'
    const { apiCall } = await createHarness([homeDevice], {
      settings: { isEnabled: true },
    })

    await advancePastInit()

    expect(apiCall).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/manager/weather/weather',
    })
    expect(homeDevice.capabilityInstances.has('target_temperature')).toBe(true)
    expect(
      homeDevice.capabilityInstances.get('target_temperature')?.setValue,
    ).toHaveBeenCalledWith(22)
  })

  it('should start auto-adjustment on the configured capability when enabled', async () => {
    const { classicDevice } = createDevices()
    const { apiCall } = await createHarness([classicDevice], {
      settings: {
        isEnabled: true,
        outdoorSources: {
          'classic-1': 'classic-1:measure_temperature.outdoor',
        },
      },
    })

    await advancePastInit()

    expect(classicDevice.capabilityInstances.has('thermostat_mode')).toBe(true)
    expect(classicDevice.capabilityInstances.has('target_temperature')).toBe(
      true,
    )
    expect(apiCall).toHaveBeenCalledTimes(0)
  })

  it('should keep adjusting the other devices when one source is invalid', async () => {
    const { classicDevice, homeDevice } = createDevices()
    homeDevice.values.thermostat_mode = 'cool'
    const { mockHomey } = await createHarness([classicDevice, homeDevice], {
      settings: {
        isEnabled: true,
        outdoorSources: { 'classic-1': 'missing:capability' },
      },
    })

    await advancePastInit()

    const lastLogs = mockHomey.settingsStore.lastLogs ?? []

    expect(lastLogs.some(({ category }) => category === 'error')).toBe(true)
    expect(classicDevice.capabilityInstances.has('thermostat_mode')).toBe(false)
    expect(homeDevice.capabilityInstances.has('target_temperature')).toBe(true)
  })

  it('should share one weather source across the devices using it', async () => {
    const { classicDevice, homeDevice } = createDevices()
    classicDevice.values.thermostat_mode = 'cool'
    homeDevice.values.thermostat_mode = 'cool'
    const { apiCall } = await createHarness([classicDevice, homeDevice], {
      settings: { isEnabled: true },
    })

    await advancePastInit()

    expect(apiCall).toHaveBeenCalledTimes(1)
    expect(classicDevice.capabilityInstances.has('target_temperature')).toBe(
      true,
    )
    expect(homeDevice.capabilityInstances.has('target_temperature')).toBe(true)
  })

  it('should leave a device opted out with the disabled source alone', async () => {
    const { classicDevice, homeDevice } = createDevices()
    classicDevice.values.thermostat_mode = 'cool'
    homeDevice.values.thermostat_mode = 'cool'
    await createHarness([classicDevice, homeDevice], {
      settings: { isEnabled: true, outdoorSources: { 'classic-1': 'none' } },
    })

    await advancePastInit()

    expect(classicDevice.capabilityInstances.size).toBe(0)
    expect(homeDevice.capabilityInstances.has('target_temperature')).toBe(true)
  })

  it('should persist the settings without listening when disabled', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice])

    await advancePastInit()

    expect(mockHomey.settingsStore.isEnabled).toBe(false)
    // The boot seeding stamps the legacy default (null = Homey weather)
    // for devices that predate explicit entries.
    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': null,
    })
    expect(classicDevice.capabilityInstances.size).toBe(0)
  })

  it('should migrate the legacy global source to every AC device', async () => {
    const { classicDevice, homeDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice, homeDevice], {
      settings: { capabilityPath: 'classic-1:measure_temperature.outdoor' },
    })

    await advancePastInit()

    expect(mockHomey.settingsStore.capabilityPath).toBeUndefined()
    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': 'classic-1:measure_temperature.outdoor',
      'home-1': 'classic-1:measure_temperature.outdoor',
    })
  })

  it('should drop the legacy source when per-device sources already exist', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice], {
      settings: {
        capabilityPath: 'classic-1:measure_temperature.outdoor',
        outdoorSources: { 'classic-1': null },
      },
    })

    await advancePastInit()

    expect(mockHomey.settingsStore.capabilityPath).toBeUndefined()
    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': null,
    })
  })

  // An explicit null is the Homey-weather default, not an absent entry:
  // dropping it would make #seedOutdoorSources re-seed the device as a
  // newcomer. This is the Object.hasOwn regression guard.
  it('should keep an explicit null source through sanitizing', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice], {
      settings: {
        hasSeededOutdoorSources: true,
        outdoorSources: { 'classic-1': null },
      },
    })

    await advancePastInit()

    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': null,
    })
  })

  it('should read an off-shape outdoorSources setting as nothing stored', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice], {
      settings: { outdoorSources: cast('garbage') },
    })

    await advancePastInit()

    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': null,
    })
  })

  it('should still migrate the legacy source over an off-shape map', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice], {
      settings: {
        capabilityPath: 'classic-1:measure_temperature.outdoor',
        outdoorSources: cast('garbage'),
      },
    })

    await advancePastInit()

    expect(mockHomey.settingsStore.capabilityPath).toBeUndefined()
    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': 'classic-1:measure_temperature.outdoor',
    })
  })

  it('should drop a corrupt source entry and re-seed the device as a newcomer', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice], {
      settings: {
        hasSeededOutdoorSources: true,
        outdoorSources: cast({ 'classic-1': 42 }),
      },
    })

    await advancePastInit()

    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': 'none',
    })
  })

  // #persistLog spreads the stored value, so a non-iterable would throw
  // inside the call every listener uses to report.
  it('should drop an off-shape log history instead of crashing', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice], {
      settings: { lastLogs: cast('nope') },
    })

    await advancePastInit()
    app.pushToUI('cleanedAll')

    // Unsanitized, the string would have been spread character by
    // character into the history instead of being dropped.
    expect(
      mockHomey.settingsStore.lastLogs?.every(
        (entry) => typeof entry === 'object',
      ),
    ).toBe(true)
  })

  it('should drop off-shape entries from the log history', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice], {
      settings: {
        lastLogs: cast([{ message: 'kept', time: 1 }, { message: 2 }]),
      },
    })

    await advancePastInit()
    app.pushToUI('cleanedAll')

    expect(mockHomey.settingsStore.lastLogs).toContainEqual({
      message: 'kept',
      time: 1,
    })
    expect(mockHomey.settingsStore.lastLogs).not.toContainEqual({ message: 2 })
  })

  it('should read an off-shape listener body as disabled without sources', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice])

    await advancePastInit()
    await app.autoAdjustCooling('garbage')

    expect(mockHomey.settingsStore.isEnabled).toBe(false)
    // The sanitizer yields no sources, and that absence must not erase
    // what seeding wrote: an off-shape body disables, it does not reset.
    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': null,
    })
  })

  // The settings page builds its payload from the devices it displayed,
  // so an incomplete list must not take the others' entries down with it.
  it('should keep the sources of devices the payload omits', async () => {
    const { classicDevice, homeDevice } = createDevices()
    const { app, mockHomey } = await createHarness(
      [classicDevice, homeDevice],
      {
        settings: {
          outdoorSources: {
            'classic-1': 'sensor-1:measure_temperature',
            'home-1': 'sensor-1:measure_temperature',
          },
        },
      },
    )

    await advancePastInit()
    await app.autoAdjustCooling({
      isEnabled: false,
      outdoorSources: { 'classic-1': null },
    })

    expect(mockHomey.settingsStore.outdoorSources).toStrictEqual({
      'classic-1': null,
      'home-1': 'sensor-1:measure_temperature',
    })
  })

  it('should not restart a device the payload omits but the store disables', async () => {
    const { classicDevice, homeDevice } = createDevices()
    classicDevice.values.thermostat_mode = 'cool'
    homeDevice.values.thermostat_mode = 'cool'
    const { app } = await createHarness([classicDevice, homeDevice], {
      settings: { outdoorSources: { 'classic-1': 'none' } },
    })

    await advancePastInit()
    await app.autoAdjustCooling({
      isEnabled: true,
      outdoorSources: { 'home-1': null },
    })

    expect(classicDevice.capabilityInstances.size).toBe(0)
    expect(homeDevice.capabilityInstances.has('target_temperature')).toBe(true)
  })

  it('should route an omitted device through its stored source', async () => {
    const { classicDevice, homeDevice } = createDevices()
    classicDevice.values.thermostat_mode = 'cool'
    homeDevice.values.thermostat_mode = 'cool'
    const { app } = await createHarness([classicDevice, homeDevice], {
      settings: {
        outdoorSources: { 'home-1': 'classic-1:measure_temperature.outdoor' },
      },
    })

    await advancePastInit()
    await app.autoAdjustCooling({
      isEnabled: true,
      outdoorSources: { 'classic-1': null },
    })

    expect(
      classicDevice.capabilityInstances.has('measure_temperature.outdoor'),
    ).toBe(true)
  })

  it('should log instead of crashing when the debounced reload fails', async () => {
    const { classicDevice } = createDevices()
    const { app, manager } = await createHarness([classicDevice])
    await advancePastInit()
    const createHandler = manager.eventHandlers.get('device.create')
    assertDefined(createHandler)
    manager.getDevices.mockRejectedValueOnce(new Error('api_down'))

    createHandler()
    await advancePastInit()

    expect(app.error).toHaveBeenCalledWith(
      'Failed to reload devices',
      new Error('api_down'),
    )
  })

  it('should coalesce rapid device events into one reload', async () => {
    const { classicDevice } = createDevices()
    const { manager } = await createHarness([classicDevice])
    await advancePastInit()
    const createHandler = manager.eventHandlers.get('device.create')
    const deleteHandler = manager.eventHandlers.get('device.delete')
    assertDefined(createHandler)
    assertDefined(deleteHandler)
    manager.getDevices.mockClear()

    createHandler()
    deleteHandler()
    await advancePastInit()

    expect(manager.getDevices).toHaveBeenCalledTimes(1)
  })

  it('should surface non-listener startup failures as logs', async () => {
    const { classicDevice } = createDevices()
    const { manager, mockHomey } = await createHarness([classicDevice], {
      settings: {
        isEnabled: true,
        outdoorSources: {
          'classic-1': 'classic-1:measure_temperature.outdoor',
        },
      },
    })
    manager.getCapabilityValue.mockRejectedValueOnce(new Error('api_down'))

    await advancePastInit()

    const lastLogs = mockHomey.settingsStore.lastLogs ?? []

    expect(lastLogs[0]?.message).toBe('log.api_down')
  })

  it('should parse log names into category and message', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice])

    app.pushToUI('cleanedAll')
    app.pushToUI('error.notFound', { idOrName: 'x', type: 'Device' })

    const [firstLog] = mockHomey.realtime.mock.calls
      .filter(([event]) => event === 'log')
      .map(([, log]) => log as TimestampedLog)

    expect(firstLog?.category).toBe('cleanedAll')
    expect(firstLog?.message).toBe('log.cleanedAll')
    expect(
      (mockHomey.settingsStore.lastLogs ?? []).map(({ category }) => category),
    ).toStrictEqual(['error', 'cleanedAll'])
  })

  it('should fall back to the message id when the translation is empty', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice])
    mockHomey.translate.mockReturnValueOnce('')

    app.pushToUI('saved')

    const [lastLog] = mockHomey.settingsStore.lastLogs ?? []

    expect(lastLog?.message).toBe('saved')
  })

  it('should fix the i18n contraction glitches', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice])
    mockHomey.translate.mockReturnValueOnce(
      'Temperatura de el exterior de le salon',
    )

    app.pushToUI('calculated')

    const [lastLog] = mockHomey.settingsStore.lastLogs ?? []

    expect(lastLog?.message).toBe('Temperatura del exterior du salon')
  })

  it('should cap the persisted log history', async () => {
    const { classicDevice } = createDevices()
    const seededLogs = Array.from({ length: 100 }, (_element, index) => ({
      category: 'saved',
      message: `log ${String(index)}`,
      time: index,
    }))
    const { app, mockHomey } = await createHarness([classicDevice], {
      settings: { lastLogs: seededLogs },
    })

    app.pushToUI('cleanedAll')

    const lastLogs = mockHomey.settingsStore.lastLogs ?? []

    expect(lastLogs).toHaveLength(100)
    expect(lastLogs[0]?.message).toBe('log.cleanedAll')
  })

  it('should notify once about the installed version changelog', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice], {
      version: LATEST_VERSION,
    })

    await vi.advanceTimersByTimeAsync(NOTIFICATION_DELAY)

    expect(mockHomey.createNotification).toHaveBeenCalledTimes(1)
    expect(mockHomey.settingsStore.notifiedVersion).toBe(LATEST_VERSION)
  })

  it('should not notify again for an already notified version', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice], {
      settings: { notifiedVersion: LATEST_VERSION },
      version: LATEST_VERSION,
    })

    await vi.advanceTimersByTimeAsync(NOTIFICATION_DELAY)

    expect(mockHomey.createNotification).toHaveBeenCalledTimes(0)
  })

  it('should not notify when the version has no changelog entry', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice], {
      version: '0.0.0',
    })

    await vi.advanceTimersByTimeAsync(NOTIFICATION_DELAY)

    expect(mockHomey.createNotification).toHaveBeenCalledTimes(0)
  })

  it('should keep the version unnotified when the notification fails', async () => {
    const { classicDevice } = createDevices()
    const { mockHomey } = await createHarness([classicDevice], {
      version: LATEST_VERSION,
    })
    mockHomey.createNotification.mockRejectedValueOnce(new Error('offline'))

    await vi.advanceTimersByTimeAsync(NOTIFICATION_DELAY)

    expect(mockHomey.settingsStore.notifiedVersion).toBeUndefined()
  })

  it('should destroy the listeners on uninit', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice], {
      settings: {
        isEnabled: true,
        outdoorSources: {
          'classic-1': 'classic-1:measure_temperature.outdoor',
        },
      },
    })
    await advancePastInit()
    const thermostatInstance =
      classicDevice.capabilityInstances.get('thermostat_mode')
    assertDefined(thermostatInstance)

    await app.onUninit()

    expect(thermostatInstance.destroy).toHaveBeenCalledTimes(1)

    const lastLogs = mockHomey.settingsStore.lastLogs ?? []

    expect(lastLogs.at(-1)?.category).toBe('cleanedAll')
  })

  it('should clean up on unload and surface cleanup failures', async () => {
    const { classicDevice } = createDevices()
    const { app, mockHomey } = await createHarness([classicDevice])
    const unloadHandler = mockHomey.eventHandlers.get('unload')
    assertDefined(unloadHandler)
    mockHomey.realtime.mockImplementationOnce(() => {
      throw new Error('realtime_down')
    })

    unloadHandler()
    await vi.advanceTimersByTimeAsync(0)

    expect(app.error).toHaveBeenCalledWith(
      'Failed to destroy listeners',
      new Error('realtime_down'),
    )
  })

  // The reconciliation is what makes the restore independent of the
  // events: every case below is one the capability listeners cannot
  // report, because no listener is watching when it happens.
  describe('outstanding adjustments', () => {
    const OWED = { previous: 21, written: 26 }

    const createOwingHarness = async (
      device: MockDevice,
      settings: Partial<HomeySettings> = {},
    ): Promise<Harness> =>
      createHarness([device], {
        settings: {
          adjustments: { 'classic-1': OWED },
          hasSeededOutdoorSources: true,
          isEnabled: true,
          outdoorSources: { 'classic-1': null },
          ...settings,
        },
      })

    // A settlement racing a write clears the record from under it: the
    // debt restarts from the value going out rather than inventing an
    // older one to give back.
    it('should restart a debt whose record vanished mid-write', async () => {
      const { classicDevice } = createDevices()
      const { app, mockHomey } = await createHarness([classicDevice], {
        settings: { hasSeededOutdoorSources: true, isEnabled: false },
      })

      app.recordWrite('classic-1', 26)

      expect(mockHomey.settingsStore.adjustments).toStrictEqual({
        'classic-1': { previous: 26, written: 26 },
      })
    })

    it('should write nothing for a device it owes nothing', async () => {
      const { classicDevice } = createDevices()
      const { app } = await createHarness([classicDevice], {
        settings: { hasSeededOutdoorSources: true, isEnabled: false },
      })

      await app.revertAdjustment(classicDevice.device)

      expect(classicDevice.setCapabilityValue).not.toHaveBeenCalled()
    })

    // Two restarts overlapping — a device event landing on a settings
    // apply — used to leave the first run's listener live but
    // unreachable: still writing setpoints, impossible to settle.
    it('should settle a predecessor listener before taking its slot', async () => {
      const { classicDevice } = createDevices()
      const { app } = await createOwingHarness(classicDevice)
      await advancePastInit()

      await Promise.all([app.autoAdjustCooling(), app.autoAdjustCooling()])
      await app.onUninit()

      // No listener may outlive the map that owns it: an orphan's
      // capability instances would still be alive at this point, writing
      // setpoints nothing could ever settle.
      expect(
        classicDevice.createdCapabilityInstances.filter(
          ({ destroy }) => destroy.mock.calls.length === 0,
        ),
      ).toStrictEqual([])
    })

    it('should settle a device that is no longer cooling', async () => {
      const { classicDevice } = createDevices()
      Object.assign(classicDevice.values, {
        target_temperature: 26,
        thermostat_mode: 'heat',
      })
      const { mockHomey } = await createOwingHarness(classicDevice)

      await advancePastInit()

      expect(classicDevice.setCapabilityValue).toHaveBeenCalledWith({
        capabilityId: 'target_temperature',
        value: 21,
      })
      expect(mockHomey.settingsStore.adjustments).toStrictEqual({})
      expect(logCategories(mockHomey)).toContain('reverted')
    })

    it('should settle a device the app no longer adjusts at all', async () => {
      const { classicDevice } = createDevices()
      classicDevice.values.target_temperature = 26
      const { mockHomey } = await createOwingHarness(classicDevice, {
        isEnabled: false,
      })

      await advancePastInit()

      expect(classicDevice.setCapabilityValue).toHaveBeenCalledWith({
        capabilityId: 'target_temperature',
        value: 21,
      })
      expect(mockHomey.settingsStore.adjustments).toStrictEqual({})
    })

    it('should keep a setpoint chosen after the adjustment', async () => {
      const { classicDevice } = createDevices()
      Object.assign(classicDevice.values, {
        target_temperature: 24,
        thermostat_mode: 'heat',
      })
      const { mockHomey } = await createOwingHarness(classicDevice)

      await advancePastInit()

      expect(classicDevice.setCapabilityValue).not.toHaveBeenCalled()
      expect(mockHomey.settingsStore.adjustments).toStrictEqual({})
      expect(logCategories(mockHomey)).toContain('kept')
    })

    it('should hold the debt when the setpoint reads as no temperature', async () => {
      const { classicDevice } = createDevices()
      Object.assign(classicDevice.values, {
        target_temperature: 'warm',
        thermostat_mode: 'heat',
      })
      const { mockHomey } = await createOwingHarness(classicDevice)

      await advancePastInit()

      expect(classicDevice.setCapabilityValue).not.toHaveBeenCalled()
      expect(mockHomey.settingsStore.adjustments).toStrictEqual({
        'classic-1': OWED,
      })
    })

    it('should hold the debt when the device cannot be read at all', async () => {
      const { classicDevice } = createDevices()
      const { manager, mockHomey } = await createOwingHarness(classicDevice)
      manager.getCapabilityValue.mockImplementation(() => {
        throw new Error('offline')
      })

      await advancePastInit()

      // "I could not check" must never read as "it stopped cooling".
      expect(classicDevice.setCapabilityValue).not.toHaveBeenCalled()
      expect(mockHomey.settingsStore.adjustments).toStrictEqual({
        'classic-1': OWED,
      })
    })

    it('should leave a still-cooling device to its listener', async () => {
      const { classicDevice } = createDevices()
      const { mockHomey } = await createOwingHarness(classicDevice)

      await advancePastInit()

      expect(logCategories(mockHomey)).not.toContain('reverted')
    })

    it('should leave the entry of a device Homey no longer knows', async () => {
      const { classicDevice } = createDevices()
      classicDevice.values.thermostat_mode = 'heat'
      const { mockHomey } = await createOwingHarness(classicDevice, {
        adjustments: { 'gone-1': OWED },
      })

      await advancePastInit()

      // Inert rather than pruned: nothing can be written to a device
      // that is not there, and a wrong prune cannot be undone.
      expect(mockHomey.settingsStore.adjustments).toStrictEqual({
        'gone-1': OWED,
      })
    })

    it('should keep the debt when the restore write fails', async () => {
      const { classicDevice } = createDevices()
      Object.assign(classicDevice.values, {
        target_temperature: 26,
        thermostat_mode: 'heat',
      })
      classicDevice.setCapabilityValue.mockRejectedValueOnce(new Error('gone'))
      const { mockHomey } = await createOwingHarness(classicDevice)

      await advancePastInit()

      expect(logMessages(mockHomey)).toContain('log.notFound')
      expect(mockHomey.settingsStore.adjustments).toStrictEqual({
        'classic-1': OWED,
      })
    })
  })

  it('should expose the localized names', async () => {
    const { classicDevice } = createDevices()
    const { app } = await createHarness([classicDevice])

    expect(app.names).toStrictEqual({
      device: 'names.device',
      homeyWeather: 'names.homeyWeather',
      outdoorTemperature: 'names.outdoorTemperature',
      temperature: 'names.temperature',
      thermostatMode: 'names.thermostatMode',
    })
  })
})
