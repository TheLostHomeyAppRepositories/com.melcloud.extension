/* eslint-disable @typescript-eslint/no-unsafe-call */
import type {
  HomeySettingsUI,
  TemperatureListenerData,
  TemperatureSensor,
  TimestampedLog,
} from '../types'
import type Homey from 'homey/lib/Homey'

const CATEGORIES: Record<string, { color?: string; icon: string }> = {
  /* eslint-disable @typescript-eslint/naming-convention */
  error: { color: '#E8000D', icon: '⚠️' },
  'listener.cleaned': { icon: '🗑️' },
  'listener.cleaned_all': { icon: '🛑' },
  'listener.created': { icon: '🔊' },
  'listener.listened': { color: '#0047AB', icon: '👂' },
  retry: { icon: '🔄' },
  'target_temperature.calculated': { color: '#008000', icon: '🔢' },
  'target_temperature.reverted': { icon: '↩️' },
  'target_temperature.saved': { icon: '☁️' },
  /* eslint-enable @typescript-eslint/naming-convention */
}

const SIX_DAYS = 6

const applyElement: HTMLButtonElement = document.getElementById(
  'apply',
) as HTMLButtonElement
const refreshElement: HTMLButtonElement = document.getElementById(
  'refresh',
) as HTMLButtonElement
const capabilityPathElement: HTMLSelectElement = document.getElementById(
  'capabilityPath',
) as HTMLSelectElement
const enabledElement: HTMLSelectElement = document.getElementById(
  'enabled',
) as HTMLSelectElement
const logsElement: HTMLTableSectionElement = document.getElementById(
  'logs',
) as HTMLTableSectionElement

const disableButtons = (value = true): void => {
  ;[applyElement, refreshElement].forEach((element: HTMLButtonElement) => {
    if (value) {
      element.classList.add('is-disabled')
    } else {
      element.classList.remove('is-disabled')
    }
  })
}

const enableButtons = (value = true): void => {
  disableButtons(!value)
}

const displayTime = (time: number, language: string): string =>
  new Date(time).toLocaleString(language, {
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  })

const createTimeElement = (
  time: number,
  icon: string,
  language: string,
): HTMLDivElement => {
  const timeElement: HTMLDivElement = document.createElement('div')
  timeElement.style.color = '#888'
  timeElement.style.flexShrink = '0'
  timeElement.style.marginRight = '1em'
  timeElement.style.textAlign = 'center'
  timeElement.style.whiteSpace = 'nowrap'
  timeElement.innerHTML = `${displayTime(time, language)}<br>${icon}`
  return timeElement
}

const createMessageElement = (
  message: string,
  color?: string,
): HTMLDivElement => {
  const messageElement: HTMLDivElement = document.createElement('div')
  if (typeof color !== 'undefined') {
    messageElement.style.color = color
  }
  messageElement.innerText = message
  return messageElement
}

capabilityPathElement.addEventListener('change', (): void => {
  if (capabilityPathElement.value) {
    if (enabledElement.value === 'false') {
      enabledElement.value = 'true'
    }
  } else if (enabledElement.value === 'true') {
    enabledElement.value = 'false'
  }
})

