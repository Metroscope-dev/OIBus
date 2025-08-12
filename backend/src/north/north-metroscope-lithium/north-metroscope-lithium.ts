import * as fs from 'node:fs/promises';

import NorthConnector from '../north-connector';
import pino from 'pino';
import EncryptionService from '../../service/encryption.service';
import { NorthMetroscopeLithiumSettings } from '../../../shared/model/north-settings.model';
import { CacheMetadata, OIBusTimeValue } from '../../../shared/model/engine.model';
import { NorthConnectorEntity } from '../../model/north-connector.model';
import NorthConnectorRepository from '../../repository/config/north-connector.repository';
import ScanModeRepository from '../../repository/config/scan-mode.repository';
import { BaseFolders } from '../../model/types';
import { OIBusError } from '../../model/engine.model';
import { HTTPRequest, ReqResponse, retryableHttpStatusCodes } from '../../service/http-request.utils';

/**
 * Interface for sensor values in the Metroscope Lithium API
 */
interface SensorValue {
  sensorTag: string;
  mean: number;
  std?: number;
}

/**
 * Interface for snapshot in the Metroscope Lithium API
 */
interface Snapshot {
  date: string;
  acquisitionStartDate: string;
  acquisitionEndDate: string;
  group: string;
  label: string;
  sensorValues: Array<SensorValue>;
}

/**
 * Interface for the Metroscope Lithium API payload
 */
interface MetroscopeLithiumPayload {
  sourceId: string;
  snapshots: Array<Snapshot>;
}

/**
 * Class NorthMetroscopeLithium - send values to Metroscope Lithium API via PATCH request
 */
export default class NorthMetroscopeLithium extends NorthConnector<NorthMetroscopeLithiumSettings> {
  constructor(
    configuration: NorthConnectorEntity<NorthMetroscopeLithiumSettings>,
    encryptionService: EncryptionService,
    northConnectorRepository: NorthConnectorRepository,
    scanModeRepository: ScanModeRepository,
    logger: pino.Logger,
    baseFolders: BaseFolders
  ) {
    super(configuration, encryptionService, northConnectorRepository, scanModeRepository, logger, baseFolders);
  }

  async handleContent(cacheMetadata: CacheMetadata): Promise<void> {
    switch (cacheMetadata.contentType) {
      case 'time-values':
        return this.handleValues(JSON.parse(await fs.readFile(cacheMetadata.contentFile, { encoding: 'utf-8' })) as Array<OIBusTimeValue>);

      case 'raw':
        throw new OIBusError('Metroscope Lithium connector only supports time values, not raw files', false);
    }
  }

  /**
   * Handle time values by sending them to Metroscope Lithium API
   */
  async handleValues(values: Array<OIBusTimeValue>): Promise<void> {
    if (values.length === 0) {
      this.logger.warn('No values to send to Metroscope Lithium');
      return;
    }

    // Group values by timestamp to create snapshots
    const snapshotMap = new Map<string, Map<string, number>>();

    for (const value of values) {
      const iso8601Timestamp = this.ensureISO8601Format(value.timestamp);
      const pointId = value.pointId;
      const numericValue = this.parseNumericValue(value.data.value);

      if (numericValue === null) {
        this.logger.warn(`Skipping non-numeric value for point ${pointId}: ${value.data.value}`);
        continue;
      }

      if (!snapshotMap.has(iso8601Timestamp)) {
        snapshotMap.set(iso8601Timestamp, new Map());
      }

      snapshotMap.get(iso8601Timestamp)!.set(pointId, numericValue);
    }

    // Convert grouped values to snapshots
    const snapshots: Array<Snapshot> = [];
    for (const [iso8601Timestamp, sensorValues] of snapshotMap.entries()) {
      const sensorValuesArray: Array<SensorValue> = [];

      for (const [sensorTag, value] of sensorValues.entries()) {
        sensorValuesArray.push({
          sensorTag,
          mean: value
        });
      }

      snapshots.push({
        date: iso8601Timestamp,
        acquisitionStartDate: iso8601Timestamp,
        acquisitionEndDate: iso8601Timestamp,
        group: this.connector.settings.group,
        label: this.connector.settings.label || '',
        sensorValues: sensorValuesArray
      });
    }

    const payload: MetroscopeLithiumPayload = {
      sourceId: this.connector.settings.sourceId,
      snapshots
    };

    await this.sendToMetroscope(payload);
  }

