import {
  RnacosConfigClient,
  RnacosConfigError,
  type MarketplaceConfigPublisher,
} from '../rnacos/config-client.js'
import type { AccessGroupPublisher, RnacosPublisherOptions } from './types.js'

export class AccessGroupPublisherError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export class RnacosAccessGroupPublisher implements AccessGroupPublisher {
  private readonly client: MarketplaceConfigPublisher

  constructor(
    options: RnacosPublisherOptions,
    client: MarketplaceConfigPublisher = new RnacosConfigClient(options),
  ) {
    this.client = client
  }

  async publish(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
    content: string
    expectedMd5: string
  }): Promise<{ readbackMd5: string }> {
    try {
      return await this.client.publish({
        ...input,
        expectedOldMd5: null,
      })
    } catch (error) {
      if (error instanceof RnacosConfigError) {
        throw new AccessGroupPublisherError(error.code, error.message)
      }
      throw error
    }
  }
}
