import SouthConnector from '../south-connector';
import EncryptionService from '../../service/encryption.service';
import pino from 'pino';
import { Instant } from '../../../shared/model/types';
import { DateTime } from 'luxon';
import { QueriesHistory } from '../south-interface';
import { SouthPIWebAPIItemSettings, SouthPIWebAPISettings } from '../../../shared/model/south-settings.model';
import { OIBusContent, OIBusTimeValue } from '../../../shared/model/engine.model';
import { SouthConnectorEntity, SouthConnectorItemEntity, SouthThrottlingSettings } from '../../model/south-connector.model';
import SouthConnectorRepository from '../../repository/config/south-connector.repository';
import SouthCacheRepository from '../../repository/cache/south-cache.repository';
import ScanModeRepository from '../../repository/config/scan-mode.repository';
import { BaseFolders } from '../../model/types';
import { SouthConnectorItemTestingSettings, AvailablePoint } from '../../../shared/model/south-connector.model';
import { HTTPRequest, ReqAuthOptions, ReqOptions } from '../../service/http-request.utils';

interface PIWebAPIPoint {
  WebId: string;
  Id: number;
  Name: string;
  Path: string;
  Descriptor: string;
  PointClass: string;
  PointType: string;
  DigitalSetName: string;
  EngineeringUnits: string;
  Span: number;
  Zero: number;
  Step: boolean;
  Future: boolean;
  DisplayDigits: number;
  Links: {
    Self: string;
    DataServer: string;
    Attributes: string;
    InterpolatedData: string;
    RecordedData: string;
    PlotData: string;
    SummaryData: string;
    Value: string;
    EndValue: string;
  };
}

interface PIWebAPIPointsResponse {
  Links: Record<string, unknown>;
  Items: Array<PIWebAPIPoint>;
}

interface PIWebAPIRecordedValue {
  Timestamp: string;
  UnitsAbbreviation: string;
  Good: boolean;
  Questionable: boolean;
  Substituted: boolean;
  Annotated: boolean;
  Value: number | string | boolean;
  Annotations?: Array<{
    Id: string;
    Name: string;
    Description: string;
    Value: string;
    Creator: string;
    CreationDate: string;
    Modifier: string;
    ModifyDate: string;
    Errors: unknown;
  }>;
}

interface PIWebAPIRecordedResponse {
  Items: Array<PIWebAPIRecordedValue>;
  Links: Record<string, unknown>;
}

/**
 * Class SouthPIWebAPI - Connect to OSIsoft PI Web API to retrieve historical data
 */
export default class SouthPIWebAPI extends SouthConnector<SouthPIWebAPISettings, SouthPIWebAPIItemSettings> implements QueriesHistory {
  private connected = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private disconnecting = false;

  constructor(
    connector: SouthConnectorEntity<SouthPIWebAPISettings, SouthPIWebAPIItemSettings>,
    engineAddContentCallback: (southId: string, data: OIBusContent) => Promise<void>,
    encryptionService: EncryptionService,
    southConnectorRepository: SouthConnectorRepository,
    southCacheRepository: SouthCacheRepository,
    scanModeRepository: ScanModeRepository,
    logger: pino.Logger,
    baseFolders: BaseFolders
  ) {
    super(
      connector,
      engineAddContentCallback,
      encryptionService,
      southConnectorRepository,
      southCacheRepository,
      scanModeRepository,
      logger,
      baseFolders
    );
  }