  /**
   * Send payload to Metroscope Lithium API
   */
  private async sendToMetroscope(payload: MetroscopeLithiumPayload): Promise<void> {
    // Decrypt the API key since it's encrypted
    const decryptedApiKey = await this.encryptionService.decryptText(this.connector.settings.apiKey);

    if (!decryptedApiKey || decryptedApiKey.trim() === '') {
      throw new OIBusError('API key is required for Metroscope Lithium connector', false);
    }

    const endpoint = new URL(this.connector.settings.endpoint);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      APIKEY: decryptedApiKey
    };

    // Debug logging - log the request details
    this.logger.debug(`Sending PATCH request to Metroscope Lithium:
  Endpoint: ${endpoint.toString()}
  Headers: ${JSON.stringify({ ...headers, APIKEY: '[REDACTED]' }, null, 2)}
  Payload size: ${payload.snapshots.length} snapshots
  Payload preview: ${JSON.stringify(
    {
      sourceId: payload.sourceId,
      snapshotCount: payload.snapshots.length,
      firstSnapshot: payload.snapshots[0] || null,
      lastSnapshot: payload.snapshots[payload.snapshots.length - 1] || null
    },
    null,
    2
  )}`);

    // Optionally log full payload (warning: can be large!)
    if (this.logger.level === 'trace') {
      this.logger.trace(`Full payload being sent: ${JSON.stringify(payload, null, 2)}`);
    }