// eslint-disable-next-line func-style, max-lines-per-function
async function onHomeyReady(homey: Homey): Promise<void> {
  await homey.ready()

  const language: string = await new Promise<string>((resolve, reject) => {
    // @ts-expect-error: `homey` is partially typed
    homey.api('GET', '/language', (error: Error | null, lang: string): void => {
      if (error) {
        reject(error)
        return
      }
      document.documentElement.lang = lang
      resolve(lang)
    })
  })

  const displayLog = (log: TimestampedLog): void => {
    const { color, icon } = CATEGORIES[log.category ?? 'error']
    const timeElement: HTMLDivElement = createTimeElement(
      log.time,
      icon,
      language,
    )
    const messageElement: HTMLDivElement = createMessageElement(
      log.message,
      color,
    )
    const rowElement: HTMLDivElement = document.createElement('div')
    rowElement.style.display = 'flex'
    rowElement.style.marginBottom = '1em'
    rowElement.appendChild(timeElement)
    rowElement.appendChild(messageElement)
    logsElement.insertBefore(rowElement, logsElement.firstChild)
  }

  const getHomeySettings = async (): Promise<void> => {
    const homeySettings: HomeySettingsUI = await new Promise<HomeySettingsUI>(
      (resolve, reject) => {
        // @ts-expect-error: `homey` is partially typed
        homey.get(
          async (
            error: Error | null,
            settings: HomeySettingsUI,
          ): Promise<void> => {
            if (error) {
              // @ts-expect-error: `homey` is partially typed
              await homey.alert(error.message)
              reject(error)
              return
            }
            resolve(settings)
          },
        )
      },
    )
    if (!logsElement.childElementCount) {
      ;(homeySettings.lastLogs ?? [])
        .filter(({ time }) => {
          const date: Date = new Date(time)
          const oldestDate: Date = new Date()
          oldestDate.setDate(oldestDate.getDate() - SIX_DAYS)
          oldestDate.setHours(0, 0, 0, 0)
          return date >= oldestDate
        })
        .reverse()
        .forEach(displayLog)
    }
    capabilityPathElement.value = homeySettings.capabilityPath ?? ''
    enabledElement.value = String(homeySettings.enabled ?? false)
    enableButtons()
  }

  const handleTemperatureSensorsError = async (
    errorMessage: string,
  ): Promise<void> => {
    if (errorMessage === 'no_device_ata') {
      // @ts-expect-error: `homey` is partially typed
      await homey.confirm(
        homey.__('settings.no_device_ata'),
        null,
        async (error: Error | null, ok: boolean): Promise<void> => {
          if (error) {
            // @ts-expect-error: `homey` is partially typed
            await homey.alert(error.message)
          }
          if (ok) {
            // @ts-expect-error: `homey` is partially typed
            await homey.openURL('https://homey.app/a/com.mecloud')
          }
        },
      )
      return
    }
    // @ts-expect-error: `homey` is partially typed
    await homey.alert(errorMessage)
  }

  const getTemperatureSensors = (): void => {
    // @ts-expect-error: `homey` is partially typed
    homey.api(
      'GET',
      '/devices/sensors/temperature',
      async (
        error: Error | null,
        devices: TemperatureSensor[],
      ): Promise<void> => {
        if (error) {
          await handleTemperatureSensorsError(error.message)
          return
        }
        if (!devices.length) {
          // @ts-expect-error: `homey` is partially typed
          await homey.alert(homey.__('settings.no_device_measure'))
          return
        }
        devices.forEach((device: TemperatureSensor) => {
          const { capabilityPath, capabilityName } = device
          const optionElement: HTMLOptionElement =
            document.createElement('option')
          optionElement.value = capabilityPath
          optionElement.innerText = capabilityName
          capabilityPathElement.appendChild(optionElement)
        })
        await getHomeySettings()
      },
    )
  }

  refreshElement.addEventListener('click', (): void => {
    disableButtons()
    getHomeySettings()
      .catch(async (error: Error): Promise<void> => {
        // @ts-expect-error: `homey` is partially typed
        await homey.alert(error.message)
      })
      .finally(enableButtons)
  })

  applyElement.addEventListener('click', (): void => {
    disableButtons()
    const enabled: boolean = enabledElement.value === 'true'
    const capabilityPath: string = capabilityPathElement.value
    const body: TemperatureListenerData = { capabilityPath, enabled }
    // @ts-expect-error: `homey` is partially typed
    homey.api(
      'PUT',
      '/melcloud/cooling/auto_adjustment',
      body,
      async (error: Error | null): Promise<void> => {
        enableButtons()
        if (error) {
          // @ts-expect-error: `homey` is partially typed
          await homey.alert(error.message)
        }
      },
    )
  })

  homey.on('log', displayLog)

  getTemperatureSensors()
}