  async connect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      // Test connection by trying to get data server info
      await this.testConnection();
      this.connected = true;
      await super.connect();
    } catch (error) {
      this.logger.error(`Error while connecting to PI Web API. Reconnecting in ${this.connector.settings.retryInterval} ms. ${error}`);
      if (!this.disconnecting && this.connector.enabled && !this.reconnectTimeout) {
        await this.disconnect();
        this.reconnectTimeout = setTimeout(this.connect.bind(this), this.connector.settings.retryInterval);
      }
    }
  }

  async testConnection(): Promise<void> {
    try {
      // Validate required settings
      if (!this.connector.settings.url) {
        throw new Error('PI Web API URL is required');
      }
      if (!this.connector.settings.dataServerWebId) {
        throw new Error('Data Server Web ID is required');
      }
      if (!this.connector.settings.username) {
        throw new Error('Username is required');
      }
      if (!this.connector.settings.password) {
        throw new Error('Password is required');
      }

      const fetchOptions = this.createHttpOptions('GET');
      const requestUrl = new URL(
        `dataservers/${this.connector.settings.dataServerWebId}`,
        this.ensureUrlEndsWithSlash(this.connector.settings.url)
      );

      const response = await HTTPRequest(requestUrl, fetchOptions);

      if (!response.ok) {
        throw new Error(`PI Web API connection test failed with status ${response.statusCode}`);
      }

      this.logger.info('PI Web API connection test successful');
    } catch (error) {
      throw new Error(`PI Web API connection test failed: ${error}`);
    }
  }

  override async testItem(
    item: SouthConnectorItemEntity<SouthPIWebAPIItemSettings>,
    testingSettings: SouthConnectorItemTestingSettings,
    callback: (data: OIBusContent) => void
  ): Promise<void> {
    const content: OIBusContent = { type: 'time-values', content: [] };

    const startTime = testingSettings.history!.startTime;
    const endTime = testingSettings.history!.endTime;

    try {
      const values = await this.queryRecordedData(item.settings.pointWebId, startTime, endTime);
      content.content = values;
      callback(content);
    } catch (error) {
      throw new Error(`Error testing PI Web API item: ${error}`);
    }
  }

  /**
   * Get entries from PI Web API between startTime and endTime
   */
  async historyQuery(
    items: Array<SouthConnectorItemEntity<SouthPIWebAPIItemSettings>>,
    startTime: Instant,
    endTime: Instant
  ): Promise<Instant | null> {
    let updatedStartTime: Instant | null = null;
    this.logger.debug(`Requesting ${items.length} items between ${startTime} and ${endTime}`);
    const startRequest = DateTime.now().toMillis();

    const allValues: Array<OIBusTimeValue> = [];
    let maxTimestamp = new Date(startTime).getTime();

    try {
      // Process items in parallel with dynamic batch sizing based on item count
      // More items = larger batches for better performance, but not too large to avoid timeouts
      const dynamicBatchSize = Math.min(Math.max(Math.ceil(items.length / 10), 5), 50);
      this.logger.debug(`Processing ${items.length} items in batches of ${dynamicBatchSize}`);
      
      for (let i = 0; i < items.length; i += dynamicBatchSize) {
        const batch = items.slice(i, i + dynamicBatchSize);
        this.logger.debug(`Processing batch ${Math.floor(i / dynamicBatchSize) + 1}/${Math.ceil(items.length / dynamicBatchSize)}`);
        
        const batchPromises = batch.map(async item => {
          try {
            const values = await this.queryRecordedData(item.settings.pointWebId, startTime, endTime);
            return { item, values, success: true };
          } catch (error) {
            this.logger.error(`Error querying item ${item.name}: ${error}`);
            return { item, values: [], success: false };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        const successCount = batchResults.filter(r => r.success).length;
        this.logger.debug(`Batch completed: ${successCount}/${batch.length} items successful`);

        for (const { item, values } of batchResults) {
          // Add point ID to each value
          const valuesWithPointId = values.map(value => ({
            ...value,
            pointId: item.name
          }));

          allValues.push(...valuesWithPointId);

          // Track the maximum timestamp
          if (values.length > 0) {
            const itemMaxTimestamp = Math.max(...values.map(v => new Date(v.timestamp).getTime()));
            maxTimestamp = Math.max(maxTimestamp, itemMaxTimestamp);
          }
        }

        // Add delay between batches to respect API limits
        if (i + dynamicBatchSize < items.length) {
          await new Promise(resolve => setTimeout(resolve, this.connector.settings.throttling.readDelay));
        }
      }

      const requestDuration = DateTime.now().toMillis() - startRequest;

      if (allValues.length > 0) {
        this.logger.debug(`Found ${allValues.length} results for ${items.length} items in ${requestDuration} ms`);
        await this.addContent({ type: 'time-values', content: allValues });

        if (maxTimestamp > new Date(startTime).getTime()) {
          updatedStartTime = new Date(maxTimestamp).toISOString();
        }
      } else {
        this.logger.debug(`No result found. Request done in ${requestDuration} ms`);
      }
    } catch (error) {
      throw new Error(`Error querying PI Web API: ${error}`);
    }

    return updatedStartTime;
  }

  private async queryRecordedData(pointWebId: string, startTime: Instant, endTime: Instant): Promise<Array<OIBusTimeValue>> {
    const fetchOptions = this.createHttpOptions('GET');

    // Build URL with query parameters
    const url = new URL(`streams/${pointWebId}/recorded`, this.ensureUrlEndsWithSlash(this.connector.settings.url));
    url.searchParams.set('startTime', startTime);
    url.searchParams.set('endTime', endTime);
    url.searchParams.set('maxCount', '10000'); // Reasonable limit

    const response = await HTTPRequest(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.body.text();
      throw new Error(`PI Web API query failed with status ${response.statusCode}: ${errorText}`);
    }

    const data = (await response.body.json()) as PIWebAPIRecordedResponse;

    return data.Items.map(item => {
      const value = typeof item.Value === 'boolean' ? (item.Value ? 1 : 0) : item.Value;
      return {
        pointId: pointWebId,
        timestamp: item.Timestamp,
        value: value as string | number,
        quality: item.Good ? 'GOOD' : item.Questionable ? 'UNCERTAIN' : 'BAD',
        data: { value: value as string | number }
      };
    });
  }

  private createHttpOptions(method: string): ReqOptions {
    const auth: ReqAuthOptions = {
      type: 'basic',
      username: this.connector.settings.username,
      password: this.connector.settings.password || ''
    };

    return {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      auth,
      timeout: this.connector.settings.timeout * 1000,
      acceptUnauthorized: this.connector.settings.acceptUnauthorized
    };
  }

  public ensureUrlEndsWithSlash(url: string): string {
    return url.endsWith('/') ? url : `${url}/`;
  }

  getThrottlingSettings(settings: SouthPIWebAPISettings): SouthThrottlingSettings {
    return {
      maxReadInterval: settings.throttling.maxReadInterval,
      readDelay: settings.throttling.readDelay
    };
  }

  getMaxInstantPerItem(settings: SouthPIWebAPISettings): boolean {
    return settings.throttling.maxInstantPerItem;
  }

  getOverlap(settings: SouthPIWebAPISettings): number {
    return settings.throttling.overlap;
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.connected = false;
    await super.disconnect();
    this.disconnecting = false;
  }

  /**
   * Get available points from the PI Web API data server
   * This can be used by the UI to allow users to select points
   * @param nameFilter - Optional name filter (supports * wildcard like PI queries)
   * @param maxPoints - Maximum number of points to return (default 1000)
   */
  async getAvailablePoints(nameFilter?: string, maxPoints = 1000): Promise<Array<AvailablePoint>> {
    const fetchOptions = this.createHttpOptions('GET');
    const requestUrl = new URL(
      `dataservers/${this.connector.settings.dataServerWebId}/points`,
      this.ensureUrlEndsWithSlash(this.connector.settings.url)
    );

    // Add name filter if provided (PI Web API supports wildcards)
    if (nameFilter) {
      requestUrl.searchParams.set('nameFilter', nameFilter);
    }

    // Set max count to avoid overwhelming responses
    requestUrl.searchParams.set('maxCount', maxPoints.toString());

    const response = await HTTPRequest(requestUrl, fetchOptions);

    if (!response.ok) {
      const errorText = await response.body.text();
      throw new Error(`Failed to get PI Web API points with status ${response.statusCode}: ${errorText}`);
    }

    const data = (await response.body.json()) as PIWebAPIPointsResponse;

    // Convert PI Web API points to generic AvailablePoint format
    return data.Items.map(point => ({
      id: point.WebId,
      name: point.Name,
      description: point.Descriptor || point.Path,
      webId: point.WebId,
      pointClass: point.PointClass,
      pointType: point.PointType,
      path: point.Path,
      engineeringUnits: point.EngineeringUnits
    }));
  }
}