    let response: ReqResponse;
    try {
      const startTime = Date.now();
      response = await HTTPRequest(endpoint, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload),
        timeout: this.connector.settings.timeout * 1000
      });
      const duration = Date.now() - startTime;

      this.logger.debug(`PATCH request completed in ${duration}ms with status ${response.statusCode}`);
      this.logger.debug(`PATCH response headers: ${JSON.stringify(response.headers, null, 2)}`);
    } catch (error) {
      const message = this.getMessageFromError(error);
      this.logger.error(`PATCH request failed: ${message}`);
      throw new OIBusError(`Failed to reach Metroscope Lithium endpoint ${endpoint}; ${message}`, true);
    }

    // Always log response details for debugging
    const responseText = await response.body.text();
    this.logger.info(`Metroscope PATCH Response:
  Status: ${response.statusCode}
  Content-Length: ${response.headers['content-length'] || 'unknown'}
  Content-Type: ${response.headers['content-type'] || 'unknown'}
  Response Body: ${responseText || '(empty)'}`);

    if (!response.ok) {
      this.logger.error(`PATCH request failed with status ${response.statusCode}: ${responseText}`);
      throw new OIBusError(
        `HTTP request failed with status code ${response.statusCode} and message: ${responseText}`,
        retryableHttpStatusCodes.includes(response.statusCode)
      );
    }

    // Log successful response
    this.logger.info(`Successfully sent ${payload.snapshots.length} snapshots to Metroscope Lithium`);
  }

  override async testConnection(): Promise<void> {
    // Decrypt the API key since it's encrypted during test
    const decryptedApiKey = await this.encryptionService.decryptText(this.connector.settings.apiKey);

    // Debug: Log the actual API key state
    this.logger.info(`Debug API Key info:
  - apiKey exists: ${!!this.connector.settings.apiKey}
  - apiKey type: ${typeof this.connector.settings.apiKey}
  - apiKey length (encrypted): ${this.connector.settings.apiKey?.length || 0}
  - apiKey length (decrypted): ${decryptedApiKey?.length || 0}
  - apiKey value (encrypted): "${this.connector.settings.apiKey}" (showing encrypted value for debugging)
  - apiKey value (decrypted): "${decryptedApiKey}" (showing decrypted value for debugging)`);

    if (!decryptedApiKey || decryptedApiKey.trim() === '') {
      throw new OIBusError('API key is required for Metroscope Lithium connector', false);
    }

    // Enable debug logging for this test
    this.logger.level = 'debug';

    // For testing, we'll send an empty payload to verify the API key and endpoint are valid
    const testPayload: MetroscopeLithiumPayload = {
      sourceId: this.connector.settings.sourceId,
      snapshots: []
    };

    const endpoint = new URL(this.connector.settings.endpoint);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      APIKEY: decryptedApiKey
    };

    // Debug logging for test connection
    this.logger.debug(`Testing connection to Metroscope Lithium:
  Endpoint: ${endpoint.toString()}
  Headers: ${JSON.stringify({ ...headers, APIKEY: '[REDACTED]' }, null, 2)}
  Test payload: ${JSON.stringify(testPayload, null, 2)}`);

    let response: ReqResponse;
    try {
      const startTime = Date.now();
      response = await HTTPRequest(endpoint, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(testPayload),
        timeout: this.connector.settings.timeout * 1000
      });
      const duration = Date.now() - startTime;

      this.logger.debug(`Test connection completed in ${duration}ms with status ${response.statusCode}`);
      this.logger.debug(`Test response headers: ${JSON.stringify(response.headers, null, 2)}`);
    } catch (error) {
      const message = this.getMessageFromError(error);
      this.logger.error(`Test connection failed: ${message}`);
      throw new OIBusError(`Failed to reach Metroscope Lithium endpoint ${endpoint}; ${message}`, false);
    }

    // Always log test response details for debugging
    const responseText = await response.body.text();
    this.logger.info(`Metroscope Test Connection Response:
  Status: ${response.statusCode}
  Content-Length: ${response.headers['content-length'] || 'unknown'}
  Content-Type: ${response.headers['content-type'] || 'unknown'}
  Response Body: ${responseText || '(empty)'}`);

    if (!response.ok) {
      this.logger.error(`Test connection failed with status ${response.statusCode}: ${responseText}`);
      throw new OIBusError(`HTTP request failed with status code ${response.statusCode} and message: ${responseText}`, false);
    }

    // Log successful test response
    this.logger.info('Test connection to Metroscope Lithium successful');
  }

  /**
   * Parse a value to number, returns null if not a valid number
   */
  private parseNumericValue(value: unknown): number | null {
    if (typeof value === 'number') {
      return isNaN(value) ? null : value;
    }

    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return isNaN(parsed) ? null : parsed;
    }

    return null;
  }

  /**
   * Debug helper: Enable verbose HTTP logging for debugging API calls
   * This will log detailed request/response information
   */
  enableVerboseHttpLogging(): void {
    this.logger.info('Verbose HTTP logging enabled for Metroscope Lithium connector');
    // You can set the logger level to 'debug' or 'trace' for more detailed logs
    // this.logger.level = 'debug'; // Uncomment this line for debug logs
    // this.logger.level = 'trace'; // Uncomment this line for trace logs (includes full payloads)
  }

  /**
   * Ensure timestamp is in ISO 8601 format
   * @param timestamp - The timestamp to validate and format
   * @returns ISO 8601 formatted timestamp
   */
  private ensureISO8601Format(timestamp: string): string {
    try {
      // Try to parse the timestamp as a Date
      const date = new Date(timestamp);

      // Check if the date is valid
      if (isNaN(date.getTime())) {
        throw new Error(`Invalid timestamp: ${timestamp}`);
      }

      // Return ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)
      return date.toISOString();
    } catch (error) {
      this.logger.error(`Failed to parse timestamp "${timestamp}": ${error}`);
      throw new OIBusError(`Invalid timestamp format: ${timestamp}. Expected ISO 8601 format.`, false);
    }
  }

  /**
   * Convert an unknown request error to a readable message
   */
  private getMessageFromError(error: unknown) {
    if (!(error instanceof Error)) {
      return String(JSON.stringify(error));
    }

    const errors: Array<Error> = error instanceof AggregateError ? error.errors : [error];

    const messages: Array<string> = [];

    for (const err of errors) {
      let code: string | number | undefined = undefined;
      let message: string | undefined = undefined;

      if (err.message) {
        message = `message: ${err.message}`;
      }

      if ('code' in err && err.code && (typeof err.code === 'string' || typeof err.code === 'number')) {
        code = `code: ${err.code}`;
      }

      if ([message, code].filter(Boolean).length) {
        messages.push([message, code].filter(Boolean).join(', '));
      }
    }

    return messages.join('; ');
  }
}
