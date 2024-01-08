import type Homey from 'homey/lib/Homey'
import type { EventParams } from '../types'

export default class EventError extends Error {
  public readonly name: string

  public readonly params?: EventParams

  public constructor(
    homey: Homey,
    eventName: string,
    eventParams?: EventParams,
  ) {
    super(homey.__(`log.${eventName}`, eventParams))
    this.name = eventName
    this.params = eventParams
  }
}
